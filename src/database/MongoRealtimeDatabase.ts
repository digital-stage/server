import { Db, MongoClient, ObjectId } from 'mongodb';
import { ITeckosProvider, ITeckosSocket } from 'teckos';
import debug from 'debug';
import * as EventEmitter from 'events';
import {
  CustomGroup,
  CustomGroupId,
  CustomStageMember,
  CustomStageMemberAudioProducer,
  CustomStageMemberAudioProducerId,
  CustomStageMemberId,
  CustomStageMemberOvTrack,
  CustomStageMemberOvTrackId,
  Device,
  DeviceId,
  GlobalAudioProducer,
  GlobalAudioProducerId,
  GlobalVideoProducer,
  GlobalVideoProducerId,
  Group,
  GroupId,
  InitialStagePackage,
  SoundCard,
  SoundCardId,
  Stage,
  StageId,
  StageMember,
  StageMemberAudioProducer,
  StageMemberAudioProducerId,
  StageMemberId,
  StageMemberOvTrack,
  StageMemberOvTrackId,
  StageMemberVideoProducer,
  StageMemberVideoProducerId,
  StagePackage,
  Track,
  TrackId,
  TrackPreset,
  TrackPresetId,
  User,
  UserId,
  ThreeDimensionAudioProperties,
  Router, RouterId,
} from '../types';
import {
  ServerDeviceEvents, ServerRouterEvents, ServerStageEvents, ServerUserEvents,
} from '../events';
import { IRealtimeDatabase } from './IRealtimeDatabase';
import { DEBUG_EVENTS, DEBUG_PAYLOAD } from '../env';

const d = debug('server:MongoRealtimeDatabase');

const trace = d.extend('trace');
const warn = d.extend('warn');
const err = d.extend('err');

enum Collections {
  ROUTERS = 'routers',

  USERS = 'users',

  DEVICES = 'devices',
  SOUND_CARDS = 'soundcards',
  TRACK_PRESETS = 'trackpresets',
  TRACKS = 'tracks',
  AUDIO_PRODUCERS = 'audioproducers',
  VIDEO_PRODUCERS = 'videoproducers',

  STAGES = 'stages',
  GROUPS = 'groups',
  CUSTOM_GROUPS = 'customgroup',
  STAGE_MEMBERS = 'stagemembers',
  CUSTOM_STAGE_MEMBERS = 'customstagemembers',
  STAGE_MEMBER_AUDIOS = 'stagememberaudios',
  STAGE_MEMBER_VIDEOS = 'stagemembervideos',
  STAGE_MEMBER_OVS = 'stagememberovs',
  CUSTOM_STAGE_MEMBER_AUDIOS = 'customstagememberaudios',
  CUSTOM_STAGE_MEMBER_OVS = 'customstagememberovs',
}

class MongoRealtimeDatabase extends EventEmitter.EventEmitter implements IRealtimeDatabase {
  private _mongoClient: MongoClient;

  private _db: Db;

  private readonly _io: ITeckosProvider;

  constructor(io: ITeckosProvider, url: string, certificate?: ReadonlyArray<Buffer | string>) {
    super();
    this._io = io;
    this._mongoClient = new MongoClient(url, {
      poolSize: 10,
      bufferMaxEntries: 0,
      useNewUrlParser: true,
      // useUnifiedTopology: true,
      sslValidate: !!certificate,
      sslCA: certificate,
    });
  }

  async cleanUp(serverAddress: string): Promise<void> {
    await Promise.all([
      this.readDevicesByServer(serverAddress)
        .then((devices) => devices.map((device) => this.deleteDevice(device._id).then(() => trace(`Clean up: Removed device ${device._id}`)))),
      this.readRoutersByServer(serverAddress)
        .then((routers) => routers.map((router) => this.deleteRouter(router._id).then(() => trace(`Clean up: Removed router ${router._id}`)))),
      this.cleanUpStages(),
    ]);
  }

  async cleanUpStages(): Promise<void> {
    this._db.collection<Stage>(Collections.STAGES).find({ ovServer: { $exists: true, $ne: null } })
      .toArray()
      .then((stages) => stages.map((stage) => this._db.collection<Router>(Collections.ROUTERS)
        .findOne({ _id: stage.ovServer.router })
        .then((result) => {
          if (!result) {
            trace(`Clean up: Removing abandoned ov server from stage ${stage._id}`);
            this.updateStage(stage._id, { ovServer: null });
          }
        })));
  }

  createRouter(initial: Omit<Router, '_id'>): Promise<Router> {
    return this._db.collection<Router>(Collections.ROUTERS).insertOne(initial)
      .then((result) => result.ops[0])
      .then((router: Router) => {
        this.emit(ServerRouterEvents.ROUTER_ADDED, router);
        return router;
      });
  }

  readRouter(id: ObjectId): Promise<Router | null> {
    return this._db.collection<Router>(Collections.ROUTERS).findOne({
      _id: id,
    });
  }

  readRouters(): Promise<Router[]> {
    return this._db.collection<Router>(Collections.ROUTERS).find().toArray();
  }

  readRoutersByServer(serverAddress: string): Promise<Router[]> {
    return this._db.collection<Router>(Collections.ROUTERS).find({
      server: serverAddress,
    }).toArray();
  }

  updateRouter(id: RouterId, update: Partial<Omit<Router, '_id'>>): Promise<void> {
    return this._db.collection<Router>(Collections.ROUTERS).findOneAndUpdate(
      { _id: id },
      { $set: update },
    )
      .then(() => {
        this.emit(ServerRouterEvents.ROUTER_CHANGED, {
          ...update,
          _id: id,
        });
      });
  }

  deleteRouter(id: ObjectId): Promise<void> {
    return this._db.collection<Router>(Collections.ROUTERS).deleteOne({ _id: id })
      .then((result) => {
        if (result.deletedCount > 0) {
          this.emit(ServerRouterEvents.ROUTER_REMOVED, id);
          this.readStagesByRouter(id)
            .then((stages) => stages.map(
              (stage) => this.updateStage(stage._id, { ovServer: null }),
            ));
        }
      });
  }

  db() {
    return this._db;
  }

  renewOnlineStatus(userId: UserId): Promise<void> {
    // Has the user online devices?
    return this._db.collection<User>(Collections.USERS).findOne(
      { _id: userId },
      { projection: { stageMemberId: 1 } },
    )
      .then((user) => {
        if (user.stageMemberId) {
          // Use is inside stage
          return this._db.collection<Device>(Collections.DEVICES).countDocuments({
            userId,
            online: true,
          })
            .then((numDevicesOnline) => {
              if (numDevicesOnline > 0) {
                // User is online
                return this.updateStageMember(user.stageMemberId, { online: true });
              }
              // User has no more online devices
              return this.updateStageMember(user.stageMemberId, { online: false });
            });
        }
        return null;
      });
  }

  createAudioProducer(initial: Omit<GlobalAudioProducer, '_id'>): Promise<GlobalAudioProducer> {
    return this._db.collection<GlobalAudioProducer>(Collections.AUDIO_PRODUCERS).insertOne(initial)
      .then((result) => result.ops[0])
      .then((producer) => {
        this.emit(ServerDeviceEvents.AUDIO_PRODUCER_ADDED, producer);

        this.sendToUser(initial.userId, ServerDeviceEvents.AUDIO_PRODUCER_ADDED, producer);
        // Publish producer?
        this.readUser(initial.userId)
          .then((user) => {
            if (user.stageMemberId) {
              return this.createStageMemberAudioProducer({
                stageMemberId: user.stageMemberId,
                globalProducerId: producer._id,
                volume: 1,
                muted: false,
                x: 0,
                y: 0,
                z: 0,
                rX: 0,
                rY: 0,
                rZ: 0,
                userId: user._id,
                stageId: user.stageId,
                online: true,
              });
            }
            throw new Error('User is not inside a stage');
          });
        return producer;
      });
  }

  readAudioProducer(id: GlobalAudioProducerId): Promise<GlobalAudioProducer> {
    return this._db.collection<GlobalAudioProducer>(Collections.AUDIO_PRODUCERS).findOne({
      _id: id,
    });
  }

  updateAudioProducer(deviceId: StageMemberId, id: GlobalAudioProducerId, update: Partial<Omit<GlobalAudioProducer, '_id'>>): Promise<void> {
    return this._db.collection<GlobalAudioProducer>(Collections.AUDIO_PRODUCERS).findOneAndUpdate({
      _id: id,
      deviceId,
    }, {
      $set: update,
    }, { projection: { userId: 1 } })
      .then((result) => {
        if (result.value) {
          const payload = {
            ...update,
            _id: id,
          };
          this.emit(ServerDeviceEvents.AUDIO_PRODUCER_CHANGED, payload);
          this.sendToUser(result.value.userId, ServerDeviceEvents.AUDIO_PRODUCER_CHANGED, payload);
        }
      });
  }

  deleteAudioProducer(userId: UserId, id: GlobalAudioProducerId): Promise<void> {
    return this._db.collection<GlobalAudioProducer>(Collections.AUDIO_PRODUCERS).findOneAndDelete({
      userId,
      _id: id,
    }, { projection: { userId: 1 } })
      .then((result) => {
        if (result.value) {
          this.emit(ServerDeviceEvents.AUDIO_PRODUCER_REMOVED, id);
          this.sendToUser(result.value.userId, ServerDeviceEvents.AUDIO_PRODUCER_REMOVED, id);
          // Also delete all published producers
          this._db.collection<StageMemberAudioProducer>(Collections.STAGE_MEMBER_AUDIOS).find({
            globalProducerId: id,
          }, { projection: { _id: 1 } })
            .toArray()
            .then((globalProducers) => globalProducers
              .map((globalProducer) => this.deleteStageMemberAudioProducer(globalProducer._id)));
        }
      });
  }

