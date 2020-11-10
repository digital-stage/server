import * as pino from 'pino';
import { ITeckosProvider, ITeckosSocket } from 'teckos';
import MongoRealtimeDatabase from '../database/MongoRealtimeDatabase';
import SocketDeviceHandler from './SocketDeviceHandler';
import SocketStageHandler from './SocketStageHandler';
import { ServerGlobalEvents, ServerUserEvents } from '../events';
import { IAuthentication } from '../auth/IAuthentication';
import { Device } from '../model.server';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
});

class SocketHandler {
  private readonly _serverAddress: string;

  private readonly _database: MongoRealtimeDatabase;

  private readonly _authentication: IAuthentication;

  private readonly _io: ITeckosProvider;

  constructor(
    serverAddress,
    database: MongoRealtimeDatabase,
    authentication: IAuthentication,
    io: ITeckosProvider,
  ) {
    this._serverAddress = serverAddress;
    this._database = database;
    this._authentication = authentication;
    this._io = io;
  }

  async init(): Promise<void> {
    logger.info('[SOCKETSERVER] Initializing socket server...');

    try {
      this._io.onConnection((socket: ITeckosSocket) => {
        // Wait for token

        socket.on('token', (payload: {
          token: string;
          device?: Partial<Device>
        }) => {
          const { token, device: initialDevice } = payload;
          if (token) {
            return this._authentication.verifyWithToken(token)
              .then((user) => {
                logger.trace(`[SOCKETSERVER] Incoming socket request ${socket.id}`);

                logger.trace(`[SOCKETSERVER](${socket.id}) Authenticated user ${user.name}`);
                const deviceHandler = new SocketDeviceHandler(
                  this._serverAddress,
                  this._database,
                  user,
                  socket,
                );
                const stageHandler = new SocketStageHandler(this._database, user, socket);

                deviceHandler.init();

                stageHandler.init();

                MongoRealtimeDatabase.sendToDevice(socket, ServerUserEvents.USER_READY, user);

                return Promise.all([
                  deviceHandler.generateDevice(initialDevice)
                    .then(() => deviceHandler.sendRemoteDevices()),
                  stageHandler.sendStages(),
                ])
                  .then(() => {
                    socket.join(user._id.toString());
                    MongoRealtimeDatabase.sendToDevice(socket, ServerGlobalEvents.READY);
                  })
                  .catch((error) => {
                    socket.error(error.message);
                    logger.error(`[SOCKETSERVER](${socket.id}) Internal error`);
                    logger.error(error);
                    socket.disconnect();
                  });
              })
              .catch((authError) => {
                logger.error(authError);
                socket.disconnect();
              });
          }
          logger.error('[SOCKETSERVER] Malformed token provided');
          console.log(payload);
          return socket.disconnect();
        });
        // TODO: Disconnect after timeout when no token is delivered
      });
    } catch (error) {
      console.error(error);
    }

    logger.info('[SOCKETSERVER] DONE initializing socket server.');
  }
}

export default SocketHandler;
