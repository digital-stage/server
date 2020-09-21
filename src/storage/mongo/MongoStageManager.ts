import {
    Device,
    DeviceId,
    GroupId,
    Producer,
    ProducerId,
    RouterId,
    StageId,
    StageMemberId,
    User,
} from "../../model.common";
import Client from "../../model.client";
import Model from "./model.mongo";
import * as pino from "pino";
import * as mongoose from "mongoose";
import {IDeviceManager, IStageManager, IUserManager} from "../IManager";
import {MONGO_URL} from "../../env";
import {Errors} from "../../errors";

const logger = pino({level: process.env.LOG_LEVEL || 'info'});

class MongoStageManager implements IStageManager, IDeviceManager, IUserManager {
    private readonly database: string;
    private initialized: boolean = false;

    constructor(database: string) {
        this.database = database;
    }

    init(): Promise<any> {
        if (!this.initialized) {
            this.initialized = true;
            logger.info("[MONGOSTORAGE] Initializing mongo storage at " + MONGO_URL + "/" + this.database + " ...");
            return mongoose.connect(MONGO_URL + "/" + this.database, {
                useNewUrlParser: true,
                useUnifiedTopology: true,
                useFindAndModify: false
            })
                .then(() => logger.info("[MONGOSTORAGE] DONE initializing mongo storage."))
        }
    }

    addGroup(user: User, stageId: StageId, name: string): Promise<Client.GroupPrototype> {
        return Model.StageModel.findOne({_id: stageId, admins: user._id})
            .then(() => {
                const group = new Model.GroupModel();
                group.stageId = stageId;
                group.name = name;
                return group.save();
            });
    }

    addProducer(user: User, device: Device, kind: "audio" | "video" | "ov", routerId: RouterId): Promise<Producer> {
        const producer = new Model.ProducerModel();
        producer.userId = user._id;
        producer.deviceId = device._id;
        producer.kind = kind;
        producer.routerId = routerId;
        return producer.save();
    }

    createStage(user: User, initialStage: Partial<Client.StagePrototype>): Promise<Client.StagePrototype> {
        const stage = new Model.StageModel();
        stage.name = initialStage.name;
        stage.password = initialStage.password;
        stage.width = initialStage.width || 25;
        stage.length = initialStage.length || 13;
        stage.height = initialStage.height || 7.5;
        stage.reflection = initialStage.reflection || 0.7;
        stage.absorption = initialStage.absorption || 0.6;
        stage.admins = initialStage.admins ? [...initialStage.admins, user._id] : [user._id];
        return stage.save();
    }

    getUserByUid(uid: string): Promise<User> {
        return Model.UserModel.findOne({uid: uid}).lean().exec();
    }

    getUsersByStage(stageId: StageId): Promise<User[]> {
        return Model.StageModel.findById(stageId).lean().exec()
            .then(stage => {
                if (stage)
                    return Model.StageMemberModel.find({stageId: stageId}).lean().exec()
                        .then(stageMembers => {
                            const userIds: string[] = [...new Set([...stage.admins, ...stageMembers.map(stageMember => stageMember.userId)])];
                            return Model.UserModel.find({
                                _id: {$in: userIds}
                            }).lean().exec();
                        });
                else
                    return [];
            });
    }

    getUsersWithActiveStage(stageId: StageId): Promise<User[]> {
        return Model.UserModel.find({stageId: stageId}).lean().exec();
    }

    joinStage(user: User, stageId: StageId, groupId: GroupId, password?: string): Promise<Client.GroupMemberPrototype> {
        return Model.UserModel.findById(user._id).exec()
            .then(user => {
                if (user && user.stageId !== stageId) {
                    return Model.StageModel.findById(stageId).exec()
                        .then(stage => {
                            if (!stage) {
                                throw new Error(Errors.NOT_FOUND);
                            }
                            if (stage.password && stage.password !== password) {
                                throw new Error(Errors.INVALID_PASSWORD);
                            }
                            return Model.StageMemberModel.findOne({userId: user._id, stageId: stageId}).exec()
                                .then(stageMember => {
                                    if (!stageMember) {
                                        console.log("Created new stage member");
                                        const stageMember = new Model.StageMemberModel();
                                        stageMember.userId = user._id;
                                        stageMember.stageId = stageId;
                                        stageMember.groupId = groupId;
                                        stageMember.volume = 1;
                                        return stageMember.save();
                                    }
                                    console.log("Used existing stage member");
                                    stageMember.groupId = groupId;
                                    return stageMember.save();
                                })
                                .then(stageMember => {
                                    user.stageId = stageMember.stageId;
                                    user.stageMemberId = stageMember._id;
                                    return user.save().then((user) => ({
                                        ...stageMember.toObject(),
                                        name: user.name,
                                        avatarUrl: user.avatarUrl
                                    }));
                                })
                        })
                }
            })
    }