  createVideoProducer(initial: Omit<GlobalVideoProducer, '_id'>): Promise<GlobalVideoProducer> {
    return this._db.collection<GlobalVideoProducer>(Collections.VIDEO_PRODUCERS).insertOne(initial)
      .then((result) => result.ops[0])
      .then((producer) => {
        this.emit(ServerDeviceEvents.VIDEO_PRODUCER_ADDED, producer);
        this.sendToUser(initial.userId, ServerDeviceEvents.VIDEO_PRODUCER_ADDED, producer);
        // Publish producer?
        this.readUser(initial.userId)
          .then((user) => {
            if (user.stageMemberId) {
              return this.createStageMemberVideoProducer({
                stageMemberId: user.stageMemberId,
                globalProducerId: producer._id,
                userId: user._id,
                stageId: user.stageId,
                online: true,
              });
            }
            return null;
          });
        return producer;
      });
  }

  readVideoProducer(id: GlobalVideoProducerId): Promise<GlobalVideoProducer> {
    return this._db.collection<GlobalVideoProducer>(Collections.VIDEO_PRODUCERS).findOne({
      _id: id,
    }).then((result) => result);
  }

  updateVideoProducer(deviceId: DeviceId, id: GlobalVideoProducerId, update: Partial<Omit<GlobalVideoProducer, '_id'>>): Promise<void> {
    return this._db.collection<GlobalVideoProducer>(Collections.VIDEO_PRODUCERS).findOneAndUpdate({
      _id: id,
      deviceId,
    }, {
      $set: update,
    }, { projection: { userId: 1 } })
      .then((result) => {
        if (result.value) {
          const payload = {
            ...update,
            _id: id,
          };
          this.emit(ServerDeviceEvents.VIDEO_PRODUCER_CHANGED, payload);
          this.sendToUser(result.value.userId, ServerDeviceEvents.VIDEO_PRODUCER_CHANGED, payload);
        }
      });
  }

  deleteVideoProducer(userId: UserId, id: GlobalVideoProducerId): Promise<void> {
    return this._db.collection<GlobalVideoProducer>(Collections.VIDEO_PRODUCERS).findOneAndDelete({
      userId,
      _id: id,
    }, { projection: { userId: 1 } })
      .then((result) => {
        if (result.value) {
          this.emit(ServerDeviceEvents.VIDEO_PRODUCER_REMOVED, id);
          this.sendToUser(result.value.userId, ServerDeviceEvents.VIDEO_PRODUCER_REMOVED, id);
          // Also delete all published producers
          this._db.collection<StageMemberVideoProducer>(Collections.STAGE_MEMBER_VIDEOS).find({
            globalProducerId: id,
          }, { projection: { _id: 1 } })
            .toArray()
            .then((globalProducers) => globalProducers
              .map((globalProducer) => this.deleteStageMemberVideoProducer(globalProducer._id)));
        }
      });
  }

  createStageMemberOvTrack(initial: Omit<StageMemberOvTrack, '_id'>): Promise<StageMemberOvTrack> {
    return this._db.collection<StageMemberOvTrack>(Collections.STAGE_MEMBER_OVS).insertOne(initial)
      .then((result) => result.ops[0])
      .then(async (track) => {
        this.emit(ServerStageEvents.STAGE_MEMBER_OV_ADDED, track);
        await this.sendToJoinedStageMembers(
          initial.stageId,
          ServerStageEvents.STAGE_MEMBER_OV_ADDED, track,
        );
        return track;
      });
  }

  readStageMemberOvTrack(id: StageMemberOvTrackId): Promise<StageMemberOvTrack> {
    return this._db.collection<StageMemberOvTrack>(Collections.STAGE_MEMBER_OVS).findOne({
      _id: id,
    });
  }

  updateStageMemberOvTrack(id: StageMemberOvTrackId, update: Partial<Omit<StageMemberOvTrack, '_id'>>): Promise<void> {
    return this._db.collection<StageMemberOvTrack>(Collections.STAGE_MEMBER_OVS).findOneAndUpdate({
      _id: id,
    }, {
      $set: update,
    }, { projection: { stageId: 1 } })
      .then(async (result) => {
        if (result.value) {
          const payload = {
            ...update,
            _id: id,
          };
          this.emit(ServerStageEvents.STAGE_MEMBER_OV_CHANGED, payload);
          await this.sendToJoinedStageMembers(
            result.value.stageId,
            ServerStageEvents.STAGE_MEMBER_OV_CHANGED,
            payload,
          );
        }
      });
  }

  deleteStageMemberOvTrack(id: StageMemberOvTrackId): Promise<void> {
    return this._db.collection<StageMemberOvTrack>(Collections.STAGE_MEMBER_OVS).findOneAndDelete({
      _id: id,
    })
      .then(async (result) => {
        if (result.value) {
          this.emit(ServerStageEvents.STAGE_MEMBER_OV_REMOVED, result.value._id);
          await this.sendToJoinedStageMembers(
            result.value.stageId,
            ServerStageEvents.STAGE_MEMBER_OV_REMOVED,
            result.value._id,
          );
        }
      });
  }

  createStageMemberAudioProducer(initial: Omit<StageMemberAudioProducer, '_id'>): Promise<StageMemberAudioProducer> {
    return this._db.collection<StageMemberAudioProducer>(Collections.STAGE_MEMBER_AUDIOS)
      .insertOne(initial)
      .then((result) => result.ops[0])
      .then(async (producer) => {
        this.emit(ServerStageEvents.STAGE_MEMBER_AUDIO_ADDED, producer);
        await this.sendToJoinedStageMembers(
          initial.stageId,
          ServerStageEvents.STAGE_MEMBER_AUDIO_ADDED,
          producer,
        );
        return producer;
      });
  }

  readStageMemberAudioProducer(id: StageMemberAudioProducerId): Promise<StageMemberAudioProducer> {
    return this._db.collection<StageMemberAudioProducer>(Collections.STAGE_MEMBER_AUDIOS).findOne({
      _id: id,
    });
  }

  updateStageMemberAudioProducer(id: StageMemberAudioProducerId, update: Partial<Omit<StageMemberAudioProducer, '_id'>>): Promise<void> {
    return this._db.collection<StageMemberAudioProducer>(Collections.STAGE_MEMBER_AUDIOS)
      .findOneAndUpdate({
        _id: id,
      }, {
        $set: update,
      }, { projection: { stageId: 1 } })
      .then(async (result) => {
        if (result.value) {
          const payload = {
            ...update,
            _id: id,
          };
          this.emit(ServerStageEvents.STAGE_MEMBER_AUDIO_CHANGED, payload);
          await this.sendToJoinedStageMembers(
            result.value.stageId,
            ServerStageEvents.STAGE_MEMBER_AUDIO_CHANGED,
            payload,
          );
        }
      });
  }

  deleteStageMemberAudioProducer(id: StageMemberAudioProducerId): Promise<void> {
    return this._db.collection<StageMemberAudioProducer>(Collections.STAGE_MEMBER_AUDIOS)
      .findOneAndDelete({
        _id: id,
      }, { projection: { stageId: 1 } })
      .then(async (result) => {
        if (result.value) {
          this.emit(ServerStageEvents.STAGE_MEMBER_AUDIO_REMOVED, id);
          await this.sendToJoinedStageMembers(
            result.value.stageId,
            ServerStageEvents.STAGE_MEMBER_AUDIO_REMOVED, id,
          );
        }
      });
  }

  createStageMemberVideoProducer(initial: Omit<StageMemberVideoProducer, '_id'>): Promise<StageMemberVideoProducer> {
    return this._db.collection<StageMemberVideoProducer>(Collections.STAGE_MEMBER_VIDEOS)
      .insertOne(initial)
      .then((result) => result.ops[0])
      .then(async (producer) => {
        this.emit(ServerStageEvents.STAGE_MEMBER_VIDEO_ADDED, producer);
        await this.sendToJoinedStageMembers(
          initial.stageId,
          ServerStageEvents.STAGE_MEMBER_VIDEO_ADDED,
          producer,
        );
        return producer;
      });
  }

  readStageMemberVideoProducer(id: StageMemberVideoProducerId): Promise<StageMemberVideoProducer> {
    return this._db.collection<StageMemberVideoProducer>(Collections.STAGE_MEMBER_VIDEOS)
      .findOne({
        _id: id,
      });
  }

  updateStageMemberVideoProducer(id: StageMemberVideoProducerId, update: Partial<Omit<StageMemberVideoProducer, '_id'>>): Promise<void> {
    return this._db.collection<StageMemberVideoProducer>(Collections.STAGE_MEMBER_VIDEOS)
      .findOneAndUpdate({
        _id: id,
      }, {
        $set: update,
      }, { projection: { stageId: 1 } })
      .then(async (result) => {
        if (result.value) {
          const payload = {
            ...update,
            _id: id,
          };
          this.emit(ServerStageEvents.STAGE_MEMBER_VIDEO_CHANGED, payload);
          await this.sendToJoinedStageMembers(
            result.value.stageId,
            ServerStageEvents.STAGE_MEMBER_VIDEO_CHANGED,
            payload,
          );
        }
      });
  }

