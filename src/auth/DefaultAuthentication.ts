import * as socketIO from 'socket.io';
import fetch from 'node-fetch';
import * as pino from 'pino';
import { HttpRequest } from 'uWebSockets.js';
import { IRealtimeDatabase } from '../database/IRealtimeDatabase';
import { User } from '../model.server';
import { IAuthentication, IAuthenticationMiddleware } from './IAuthentication';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

export interface DefaultAuthUser {
  _id: string;
  name: string;
  email: string;
  avatarUrl?: string;
}

const getUserByToken = (token: string): Promise<DefaultAuthUser> => fetch(`${process.env.AUTH_URL}/profile`, {
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  },
})
  .then((result) => result.json());

class DefaultAuthentication implements IAuthentication {
  private readonly database;

  constructor(database: IRealtimeDatabase) {
    this.database = database;
  }

  verifyWithToken(resolve, reject, token: string): Promise<User> {
    return getUserByToken(token)
      .then((authUser) => this.database.readUserByUid(authUser._id)
        .then((user) => {
          if (!user) {
            logger.trace(`[AUTH] Creating new user ${authUser.name}`);
            return this.database.createUser({
              uid: authUser._id,
              name: authUser.name,
              avatarUrl: authUser.avatarUrl,
            })
              .then((createdUser) => resolve(createdUser));
          }
          return resolve(user);
        }))
      .catch((error) => {
        logger.trace('[AUTH] Invalid token delivered');
        logger.error(error);
        reject(new Error('Invalid credentials'));
      });
  }

  authorizeSocket(socket: socketIO.Socket): Promise<User> {
    return new Promise<User>((resolve, reject) => {
      if (!socket.handshake.query || !socket.handshake.query.token) {
        reject(new Error('Missing authorization'));
      }
      return this.verifyWithToken(resolve, reject, socket.handshake.query.token);
    });
  }

  authorizeRequest(req: HttpRequest): Promise<User> {
    return new Promise<User>((resolve, reject) => {
      const authorization: string = req.getHeader('authorization');
      if (!authorization) {
        reject(new Error('Missing authorization'));
      }
      if (!authorization.startsWith('Bearer ')) {
        reject(new Error('Invalid authorization'));
      }
      const token = authorization.substr(7);
      return this.verifyWithToken(resolve, reject, token);
    });
  }
}

export const DefaultAuthenticationMiddleware: IAuthenticationMiddleware = ((socket, next) => {
  const { token } = socket.handshake.query;
  getUserByToken(token).then(() => next());
  return next(new Error('authentication error'));
});

export default DefaultAuthentication;