    leaveStage(user: User): Promise<boolean> {
        return Model.UserModel.findByIdAndUpdate(user._id, {
            stageId: undefined,
            stageMemberId: undefined
        }).exec()
            .then(() => true)
            .catch(() => false);
    }

    removeGroup(user: User, groupId: GroupId): Promise<Client.GroupPrototype> {
        return Model.GroupModel
            .findById(groupId)
            .exec()
            .then(group => Model.StageModel
                .findOne({_id: group.stageId, admins: user._id})
                .exec()
                .then(() => group.remove())
                .then(() => group.toObject())
            );
    }

    removeProducer(device: Device, producerId: ProducerId): Promise<Producer> {
        return Model.ProducerModel
            .findOne({
                _id: producerId,
                deviceId: device._id
            })
            .exec()
            .then(producer => producer.remove());
    }

    removeStage(user: User, stageId: StageId): Promise<Client.StagePrototype> {
        return Model.StageModel
            .findById(stageId)
            .exec()
            .then(stage => stage.remove());
    }

    setCustomGroupVolume(user: User, groupId: GroupId, volume: number) {
        return Model.CustomGroupVolumeModel.findOneAndUpdate({
            userId: user._id,
            groupId: groupId,
        }, {volume: volume}, {
            upsert: true
        }).lean().exec();
    }

    updateGroup(user: User, groupId: GroupId, doc: Partial<Client.GroupPrototype>): Promise<Client.GroupPrototype> {
        return Model.GroupModel.findOne({
            _id: groupId,
        }).exec()
            .then(
                group => {
                    return Model.UserModel.findOne({_id: user._id, managedStages: group.stageId}).lean().exec()
                        .then(() => {
                                return group.updateOne(doc)
                                    .then(() => group.toObject())
                            }
                        );
                });
    }

    updateProducer(device: Device, producerId: ProducerId, producer: Partial<Producer>): Promise<Producer> {
        return Model.ProducerModel.findOneAndUpdate({_id: producerId, deviceId: device._id}, producer)
            .lean().exec();
    }

    updateStage(user: User, stageId: StageId, stage: Partial<Client.StagePrototype>): Promise<Client.StagePrototype> {
        return Model.StageModel.findOneAndUpdate({_id: stageId, admins: user._id}, stage).lean().exec();
    }

    createDevice(user: User, server: string, initialDevice: Partial<Omit<Device, "_id">>): Promise<Device> {
        const device = new Model.DeviceModel();
        device.server = server;
        device.mac = initialDevice.mac;
        device.canVideo = initialDevice.canVideo;
        device.canAudio = initialDevice.canAudio;
        device.sendAudio = initialDevice.sendAudio;
        device.sendVideo = initialDevice.sendVideo;
        device.receiveAudio = initialDevice.receiveAudio;
        device.receiveVideo = initialDevice.receiveVideo;
        device.inputVideoDevices = initialDevice.inputVideoDevices;
        device.inputAudioDevices = initialDevice.inputAudioDevices;
        device.outputAudioDevices = initialDevice.outputAudioDevices;
        device.inputVideoDevice = initialDevice.inputVideoDevice;
        device.inputAudioDevice = initialDevice.inputAudioDevice;
        device.outputAudioDevice = initialDevice.outputAudioDevice;
        device.online = initialDevice.online;
        device.name = initialDevice.name ? initialDevice.name : "";
        device.userId = user._id;
        return device.save();
    }

    getDeviceByUserAndMac(user: User, mac: string): Promise<Device> {
        return Model.DeviceModel.findOne({userId: user._id, mac: mac}).lean().exec();
    }

    getDevices(): Promise<Device[]> {
        return Model.DeviceModel.find().lean().exec();
    }

    getDevicesByUser(user: User): Promise<Device[]> {
        return Model.DeviceModel.find({userId: user._id}).lean().exec();
    }

    removeDevice(deviceId: DeviceId): Promise<Device> {
        return Model.DeviceModel
            .findById(deviceId)
            .exec()
            .then(device => device.remove())
            .then(device => device.toObject());
    }