  deleteStageMemberVideoProducer(id: StageMemberVideoProducerId): Promise<void> {
    return this._db.collection<StageMemberVideoProducer>(Collections.STAGE_MEMBER_VIDEOS)
      .findOneAndDelete({
        _id: id,
      }, { projection: { stageId: 1 } })
      .then(async (result) => {
        if (result.value) {
          this.emit(ServerStageEvents.STAGE_MEMBER_VIDEO_REMOVED, id);
          await this.sendToJoinedStageMembers(
            result.value.stageId,
            ServerStageEvents.STAGE_MEMBER_VIDEO_REMOVED,
            id,
          );
        }
      });
  }

  async connect(database: string): Promise<void> {
    if (this._mongoClient.isConnected()) {
      warn('Reconnecting');
      await this.disconnect();
    }
    this._mongoClient = await this._mongoClient.connect();
    this._db = this._mongoClient.db(database);
    if (this._mongoClient.isConnected()) {
      d(`Connected to ${database}`);
    }
    // TODO: Clean up old devices etc.
  }

  disconnect() {
    return this._mongoClient.close();
  }

  createUser(initial: Omit<User, '_id' | 'stageId' | 'stageMemberId'>): Promise<User> {
    return this._db.collection<User>(Collections.USERS).insertOne(initial)
      .then((result) => result.ops[0])
      .then((user) => {
        this.emit(ServerUserEvents.USER_ADDED, user);
        return user;
      });
  }

  readUser(id: UserId): Promise<User | null> {
    return this._db.collection<User>(Collections.USERS).findOne({ _id: id });
  }

  readUserByUid(uid: string): Promise<User | null> {
    return this._db.collection<User>(Collections.USERS).findOne({ uid });
  }

  updateUser(id: UserId, update: Partial<Omit<User, '_id'>>): Promise<void> {
    return this._db.collection<User>(Collections.USERS).updateOne({ _id: id }, { $set: update })
      .then(() => {
        // TODO: Update all associated (Stage Members), too
        const payload = {
          ...update,
          _id: id,
        };
        this.emit(ServerUserEvents.USER_CHANGED, payload);
        this.sendToUser(id, ServerUserEvents.USER_CHANGED, payload);
      });
  }

  deleteUser(id: UserId): Promise<void> {
    return this._db.collection<User>(Collections.USERS).deleteOne({ _id: id })
      .then((result) => {
        if (result.deletedCount > 0) {
          this.emit(ServerUserEvents.USER_REMOVED, id);
          this._db.collection<Stage>(Collections.STAGES)
            .find({ admins: [id] }, { projection: { _id: 1 } })
            .toArray()
            .then((stages) => stages
              .map((stage) => this.deleteStage(stage._id)));

          this._db.collection<StageMember>(Collections.STAGE_MEMBERS)
            .find({ userId: id }, { projection: { _id: 1 } })
            .toArray()
            .then((stageMembers) => stageMembers
              .map((stageMember) => this.deleteStageMember(stageMember._id)));

          this._db.collection<GlobalAudioProducer>(Collections.AUDIO_PRODUCERS)
            .find({ userId: id }, { projection: { _id: 1 } })
            .toArray()
            .then((producers) => producers
              .map((producer) => this.deleteAudioProducer(id, producer._id)));

          this._db.collection<GlobalVideoProducer>(Collections.VIDEO_PRODUCERS)
            .find({ userId: id }, { projection: { _id: 1 } })
            .toArray()
            .then((producers) => producers
              .map((producer) => this.deleteVideoProducer(id, producer._id)));

          this._db.collection<SoundCard>(Collections.SOUND_CARDS)
            .find({ userId: id }, { projection: { _id: 1 } })
            .toArray()
            .then((soundCards) => soundCards
              .map((soundCard) => this.deleteSoundCard(id, soundCard._id)));
        }
      });
  }

  createDevice(init: Omit<Device, '_id'>): Promise<Device> {
    return this._db.collection(Collections.DEVICES).insertOne(init)
      .then((result) => result.ops[0])
      .then(async (device) => {
        this.emit(ServerDeviceEvents.DEVICE_ADDED, device);
        this.sendToUser(init.userId, ServerDeviceEvents.DEVICE_ADDED, device);
        await this.renewOnlineStatus(init.userId);
        return device;
      });
  }

  readDevicesByUser(userId: UserId): Promise<Device[]> {
    return this._db.collection<Device>(Collections.DEVICES).find({ userId }).toArray();
  }

  readDeviceByUserAndMac(userId: UserId, mac: string): Promise<Device | null> {
    return this._db.collection<Device>(Collections.DEVICES).findOne({ userId, mac });
  }

  readDevice(id: DeviceId): Promise<Device | null> {
    return this._db.collection<Device>(Collections.DEVICES).findOne({ _id: id });
  }

  readDevicesByServer(server: string): Promise<Device[]> {
    return this._db.collection<Device>(Collections.DEVICES).find({ server }).toArray();
  }

  updateDevice(userId: UserId, id: DeviceId, update: Partial<Omit<Device, '_id'>>): Promise<void> {
    // Update first ;)
    const payload = {
      ...update,
      user: userId,
      _id: id,
    };
    this.emit(ServerDeviceEvents.DEVICE_CHANGED, payload);
    this.sendToUser(userId, ServerDeviceEvents.DEVICE_CHANGED, payload);
    return this._db.collection<Device>(Collections.DEVICES).updateOne({ _id: id }, { $set: update })
      .then((result) => {
        if (result.modifiedCount > 0) {
          return this.renewOnlineStatus(userId);
        }
        /*
        return this.readDevice(id)
          .then((device) => console.log(device));
        */
        return null;
      });
  }

  deleteDevice(id: DeviceId): Promise<void> {
    return this._db.collection<Device>(Collections.DEVICES)
      .findOneAndDelete({ _id: id }, { projection: { userId: 1 } })
      .then((result) => {
        if (result.value) {
          this.emit(ServerDeviceEvents.DEVICE_REMOVED, id);
          this.sendToUser(result.value.userId, ServerDeviceEvents.DEVICE_REMOVED, id);

          // Delete associated producers
          this._db.collection<GlobalVideoProducer>(Collections.VIDEO_PRODUCERS).find({
            deviceId: id,
          }, { projection: { _id: 1, userId: 1 } })
            .toArray()
            .then((producers) => producers
              .map((producer) => this.deleteVideoProducer(producer.userId, producer._id)));

          this._db.collection<GlobalAudioProducer>(Collections.AUDIO_PRODUCERS).find({
            deviceId: id,
          }, { projection: { _id: 1, userId: 1 } })
            .toArray()
            .then((producers) => producers
              .map((producer) => this.deleteAudioProducer(producer.userId, producer._id)));

          return this.renewOnlineStatus(result.value.userId);
        }
        return null;
      });
  }

  createStage(init: Partial<Omit<Stage, '_id'>>): Promise<Stage> {
    const stage: Omit<Stage, '_id'> = {
      name: '',
      password: '',
      width: 13,
      length: 25,
      height: 7.5,
      absorption: 0.6,
      damping: 0.7,
      admins: [],
      ...init,
    };
    return this._db.collection<Stage>(Collections.STAGES).insertOne(stage)
      .then((result) => {
        this.emit(ServerStageEvents.STAGE_ADDED, stage);
        stage.admins
          .forEach((adminId) => this.sendToUser(adminId, ServerStageEvents.STAGE_ADDED, stage));
        return result.ops[0];
      });
  }

  async joinStage(userId: UserId, stageId: StageId, groupId: GroupId, password?: string)
    : Promise<void> {
    const startTime = Date.now();

    const user: User = await this.readUser(userId);
    const stage: Stage = await this.readStage(stageId);

    if (stage.password && stage.password !== password) {
      throw new Error('Invalid password');
    }

    const isAdmin: boolean = stage.admins.find((admin) => admin.equals(userId)) !== undefined;
    const previousStageMemberId = user.stageMemberId;

    let stageMember = await this._db.collection<StageMember>(Collections.STAGE_MEMBERS).findOne({
      userId: user._id,
      stageId: stage._id,
    });
    const wasUserAlreadyInStage = stageMember !== null;
    if (!stageMember) {
      // Create stage member
      stageMember = await this.createStageMember({
        userId: user._id,
        stageId: stage._id,
        groupId,
        online: true,
        isDirector: false,
        volume: 1,
        muted: false,
        x: 0,
        y: -1,
        z: 0,
        rX: 0,
        rY: 0,
        rZ: -180,
      });
      // Also create a custom stage member for the same user and mute it per default
      await this.setCustomStageMember(userId, stageMember._id, {
        muted: true,
        volume: 0,
        x: 0,
        y: -1,
        z: 0,
        rX: 0,
        rY: 0,
        rZ: -180,
      });
    } else if (!stageMember.groupId.equals(groupId) || !stageMember.online) {
      // Update stage member
      stageMember.online = true;
      stageMember.groupId = groupId;
      await this.updateStageMember(stageMember._id, {
        groupId,
        online: true,
      });
      // Always mute the custom stage member
      await this.setCustomStageMember(userId, stageMember._id, {
        muted: true,
        volume: 0,
        x: 0,
        y: -1,
        z: 0,
        rX: 0,
        rY: 0,
        rZ: -180,
      });
    }

    // Update user
    if (!previousStageMemberId || !previousStageMemberId.equals(stageMember._id)) {
      user.stageId = stage._id;
      user.stageMemberId = stageMember._id;
      await this.updateUser(user._id, {
        stageId: stage._id,
        stageMemberId: stageMember._id,
      });
      this.emit(ServerStageEvents.STAGE_LEFT, user._id);
      this.sendToUser(user._id, ServerStageEvents.STAGE_LEFT);
    }

    // Send whole stage
    await this.getWholeStage(user._id, stage._id, isAdmin || wasUserAlreadyInStage)
      .then((wholeStage) => {
        this.emit(ServerStageEvents.STAGE_JOINED, {
          ...wholeStage,
          stageId: stage._id,
          groupId,
          user: user._id,
        });
        this.sendToUser(user._id, ServerStageEvents.STAGE_JOINED, {
          ...wholeStage,
          stageId: stage._id,
          groupId,
        });
      });

    if (!previousStageMemberId || !previousStageMemberId.equals(stageMember._id)) {
      if (previousStageMemberId) {
        // Set old stage member offline (async!)
        await this.updateStageMember(previousStageMemberId, { online: false });
        // Set old stage member tracks offline (async!)
        // Remove stage member related audio and video
        this._db.collection<StageMemberAudioProducer>(Collections.STAGE_MEMBER_AUDIOS).find({
          stageMemberId: previousStageMemberId,
        })
          .toArray()
          .then((producers) => producers
            .map((producer) => this.deleteStageMemberAudioProducer(producer._id)));

        this._db.collection<StageMemberVideoProducer>(Collections.STAGE_MEMBER_VIDEOS).find({
          stageMemberId: previousStageMemberId,
        })
          .toArray()
          .then((producers) => producers
            .map((producer) => this.deleteStageMemberVideoProducer(producer._id)));

        await this._db.collection<StageMemberAudioProducer>(Collections.STAGE_MEMBER_OVS).find({
          stageMemberId: previousStageMemberId,
        })
          .toArray()
          .then((tracks) => tracks
            .map((track) => this.updateStageMemberOvTrack(track._id, {
              online: false,
            })));
      }

      // Create stage related audio and video producers
      this._db.collection<GlobalVideoProducer>(Collections.VIDEO_PRODUCERS)
        .find({ userId }, { projection: { _id: 1 } })
        .toArray()
        .then((producers) => producers.map((producer) => this.createStageMemberVideoProducer({
          stageMemberId: user.stageMemberId,
          globalProducerId: producer._id,
          userId: user._id,
          stageId: user.stageId,
          online: true,
        })));

      this._db.collection<GlobalAudioProducer>(Collections.AUDIO_PRODUCERS)
        .find({ userId }, { projection: { _id: 1 } })
        .toArray()
        .then((producers) => producers.map((producer) => this.createStageMemberAudioProducer({
          stageMemberId: user.stageMemberId,
          globalProducerId: producer._id,
          userId: user._id,
          stageId: user.stageId,
          online: true,
          volume: 1,
          muted: false,
          x: 0,
          y: 0,
          z: 0,
          rX: 0,
          rY: 0,
          rZ: 0,
        })));

      this._db.collection<Track>(Collections.TRACKS)
        .find({ userId }, { projection: { _id: 1 } })
        .toArray()
        .then((tracks) => tracks.map((track) => this.createStageMemberOvTrack({
          trackPresetId: track.trackPresetId,
          channel: track.channel,
          stageMemberId: user.stageMemberId,
          trackId: track._id,
          userId: user._id,
          stageId: user.stageId,
          online: true,
          gain: 1,
          volume: 1,
          muted: false,
          directivity: 'omni',
          x: 0,
          y: 0,
          z: 0,
          rX: 0,
          rY: 0,
          rZ: 0,
        })));
    }

    d(`joinStage: ${Date.now() - startTime}ms`);
  }

  async leaveStage(userId: UserId): Promise<any> {
    const startTime = Date.now();
    const user: User = await this.readUser(userId);

    if (user.stageId) {
      const previousStageMemberId = user.stageMemberId;

      // Leave the user <-> stage member connection
      user.stageId = undefined;
      user.stageMemberId = undefined;
      await this.updateUser(user._id, { stageId: undefined, stageMemberId: undefined });
      this.emit(ServerStageEvents.STAGE_LEFT, user._id);
      this.sendToUser(user._id, ServerStageEvents.STAGE_LEFT);

      // Set old stage member offline (async!)
      await this.updateStageMember(previousStageMemberId, { online: false });

      // Remove old stage member related video and audio
      this._db.collection<StageMemberAudioProducer>(Collections.STAGE_MEMBER_AUDIOS).find({
        stageMemberId: previousStageMemberId,
      })
        .toArray()
        .then((producers) => producers
          .map((producer) => this.deleteStageMemberAudioProducer(producer._id)));
      this._db.collection<StageMemberVideoProducer>(Collections.STAGE_MEMBER_VIDEOS).find({
        stageMemberId: previousStageMemberId,
      })
        .toArray()
        .then((producers) => producers
          .map((producer) => this.deleteStageMemberVideoProducer(producer._id)));

      // Set old stage related tracks offline
      this._db.collection<StageMemberAudioProducer>(Collections.STAGE_MEMBER_OVS).find({
        stageMemberId: previousStageMemberId,
      })
        .toArray()
        .then((tracks) => tracks
          .map((track) => this.updateStageMemberOvTrack(track._id, {
            online: false,
          })));
    }
    d(`leaveStage: ${Date.now() - startTime}ms`);
  }

  leaveStageForGood(userId: UserId, stageId: StageId): Promise<any> {
    // TODO: Log out user if he's joined

    // Delete stage member
    return this._db.collection<StageMember>(Collections.STAGE_MEMBERS).findOne({
      userId,
      stageId,
    }, {
      projection: { _id: 1 },
    }).then(
      (stageMember) => {
        if (stageMember) {
          return this.deleteStageMember(stageMember._id)
            .then(() => this._db.collection<Group>(Collections.GROUPS).find({
              stageId,
            }, {
              projection: { _id: 1 },
            })
              .toArray()
              .then((groups) => groups
                .map((group) => this.sendToUser(
                  userId,
                  ServerStageEvents.GROUP_REMOVED,
                  group._id,
                )))
              .then(() => this.sendToUser(userId, ServerStageEvents.STAGE_REMOVED, stageId)));
        }
        return null;
      },
    );
  }

  readStage(id: StageId): Promise<Stage> {
    return this._db.collection<Stage>(Collections.STAGES).findOne({ _id: id });
  }

  readStagesByRouter(routerId: RouterId): Promise<Stage[]> {
    return this._db.collection<Stage>(Collections.STAGES)
      .find({ 'ovServer.router': routerId })
      .toArray();
  }

  readStagesWithoutRouter(limit?: number): Promise<Stage[]> {
    if (limit) {
      return this._db.collection<Stage>(Collections.STAGES)
        .find({ ovServer: null })
        .limit(limit)
        .toArray();
    }
    return this._db.collection<Stage>(Collections.STAGES).find({ ovServer: null }).toArray();
  }

  readManagedStage(userId: UserId, id: StageId): Promise<Stage> {
    return this._db.collection<Stage>(Collections.STAGES).findOne({
      _id: id,
      admins: userId,
    });
  }

  readManagedStageByGroupId(userId: UserId, id: GroupId): Promise<Stage> {
    return this._db.collection<Group>(Collections.GROUPS).findOne({
      _id: id,
      admins: userId,
    }).then((group) => {
      if (group) {
        return this.readManagedStage(userId, group.stageId);
      }
      return null;
    });
  }

  private async getWholeStage(userId: UserId, stageId: StageId, skipStageAndGroups: boolean = false)
    : Promise<StagePackage> {
    const stage = await this._db.collection<Stage>(Collections.STAGES).findOne({ _id: stageId });
    const groups = await this._db.collection<Group>(Collections.GROUPS).find({ stageId }).toArray();
    const stageMembers = await this._db.collection<StageMember>(Collections.STAGE_MEMBERS)
      .find({ stageId })
      .toArray();
    const stageMemberUserIds = stageMembers.map((stageMember) => stageMember.userId);
    const users = await this._db.collection<User>(Collections.USERS)
      .find({ _id: { $in: stageMemberUserIds } })
      .toArray();
    const customGroups = await this._db.collection<CustomGroup>(Collections.CUSTOM_GROUPS).find({
      userId,
      groupId: { $in: groups.map((group) => group._id) },
    }).toArray();

    const customStageMembers: CustomStageMember[] = await this._db
      .collection<CustomStageMember>(Collections.CUSTOM_STAGE_MEMBERS)
      .find({
        userId,
        stageMemberId: { $in: stageMembers.map((stageMember) => stageMember._id) },
      })
      .toArray();
    const videoProducers: StageMemberVideoProducer[] = await this._db
      .collection<StageMemberVideoProducer>(Collections.STAGE_MEMBER_VIDEOS).find({
      stageId,
    }).toArray();
    const audioProducers: StageMemberAudioProducer[] = await this._db
      .collection<StageMemberAudioProducer>(Collections.STAGE_MEMBER_AUDIOS).find({
      stageId,
    }).toArray();
    const customAudioProducers: CustomStageMemberAudioProducer[] = await this._db
      .collection<CustomStageMemberAudioProducer>(Collections.CUSTOM_STAGE_MEMBER_AUDIOS)
      .find({
        userId,
        stageMemberAudioProducerId: {
          $in: audioProducers
            .map((audioProducer) => audioProducer._id),
        },
      }).toArray();
    const ovTracks: StageMemberOvTrack[] = await this._db
      .collection<StageMemberOvTrack>(Collections.TRACKS)
      .find({
        stageId,
      }).toArray();
    const customOvTracks: CustomStageMemberOvTrack[] = await this._db
      .collection<CustomStageMemberOvTrack>(Collections.CUSTOM_STAGE_MEMBER_OVS)
      .find({
        userId,
        stageMemberOvTrackId: { $in: ovTracks.map((ovTrack) => ovTrack._id) },
      }).toArray();

    if (skipStageAndGroups) {
      return {
        users,
        stageMembers,
        customGroups,
        customStageMembers,
        videoProducers,
        audioProducers,
        customAudioProducers,
        ovTracks,
        customOvTracks,
      };
    }
    return {
      users,
      stage,
      groups,
      stageMembers,
      customGroups,
      customStageMembers,
      videoProducers,
      audioProducers,
      customAudioProducers,
      ovTracks,
      customOvTracks,
    };
  }