    updateDevice(deviceId: DeviceId, device: Partial<Omit<Device, "_id">>): Promise<Device> {
        return Model.DeviceModel.findByIdAndUpdate(deviceId, device).lean().exec();
    }

    generateGroupMembersByStage(stageId: StageId): Promise<Client.GroupMemberPrototype[]> {
        return Promise.resolve([]);
    }

    getCustomGroupVolumesByUserAndStage(user: User, stageId: StageId): Promise<Client.CustomGroupVolume[]> {
        return Promise.resolve([]);
    }

    getCustomStageMemberVolumesByUserAndStage(user: User, stageId: StageId): Promise<Client.CustomStageMemberVolume[]> {
        return Promise.resolve([]);
    }

    getGroupsByStage(stageId: StageId): Promise<Client.GroupPrototype[]> {
        return Model.GroupModel.find({stageId: stageId}).lean().exec();
    }

    getProducersByStage(stageId: StageId): Promise<Producer[]> {
        return this.getUsersWithActiveStage(stageId)
            .then(users => Model.ProducerModel.find({userId: {$in: users.map(user => user._id)}}).lean().exec());
    }


    setCustomStageMemberVolume(user: User, stageMemberId: StageMemberId, volume: number): Promise<Client.CustomStageMemberVolume> {
        return Model.CustomStageMemberVolumeModel.findOneAndUpdate({
            userId: user._id,
            stageMemberId: stageMemberId,
        }, {volume: volume}, {
            upsert: true
        }).lean().exec();
    }

    updateStageMember(user: User, id: StageMemberId, groupMember: Partial<Client.StageMemberPrototype>): Promise<Client.StageMemberPrototype> {
        return Model.StageMemberModel.findById(id).exec()
            .then(stageMember => {
                return Model.StageModel.findOne({_id: stageMember.stageId, admins: user._id})
                    .then(() => stageMember.update(groupMember)
                        .then(() => stageMember.toObject()))
            });
    }

    createUserWithUid(uid: string, name: string, avatarUrl?: string): Promise<User> {
        const user = new Model.UserModel();
        user.uid = uid;
        user.name = name;
        user.avatarUrl = avatarUrl;
        return user.save()
            .then(user => user.toObject());
    }

    getStage(stageId: StageId): Promise<Client.StagePrototype> {
        return Model.StageModel.findById(stageId).lean().exec();
    }

    getStagesByUser(user: User): Promise<Client.StagePrototype[]> {
        return Model.StageMemberModel.find({userId: user._id}).lean().exec()
            .then(stageMembers =>
                Model.StageModel.find({$or: [{_id: {$in: stageMembers.map(stageMember => stageMember.stageId)}}, {admins: user._id}]}).lean().exec()
            );
    }

    getJoinedUsersOfStage(stageId: StageId): Promise<User[]> {
        return Model.UserModel.find({stageId: stageId}).lean().exec();
    }

    getUser(id: string): Promise<User> {
        return Model.UserModel.findById(id).lean().exec();
    }

    getUsersManagingStage(stageId: StageId): Promise<User[]> {
        return Model.UserModel.find({managedStages: stageId}).lean().exec();
    }

    removeDevicesByServer(server: string): Promise<any> {
        return Model.DeviceModel
            .find({
                server: server
            })
            .exec()
            .then(servers => servers.map(server => server.remove()));
    }

    isUserAssociatedWithStage(user: User, stageId: StageId): Promise<boolean> {
        return Model.StageModel.findById(stageId).exec()
            .then(stage => {
                if (stage.admins.find(admin => admin === user._id))
                    return true;
                // Maybe there is a stage Member?
                return Model.StageMemberModel.findOne({userId: user._id, stageId: stageId}).exec()
                    .then(stageMember => {
                        if (stageMember) {
                            console.log("user is associated");
                            return true
                        }
                        console.log("user is NOT associated");
                        return false;
                    });
            })
    }

    getStageMember(id: StageMemberId): Promise<Client.StageMemberPrototype> {
        return Model.StageMemberModel.findById(id).lean().exec();
    }

    removeStageMember(id: StageMemberId): Promise<Client.StageMemberPrototype> {
        return Model.StageMemberModel.findByIdAndRemove(id).lean().exec();
    }

    removeStageMemberByUserAndStage(user: User, stageId: StageId): Promise<Client.StageMemberPrototype> {
        return Model.StageMemberModel.findOneAndRemove({userId: user._id, stageId: stageId}).lean().exec();
    }
}

export default MongoStageManager;