  updateStage(id: StageId, update: Partial<Omit<Stage, '_id'>>): Promise<void> {
    return this._db.collection(Collections.STAGES).updateOne({ _id: id }, { $set: update })
      .then(() => {
        const payload = {
          ...update,
          _id: id,
        };
        this.emit(ServerStageEvents.STAGE_CHANGED, payload);
        this.sendToStage(id, ServerStageEvents.STAGE_CHANGED, payload);
      });
  }

  deleteStage(id: StageId): Promise<any> {
    return this._db.collection<Group>(Collections.GROUPS)
      .find({ stageId: id }, { projection: { _id: 1 } })
      .toArray()
      .then((groups) => Promise.all(groups.map((group) => this.deleteGroup(group._id))))
      .then(() => {
        this.emit(ServerStageEvents.STAGE_REMOVED, id);
        this.sendToStage(id, ServerStageEvents.STAGE_REMOVED, id);
      })
      .then(() => this._db.collection<Stage>(Collections.STAGES).deleteOne({ _id: id }));
  }

  createGroup(initial: Omit<Group, '_id'>): Promise<Group> {
    return this._db.collection<Group>(Collections.GROUPS).insertOne({
      ...initial,
      // stageId: new ObjectId(initial.stageId)
    })
      .then((result) => result.ops[0] as Group)
      .then((group) => {
        this.emit(ServerStageEvents.GROUP_ADDED, group);
        this.sendToStage(group.stageId, ServerStageEvents.GROUP_ADDED, group);
        return group;
      });
  }

  setSoundCard(userId: UserId, name: string, update: Omit<SoundCard, '_id' | 'name' | 'userId'>): Promise<SoundCard> {
    return this._db.collection<SoundCard>(Collections.SOUND_CARDS)
      .findOneAndUpdate(
        {
          userId,
          name,
        },
        { $set: update },
      )
      .then((result) => {
        if (result.value) {
          // Return updated document
          this.sendToUser(userId, ServerDeviceEvents.SOUND_CARD_CHANGED, {
            ...update,
            name,
            userId,
            _id: result.value._id,
          });
          return result.value;
        }
        return this._db.collection<SoundCard>(Collections.SOUND_CARDS).findOne({
          userId, name,
        }).then((soundCard) => {

          this.sendToUser(
            soundCard.userId,
            ServerDeviceEvents.SOUND_CARD_ADDED,
            soundCard,
          );
          return soundCard;
        });
      });
  }

  createSoundCard(initial: Omit<SoundCard, '_id'>): Promise<SoundCard> {
    return this._db.collection<SoundCard>(Collections.SOUND_CARDS).insertOne(initial)
      .then((result) => result.ops[0] as SoundCard)
      .then((soundCard) => {
        this.emit(ServerDeviceEvents.SOUND_CARD_ADDED, soundCard);
        this.sendToUser(soundCard.userId, ServerDeviceEvents.SOUND_CARD_ADDED, soundCard);
        // Also create default preset
        this.createTrackPreset({
          userId: soundCard.userId,
          soundCardId: soundCard._id,
          name: 'Default',
          inputChannels: soundCard.numInputChannels >= 2 ? [0, 1] : [],
          outputChannels: soundCard.numOutputChannels >= 2 ? [0, 1] : [],
        });
        return soundCard;
      });
  }

  createStageMember(initial: Omit<StageMember, '_id'>): Promise<StageMember> {
    return this._db.collection<StageMember>(Collections.STAGE_MEMBERS)
      .insertOne(initial)
      .then((result) => result.ops[0] as StageMember)
      .then(async (stageMember) => {
        this.emit(ServerStageEvents.STAGE_MEMBER_ADDED, stageMember);
        await this.sendToJoinedStageMembers(
          stageMember.stageId,
          ServerStageEvents.STAGE_MEMBER_ADDED,
          stageMember,
        );
        return stageMember;
      });
  }

  createTrack(initial: Omit<Track, '_id'>): Promise<Track> {
    return this._db.collection<Track>(Collections.TRACKS).insertOne(initial)
      .then((result) => result.ops[0] as Track)
      .then((track) => {
        this.emit(ServerDeviceEvents.TRACK_ADDED, track);
        this.sendToUser(track.userId, ServerDeviceEvents.TRACK_ADDED, track);

        this.readUser(track.userId).then(
          (user) => {
            if (user && user.stageMemberId) {
              const stageTrack: Omit<StageMemberOvTrack, '_id'> = {
                ...initial,
                stageId: user.stageId,
                stageMemberId: user.stageMemberId,
                userId: user._id,
                trackId: track._id,
                muted: false,
                online: true,
                x: 0,
                y: 0,
                z: 0,
                rX: 0,
                rY: 0,
                rZ: 0,
              };
              return this.createStageMemberOvTrack(stageTrack);
            }
            return null;
          },
        );
        return track;
      });
  }

  createTrackPreset(initial: Omit<TrackPreset, '_id'>): Promise<TrackPreset> {
    return this._db.collection<TrackPreset>(Collections.TRACK_PRESETS).insertOne(initial)
      .then((result) => result.ops[0] as TrackPreset)
      .then((preset) => {
        this.emit(ServerDeviceEvents.TRACK_PRESET_ADDED, preset);
        this.sendToUser(preset.userId, ServerDeviceEvents.TRACK_PRESET_ADDED, preset);
        return preset;
      });
  }

  deleteGroup(id: GroupId): Promise<void> {
    return this._db.collection<Group>(Collections.GROUPS).findOneAndDelete({ _id: id }, {
      projection: {
        _id: 1,
        stageId: 1,
      },
    })
      .then((result) => {
        if (result.value) {
          // Delete all associated custom groups and stage members
          this._db.collection<StageMember>(Collections.STAGE_MEMBERS)
            .find({ groupId: result.value._id }, {
              projection: {
                _id: 1,
                online: 1,
                userId: 1,
              },
            }).toArray()
            .then((stageMembers) => stageMembers.map(async (stageMember) => {
              // Throw out user first
              if (stageMember.online) {
                await this.leaveStage(stageMember.userId);
              }
              return this.deleteStageMember(stageMember._id);
            }));

          this._db.collection<CustomGroup>(Collections.CUSTOM_GROUPS)
            .find({ groupId: result.value._id }, { projection: { _id: 1 } })
            .toArray()
            .then((customGroups) => customGroups
              .map((customGroup) => this.deleteCustomGroup(customGroup._id)));

          this.emit(ServerStageEvents.GROUP_REMOVED, id);
          return this.sendToStage(result.value.stageId, ServerStageEvents.GROUP_REMOVED, id);
        }
        return null;
      });
  }

  deleteSoundCard(userId: UserId, id: SoundCardId): Promise<void> {
    return this._db.collection<SoundCard>(Collections.SOUND_CARDS).findOneAndDelete({
      _id: id,
      userId,
    }, { projection: { userId: 1 } })
      .then((result) => {
        if (result.value) {
          this._db.collection<Device>(Collections.DEVICES)
            .find({ soundCardIds: id })
            .toArray()
            .then((devices) => {
              devices.map((device) => {
                const soundCardIds = device.soundCardIds.filter((i) => !i.equals(id));
                return this.updateDevice(device.userId, device._id, {
                  soundCardIds,
                });
              });
            });
          this._db.collection<TrackPreset>(Collections.TRACK_PRESETS)
            .find({ soundCardId: id }, { projection: { _id: 1 } })
            .toArray()
            .then((presets) => presets
              .map((preset) => this.deleteTrackPreset(userId, preset._id)));
          this.emit(ServerDeviceEvents.SOUND_CARD_REMOVED, id);
          this.sendToUser(result.value.userId, ServerDeviceEvents.SOUND_CARD_REMOVED, id);
        }
      });
  }

  deleteStageMember(id: StageMemberId): Promise<void> {
    return this._db.collection<StageMember>(Collections.STAGE_MEMBERS)
      .findOneAndDelete({ _id: id }, { projection: { stageId: 1 } })
      .then((result) => {
        if (result.value) {
          // Delete all custom stage members and stage member tracks
          this._db.collection<CustomStageMember>(Collections.CUSTOM_STAGE_MEMBERS)
            .find({ stageMemberId: id }, { projection: { _id: 1 } })
            .toArray()
            .then((presets) => presets
              .map((preset) => this.deleteCustomStageMember(preset._id)));

          this._db.collection<StageMemberVideoProducer>(Collections.STAGE_MEMBER_VIDEOS)
            .find({ stageMemberId: id }, { projection: { _id: 1 } })
            .toArray()
            .then((producers) => producers
              .map((producer) => this.deleteStageMemberVideoProducer(producer._id)));
          this._db.collection<StageMemberAudioProducer>(Collections.STAGE_MEMBER_AUDIOS)
            .find({ stageMemberId: id }, { projection: { _id: 1 } })
            .toArray()
            .then((producers) => producers
              .map((producer) => this.deleteStageMemberAudioProducer(producer._id)));
          this._db.collection<StageMemberOvTrack>(Collections.STAGE_MEMBER_OVS)
            .find({ stageMemberId: id }, { projection: { _id: 1 } })
            .toArray()
            .then((tracks) => tracks
              .map((track) => this.deleteStageMemberOvTrack(track._id)));

          this.emit(ServerStageEvents.STAGE_MEMBER_REMOVED, id);
          return this.sendToJoinedStageMembers(
            result.value.stageId,
            ServerStageEvents.STAGE_MEMBER_REMOVED,
            id,
          );
        }
        return null;
      });
  }

  deleteTrack(userId: UserId, id: TrackId): Promise<void> {
    return this._db.collection<Track>(Collections.TRACKS).findOneAndDelete({
      _id: id,
      userId,
    }, { projection: { userId: 1 } })
      .then((result) => {
        if (result.value) {
          // Delete all custom stage members and stage member tracks
          this._db.collection<StageMemberOvTrack>(Collections.STAGE_MEMBER_OVS)
            .find({ trackId: id }, { projection: { _id: 1 } })
            .toArray()
            .then((tracks) => tracks
              .map((track) => this.deleteStageMemberOvTrack(track._id)));
          this.emit(ServerDeviceEvents.TRACK_REMOVED, id);
          this.sendToUser(result.value.userId, ServerDeviceEvents.TRACK_REMOVED, id);
        }
      });
  }

  deleteTrackPreset(userId: UserId, id: TrackPresetId): Promise<void> {
    return this._db.collection<TrackPreset>(Collections.TRACK_PRESETS).findOneAndDelete({
      _id: id,
      userId,
    }, { projection: { userId: 1 } })
      .then((result) => {
        if (result.value) {
          // Delete all custom stage members and stage member tracks
          this._db.collection<Track>(Collections.TRACKS)
            .find({ trackPresetId: id }, { projection: { _id: 1 } })
            .toArray()
            .then((tracks) => tracks.map((track) => this.deleteTrack(userId, track._id)));
          this.emit(ServerDeviceEvents.TRACK_PRESET_REMOVED, id);
          this.sendToUser(result.value.userId, ServerDeviceEvents.TRACK_PRESET_REMOVED, id);
        }
      });
  }

  readTrackPreset(id: TrackPresetId): Promise<TrackPreset> {
    return this._db.collection<TrackPreset>(Collections.TRACK_PRESETS).findOne({ _id: id });
  }

  readGroup(id: GroupId): Promise<Group> {
    return this._db.collection<Group>(Collections.GROUPS).findOne({ _id: id });
  }

  readSoundCard(id: SoundCardId): Promise<SoundCard> {
    return this._db.collection<SoundCard>(Collections.SOUND_CARDS).findOne({ _id: id });
  }

  readStageMember(id: StageMemberId): Promise<StageMember> {
    return this._db.collection<StageMember>(Collections.STAGE_MEMBERS).findOne({ _id: id });
  }

  readTrack(id: TrackId): Promise<Track> {
    return this._db.collection<Track>(Collections.TRACKS).findOne({ _id: id });
  }

  updateGroup(id: GroupId, update: Partial<Omit<Group, '_id'>>): Promise<void> {
    return this._db.collection<Group>(Collections.GROUPS)
      .findOneAndUpdate({ _id: id }, { $set: update }, { projection: { stageId: 1 } })
      .then((result) => {
        if (result.value) {
          const payload = {
            ...update,
            _id: id,
          };
          this.emit(ServerStageEvents.GROUP_CHANGED, payload);
          return this.sendToStage(result.value.stageId, ServerStageEvents.GROUP_CHANGED, payload);
        }
        return null;
      });
  }

  updateSoundCard(deviceId: DeviceId, id: SoundCardId, update: Partial<Omit<SoundCard, '_id'>>): Promise<void> {
    return this._db.collection<SoundCard>(Collections.SOUND_CARDS).findOneAndUpdate({
      _id: id,
      deviceId,
    }, { $set: update }, { projection: { userId: 1 } })
      .then((result) => {
        if (result.value) {
          const payload = {
            ...update,
            _id: id,
          };
          this.emit(ServerDeviceEvents.SOUND_CARD_CHANGED, payload);
          return this.sendToUser(
            result.value.userId,
            ServerDeviceEvents.SOUND_CARD_CHANGED,
            payload,
          );
        }
        return null;
      });
  }

  updateStageMember(id: StageMemberId, update: Partial<Omit<StageMember, '_id'>>): Promise<void> {
    return this._db.collection<StageMember>(Collections.STAGE_MEMBERS)
      .findOneAndUpdate({ _id: id }, { $set: update }, { projection: { stageId: 1 } })
      .then((result) => {
        if (result.value) {
          const payload = {
            ...update,
            _id: id,
          };
          this.emit(ServerStageEvents.STAGE_MEMBER_CHANGED, payload);
          return this.sendToJoinedStageMembers(
            result.value.stageId,
            ServerStageEvents.STAGE_MEMBER_CHANGED,
            payload,
          );
        }
        return null;
      });
  }

  updateTrack(deviceId: DeviceId, id: TrackId, update: Partial<Omit<Track, '_id'>>): Promise<void> {
    return this._db.collection<Track>(Collections.TRACKS).findOneAndUpdate({
      _id: id,
      deviceId,
    }, { $set: update }, { projection: { userId: 1 } })
      .then((result) => {
        if (result.value) {
          const payload = {
            ...update,
            _id: id,
          };
          this.emit(ServerDeviceEvents.TRACK_CHANGED, payload);
          this.sendToUser(result.value.userId, ServerDeviceEvents.TRACK_CHANGED, payload);
        }
      });
  }

  updateTrackPreset(userId: UserId, id: TrackPresetId, update: Partial<Omit<TrackPreset, '_id'>>): Promise<void> {
    return this._db.collection<TrackPreset>(Collections.TRACK_PRESETS).findOneAndUpdate({
      _id: id,
      userId,
    }, { $set: update }, { projection: { userId: 1 } })
      .then((result) => {
        if (result.value) {
          const payload = {
            ...update,
            _id: id,
          };
          this.emit(ServerDeviceEvents.TRACK_PRESET_CHANGED, payload);
          this.sendToUser(result.value.userId, ServerDeviceEvents.TRACK_PRESET_CHANGED, payload);
        }
      });
  }

  /* CUSTOMIZED STATES FOR EACH STAGE MEMBER */

  createCustomGroup(initial: Omit<CustomGroup, '_id'>): Promise<CustomGroup> {
    return this._db.collection<CustomGroup>(Collections.CUSTOM_GROUPS).insertOne(initial)
      .then((result) => result.ops[0] as CustomGroup)
      .then((customGroup) => {
        this.emit(ServerStageEvents.CUSTOM_GROUP_ADDED, customGroup);
        this.sendToUser(customGroup.userId, ServerStageEvents.CUSTOM_GROUP_ADDED, customGroup);
        return customGroup;
      });
  }

  updateCustomGroup(id: CustomGroupId, update: Partial<Omit<CustomGroup, '_id'>>): Promise<void> {
    return this._db.collection<CustomGroup>(Collections.CUSTOM_GROUPS).findOneAndUpdate({
      _id: id,
    }, { $set: update }, { projection: { userId: 1 } })
      .then((result) => {
        if (result.value) {
          const payload = {
            ...update,
            _id: id,
          };
          this.emit(ServerStageEvents.CUSTOM_GROUP_CHANGED, payload);
          this.sendToUser(result.value.userId, ServerStageEvents.CUSTOM_GROUP_CHANGED, payload);
        }
      });
  }

  setCustomGroup(
    userId: UserId,
    groupId: GroupId,
    update: Partial<ThreeDimensionAudioProperties>,
  ): Promise<void> {
    return this._db.collection<CustomGroup>(Collections.CUSTOM_GROUPS).findOneAndUpdate(
      { userId, groupId },
      {
        $set: update,
      },
      { upsert: true, projection: { _id: 1 } },
    )
      .then((result) => {
        if (result.value) {
          // Return updated document
          const payload = {
            ...update,
            _id: result.value._id,
          };
          this.emit(ServerStageEvents.CUSTOM_GROUP_CHANGED, payload);
          this.sendToUser(userId, ServerStageEvents.CUSTOM_GROUP_CHANGED, payload);
        } else if (result.ok) {
          // Return newly created document (result.value is null then, see https://docs.mongodb.com/manual/reference/method/db.collection.findOneAndUpdate/)
          this._db.collection<CustomGroup>(Collections.CUSTOM_GROUPS).findOne({
            userId, groupId,
          }).then((customGroup) => {
            this.emit(ServerStageEvents.CUSTOM_GROUP_ADDED, customGroup);
            this.sendToUser(
              customGroup.userId,
              ServerStageEvents.CUSTOM_GROUP_ADDED,
              customGroup,
            );
          });
        }
      });
  }

  readCustomGroup(id: CustomGroupId): Promise<CustomGroup> {
    return this._db.collection<CustomGroup>(Collections.CUSTOM_GROUPS).findOne({ _id: id });
  }

  deleteCustomGroup(id: CustomGroupId): Promise<void> {
    return this._db.collection<CustomGroup>(Collections.CUSTOM_GROUPS)
      .findOneAndDelete({ _id: id }, { projection: { userId: 1 } })
      .then((result) => {
        this.emit(ServerStageEvents.CUSTOM_GROUP_REMOVED, id);
        this.sendToUser(result.value.userId, ServerStageEvents.CUSTOM_GROUP_REMOVED, id);
      });
  }

  createCustomStageMember(initial: Omit<CustomStageMember, '_id'>): Promise<CustomStageMember> {
    return this._db.collection<CustomStageMember>(Collections.CUSTOM_STAGE_MEMBERS)
      .insertOne(initial)
      .then((result) => result.ops[0] as CustomStageMember)
      .then((customStageMember) => {
        this.emit(ServerStageEvents.CUSTOM_STAGE_MEMBER_ADDED, customStageMember);
        this.sendToUser(
          customStageMember.userId,
          ServerStageEvents.CUSTOM_STAGE_MEMBER_ADDED,
          customStageMember,
        );
        return customStageMember;
      });
  }

  updateCustomStageMember(id: CustomStageMemberId, update: Partial<Omit<CustomStageMember, '_id'>>): Promise<void> {
    return this._db.collection<CustomStageMember>(Collections.CUSTOM_STAGE_MEMBERS)
      .findOneAndUpdate({ _id: id }, { $set: update }, { projection: { userId: 1 } })
      .then((result) => {
        if (result.value) {
          const payload = {
            ...update,
            _id: id,
          };
          this.emit(ServerStageEvents.CUSTOM_STAGE_MEMBER_CHANGED, payload);
          this.sendToUser(
            result.value.userId,
            ServerStageEvents.CUSTOM_STAGE_MEMBER_CHANGED,
            payload,
          );
        }
      });
  }

  setCustomStageMember(userId: UserId, stageMemberId: StageMemberId, update: Partial<Omit<CustomStageMember, '_id'>>): Promise<void> {
    if (Object.keys(update).length === 0) return Promise.reject(new Error('No payload'));
    return this._db.collection<CustomStageMember>(Collections.CUSTOM_STAGE_MEMBERS)
      .findOneAndUpdate(
        {
          stageMemberId,
          userId,
        },
        { $set: update },
        { upsert: true, projection: { _id: 1 } },
      )
      .then((result) => {
        if (result.value) {
          // Return updated document
          const payload = {
            ...update,
            _id: result.value._id,
          };
          this.emit(ServerStageEvents.CUSTOM_STAGE_MEMBER_CHANGED, payload);
          this.sendToUser(userId, ServerStageEvents.CUSTOM_STAGE_MEMBER_CHANGED, payload);
        } else if (result.ok) {
          // Return newly created document (result.value is null then, see https://docs.mongodb.com/manual/reference/method/db.collection.findOneAndUpdate/)
          this._db.collection<CustomStageMember>(Collections.CUSTOM_STAGE_MEMBERS).findOne({
            stageMemberId,
            userId,
          })
            .then((customStageMember) => {
              this.emit(ServerStageEvents.CUSTOM_STAGE_MEMBER_ADDED, customStageMember);
              this.sendToUser(
                userId,
                ServerStageEvents.CUSTOM_STAGE_MEMBER_ADDED,
                customStageMember,
              );
            });
        }
      });
  }

  readCustomStageMember(id: CustomStageMemberId): Promise<CustomStageMember> {
    return this._db.collection<CustomStageMember>(Collections.CUSTOM_STAGE_MEMBERS)
      .findOne({ _id: id });
  }

  deleteCustomStageMember(id: CustomGroupId): Promise<void> {
    return this._db.collection<CustomStageMember>(Collections.CUSTOM_STAGE_MEMBERS)
      .findOneAndDelete({ _id: id }, { projection: { userId: 1 } })
      .then((result) => {
        this.emit(ServerStageEvents.CUSTOM_STAGE_MEMBER_REMOVED, id);
        this.sendToUser(result.value.userId, ServerStageEvents.CUSTOM_STAGE_MEMBER_REMOVED, id);
      });
  }

  createCustomStageMemberAudioProducer(initial: Omit<CustomStageMemberAudioProducer, '_id'>): Promise<CustomStageMemberAudioProducer> {
    return this._db
      .collection<CustomStageMemberAudioProducer>(Collections.CUSTOM_STAGE_MEMBER_AUDIOS)
      .insertOne(initial)
      .then((result) => result.ops[0] as CustomStageMemberAudioProducer)
      .then((customStageMemberAudioProducer) => {
        this.emit(
          ServerStageEvents.CUSTOM_STAGE_MEMBER_AUDIO_ADDED,
          customStageMemberAudioProducer,
        );
        this.sendToUser(
          customStageMemberAudioProducer.userId,
          ServerStageEvents.CUSTOM_STAGE_MEMBER_AUDIO_ADDED,
          customStageMemberAudioProducer,
        );
        return customStageMemberAudioProducer;
      });
  }

  readCustomStageMemberAudioProducer(id: StageMemberAudioProducerId)
    : Promise<CustomStageMemberAudioProducer> {
    return this._db
      .collection<CustomStageMemberAudioProducer>(Collections.CUSTOM_STAGE_MEMBER_AUDIOS)
      .findOne({ _id: id });
  }

  setCustomStageMemberAudioProducer(userId: UserId, stageMemberAudioProducerId: StageMemberAudioProducerId, update: Partial<Omit<CustomStageMemberAudioProducer, '_id'>>): Promise<void> {
    return this._db
      .collection<CustomStageMemberAudioProducer>(Collections.CUSTOM_STAGE_MEMBER_AUDIOS)
      .findOneAndUpdate(
        {
          stageMemberAudioProducerId,
          userId,
        },
        { $set: update },
        { upsert: true, projection: { _id: 1 } },
      )
      .then((result) => {
        if (result.value) {
          // Return updated document
          const payload = {
            ...update,
            _id: result.value._id,
          };
          this.emit(ServerStageEvents.CUSTOM_STAGE_MEMBER_AUDIO_CHANGED, payload);
          this.sendToUser(userId, ServerStageEvents.CUSTOM_STAGE_MEMBER_AUDIO_CHANGED, payload);
        } else if (result.ok) {
          // Return newly created document (result.value is null then, see https://docs.mongodb.com/manual/reference/method/db.collection.findOneAndUpdate/)
          this._db
            .collection<CustomStageMemberAudioProducer>(Collections.CUSTOM_STAGE_MEMBER_AUDIOS)
            .findOne({
              stageMemberAudioProducerId,
              userId,
            }).then((customAudioProducer) => {
              this.emit(ServerStageEvents.CUSTOM_STAGE_MEMBER_AUDIO_ADDED, customAudioProducer);
              this.sendToUser(
                userId,
                ServerStageEvents.CUSTOM_STAGE_MEMBER_AUDIO_ADDED,
                customAudioProducer,
              );
            });
        }
      });
  }

  updateCustomStageMemberAudioProducer(id: CustomStageMemberAudioProducerId, update: Partial<Omit<CustomStageMemberAudioProducer, '_id'>>): Promise<void> {
    return this._db
      .collection<CustomStageMemberAudioProducer>(Collections.CUSTOM_STAGE_MEMBER_AUDIOS)
      .findOneAndUpdate({ _id: id }, { $set: update }, { projection: { userId: 1 } })
      .then((result) => {
        if (result.value) {
          const payload = {
            ...update,
            _id: id,
          };
          this.emit(ServerStageEvents.CUSTOM_STAGE_MEMBER_AUDIO_CHANGED, payload);
          this.sendToUser(
            result.value.userId,
            ServerStageEvents.CUSTOM_STAGE_MEMBER_AUDIO_CHANGED,
            payload,
          );
        }
      });
  }

  deleteCustomStageMemberAudioProducer(id: CustomStageMemberAudioProducerId): Promise<void> {
    return this._db.collection<CustomStageMember>(Collections.CUSTOM_STAGE_MEMBER_AUDIOS)
      .findOneAndDelete({ _id: id }, { projection: { userId: 1 } })
      .then((result) => {
        if (result) {
          this.emit(ServerStageEvents.CUSTOM_STAGE_MEMBER_AUDIO_REMOVED, id);
          this.sendToUser(
            result.value.userId,
            ServerStageEvents.CUSTOM_STAGE_MEMBER_AUDIO_REMOVED,
            id,
          );
        }
      });
  }

  createCustomStageMemberOvTrack(initial: Omit<CustomStageMemberOvTrack, '_id'>): Promise<CustomStageMemberOvTrack> {
    return this._db.collection<CustomStageMemberOvTrack>(Collections.CUSTOM_STAGE_MEMBER_OVS)
      .insertOne(initial)
      .then((result) => result.ops[0] as CustomStageMemberOvTrack)
      .then((customStageMemberOvTrack) => {
        this.emit(ServerStageEvents.CUSTOM_STAGE_MEMBER_OV_ADDED, customStageMemberOvTrack);
        this.sendToUser(
          customStageMemberOvTrack.userId,
          ServerStageEvents.CUSTOM_STAGE_MEMBER_OV_ADDED,
          customStageMemberOvTrack,
        );
        return customStageMemberOvTrack;
      });
  }

  readCustomStageMemberOvTrack(id: CustomStageMemberOvTrackId): Promise<CustomStageMemberOvTrack> {
    return this._db.collection<CustomStageMemberOvTrack>(Collections.CUSTOM_STAGE_MEMBER_OVS)
      .findOne({ _id: id });
  }

  setCustomStageMemberOvTrack(userId: UserId, stageMemberOvTrackId: StageMemberOvTrackId, update: Partial<Omit<CustomStageMemberOvTrack, '_id'>>): Promise<void> {
    return this._db.collection<CustomStageMemberOvTrack>(Collections.CUSTOM_STAGE_MEMBER_OVS)
      .findOneAndUpdate(
        {
          stageMemberOvTrackId,
          userId,
        },
        { $set: update },
        { upsert: true, projection: { _id: 1 } },
      )
      .then((result) => {
        if (result.value) {
          // Return updated document
          const payload = {
            ...update,
            _id: result.value._id,
          };
          this.emit(ServerStageEvents.CUSTOM_STAGE_MEMBER_OV_CHANGED, payload);
          this.sendToUser(userId, ServerStageEvents.CUSTOM_STAGE_MEMBER_OV_CHANGED, payload);
        } else if (result.ok) {
          // Return newly created document (result.value is null then, see https://docs.mongodb.com/manual/reference/method/db.collection.findOneAndUpdate/)
          this._db.collection<CustomStageMemberOvTrack>(Collections.CUSTOM_STAGE_MEMBER_OVS)
            .findOne({
              stageMemberOvTrackId,
              userId,
            })
            .then((customOvTrack) => {
              this.emit(ServerStageEvents.CUSTOM_STAGE_MEMBER_OV_ADDED, customOvTrack);
              this.sendToUser(
                userId,
                ServerStageEvents.CUSTOM_STAGE_MEMBER_OV_ADDED,
                customOvTrack,
              );
            });
        }
      });
  }

  updateCustomStageMemberOvTrack(id: ObjectId, update: Partial<Pick<CustomStageMemberOvTrack, 'stageId' | 'userId' | 'volume' | 'x' | 'y' | 'z' | 'rX' | 'rY' | 'rZ' | 'stageMemberOvTrackId' | 'gain' | 'directivity'>>): Promise<void> {
    return this._db.collection<CustomStageMemberOvTrack>(Collections.CUSTOM_STAGE_MEMBER_OVS)
      .findOneAndUpdate({ _id: id }, { $set: update }, { projection: { userId: 1 } })
      .then((result) => {
        if (result.value) {
          const payload = {
            ...update,
            _id: id,
          };
          this.emit(ServerStageEvents.CUSTOM_STAGE_MEMBER_OV_ADDED, payload);
          this.sendToUser(
            result.value.userId,
            ServerStageEvents.CUSTOM_STAGE_MEMBER_OV_CHANGED,
            payload,
          );
        }
      });
  }

  deleteCustomStageMemberOvTrack(id: ObjectId): Promise<void> {
    return this._db.collection<CustomStageMemberOvTrack>(Collections.CUSTOM_STAGE_MEMBER_OVS)
      .findOneAndDelete({ _id: id }, { projection: { userId: 1 } })
      .then((result) => {
        this.emit(ServerStageEvents.CUSTOM_STAGE_MEMBER_OV_REMOVED, id);
        this.sendToUser(result.value.userId, ServerStageEvents.CUSTOM_STAGE_MEMBER_OV_REMOVED, id);
      });
  }

  /* SENDING METHODS */
  public async sendStageDataToDevice(socket: ITeckosSocket, user: User): Promise<any> {
    if (user.stageMemberId) {
      // Switch current stage member online
      await this._db
        .collection(Collections.STAGE_MEMBERS)
        .updateOne(
          { stageMemberId: user.stageMemberId },
          { $set: { online: true } },
        );
    }
    const stageMembers = await this._db.collection(Collections.STAGE_MEMBERS)
      .find({ userId: user._id })
      .toArray();
    // Get all managed stages and stages, where the user was or is in
    const stages = await this._db.collection(Collections.STAGES)
      .find(
        {
          $or: [
            { _id: { $in: stageMembers.map((groupMember) => groupMember.stageId) } },
            { admins: user._id },
          ],
        },
      )
      .toArray();
    await Promise.all(stages
      .map((stage) => MongoRealtimeDatabase.sendToDevice(
        socket,
        ServerStageEvents.STAGE_ADDED,
        stage,
      )));
    const groups = await this._db.collection(Collections.GROUPS)
      .find({ stageId: { $in: stages.map((stage) => stage._id) } })
      .toArray();
    await Promise.all(groups
      .map((group) => MongoRealtimeDatabase.sendToDevice(
        socket,
        ServerStageEvents.GROUP_ADDED,
        group,
      )));

    if (user.stageMemberId) {
      const stageMember = stageMembers
        .find((groupMember) => groupMember._id.equals(user.stageMemberId));
      if (stageMember) {
        const wholeStage: StagePackage = await this.getWholeStage(user._id, user.stageId, true);
        const initialStage: InitialStagePackage = {
          ...wholeStage,
          stageId: user.stageId,
          groupId: stageMember.groupId,
        };
        MongoRealtimeDatabase.sendToDevice(socket, ServerStageEvents.STAGE_JOINED, initialStage);
      } else {
        err('Group member or stage should exists, but could not be found');
      }
    }
  }

  public async sendDeviceConfigurationToDevice(socket: ITeckosSocket, user: User): Promise<any> {
    // Send all sound cards
    const soundCards = await this._db.collection(Collections.SOUND_CARDS)
      .find({ userId: user._id })
      .toArray();
    await Promise.all(soundCards
      .map((soundCard) => MongoRealtimeDatabase.sendToDevice(
        socket,
        ServerDeviceEvents.SOUND_CARD_ADDED,
        soundCard,
      )));
    const trackPresets = await this._db.collection(Collections.TRACK_PRESETS)
      .find({ userId: user._id })
      .toArray();
    await Promise.all(trackPresets
      .map((trackPreset) => MongoRealtimeDatabase.sendToDevice(
        socket,
        ServerDeviceEvents.TRACK_PRESET_ADDED,
        trackPreset,
      )));
  }

  async sendToStage(stageId: StageId, event: string, payload?: any): Promise<void> {
    const adminIds: UserId[] = await this._db
      .collection<Stage>(Collections.STAGES)
      .findOne({ _id: stageId }, { projection: { admins: 1 } })
      .then((stage) => stage.admins);
    const stageMemberIds: UserId[] = await this._db
      .collection<StageMember>(Collections.STAGE_MEMBERS)
      .find({ stageId }, { projection: { userId: 1 } })
      .toArray()
      .then((stageMembers) => stageMembers.map((stageMember) => stageMember.userId));
    const userIds: {
      [id: string]: UserId
    } = {};
    adminIds.forEach((adminId) => {
      userIds[adminId.toHexString()] = adminId;
    });
    stageMemberIds.forEach((stageMemberId) => {
      userIds[stageMemberId.toHexString()] = stageMemberId;
    });
    Object.values(userIds).forEach((userId) => this.sendToUser(userId, event, payload));
  }

  sendToStageManagers(stageId: StageId, event: string, payload?: any): Promise<void> {
    return this._db
      .collection(Collections.STAGES)
      .findOne({ _id: new ObjectId(stageId) }, { projection: { admins: 1 } })
      .then((stage) => stage.admins
        .forEach((admin) => this.sendToUser(admin, event, payload)));
  }

  sendToJoinedStageMembers(stageId: StageId, event: string, payload?: any): Promise<void> {
    return this._db
      .collection<User>(Collections.USERS)
      .find({ stageId }, { projection: { _id: 1 } })
      .toArray()
      .then((users: { _id: UserId }[]) => {
        users.forEach((user) => this.sendToUser(user._id, event, payload));
      });
  }

  static sendToDevice(socket: ITeckosSocket, event: string, payload?: any): void {
    if (DEBUG_EVENTS) {
      if (DEBUG_PAYLOAD) {
        trace(`SEND TO DEVICE '${socket.id}' ${event}: ${JSON.stringify(payload)}`);
      } else {
        trace(`SEND TO DEVICE '${socket.id}' ${event}`);
      }
    }
    socket.emit(event, payload);
  }

  sendToUser(userId: UserId, event: string, payload?: any): void {
    if (DEBUG_EVENTS) {
      if (DEBUG_PAYLOAD) {
        trace(`SEND TO USER '${userId}' ${event}: ${JSON.stringify(payload)}`);
      } else {
        trace(`SEND TO USER '${userId}' ${event}`);
      }
    }
    this._io.to(userId.toString(), event, payload);
  }

  sendToAll(event: string, payload?: any): void {
    if (DEBUG_EVENTS) {
      if (DEBUG_PAYLOAD) {
        trace(`SEND TO ALL ${event}: ${JSON.stringify(payload)}`);
      } else {
        trace(`SEND TO ALL ${event}`);
      }
    }
    this._io.toAll(event, payload);
  }
}

export default MongoRealtimeDatabase;
