import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import type { BotGateway } from '../bot/gateway';
import { ApiError } from '../errors';
import { logger } from '../logger';
import { getUserFromToken } from '../middleware/auth';
import { checkRate } from '../middleware/ratelimit';
import { createMessage, messageExistsInRoom } from '../services/message';
import { addSocket, onlineUserIds, removeSocket } from '../services/presence';
import { assertMember, getRoomMaxSeq, touchRead } from '../services/room';
import type { AuthUser } from '../types';
import { setSocketServer } from './broadcast';

function roomKey(roomId: number): string {
  return `room:${roomId}`;
}

function ackError(error: unknown): { ok: false; code: string; message: string } {
  if (error instanceof ApiError) {
    return { ok: false, code: error.code, message: error.message };
  }
  logger.error({ err: error }, 'socket handler failed');
  return { ok: false, code: 'INTERNAL', message: 'Internal error' };
}

export function createIo(httpServer: HttpServer): Server {
  const io = new Server(httpServer, {
    cors: { origin: true },
    maxHttpBufferSize: 1e6,
  });

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (typeof token !== 'string' || token.length === 0) {
        throw new Error('missing token');
      }
      const user = await getUserFromToken(token);
      if (user.type === 'bot') {
        throw new Error('bot account');
      }
      socket.data.user = user;
      socket.data.rooms = new Set<number>();
      next();
    } catch {
      next(new Error('UNAUTHORIZED'));
    }
  });

  setSocketServer(io);

  return io;
}

/**
 * Removes every live socket of `userId` from a Socket.IO room, so a membership
 * revoked over REST (leave) takes effect immediately for already-connected clients.
 */
export async function evictUserFromRoom(
  io: Server,
  roomId: number,
  userId: number,
): Promise<void> {
  const sockets = await io.in(roomKey(roomId)).fetchSockets();
  for (const socket of sockets) {
    const socketUser = socket.data.user as AuthUser | undefined;
    if (socketUser?.id !== userId) {
      continue;
    }
    await socket.leave(roomKey(roomId));
    (socket.data.rooms as Set<number> | undefined)?.delete(roomId);
    const lastSocket = removeSocket(roomId, userId, socket.id);
    socket.emit('room:revoked', { roomId });
    if (lastSocket) {
      io.to(roomKey(roomId)).emit('presence', {
        roomId,
        onlineUserIds: onlineUserIds(roomId),
      });
    }
  }
}

export function registerSocketHandlers(io: Server, gateway: BotGateway): void {
  io.on('connection', (socket) => {
    const user = socket.data.user as AuthUser;
    const joinedRooms = socket.data.rooms as Set<number>;

    socket.on('room:join', async (payload: { roomId?: number; read?: boolean }, ack?: (res: unknown) => void) => {
      try {
        const roomId = Number(payload?.roomId);
        if (!Number.isInteger(roomId) || roomId <= 0) {
          throw new ApiError(400, 'INVALID_ROOM_ID', 'Invalid room id');
        }
        await assertMember(roomId, user.id);
        await socket.join(roomKey(roomId));
        joinedRooms.add(roomId);
        addSocket(roomId, user.id, socket.id);
        if (payload?.read !== false) {
          await touchRead(roomId, user.id);
        }
        const lastSeq = await getRoomMaxSeq(roomId);
        ack?.({ ok: true, lastSeq });
        io.to(roomKey(roomId)).emit('presence', {
          roomId,
          onlineUserIds: onlineUserIds(roomId),
        });
      } catch (error) {
        ack?.(ackError(error));
      }
    });

    socket.on('room:watch', async (payload: { roomId?: number }, ack?: (res: unknown) => void) => {
      try {
        const roomId = Number(payload?.roomId);
        if (!Number.isInteger(roomId) || roomId <= 0) {
          throw new ApiError(400, 'INVALID_ROOM_ID', 'Invalid room id');
        }
        await assertMember(roomId, user.id);
        await socket.join(roomKey(roomId));
        ack?.({ ok: true });
      } catch (error) {
        ack?.(ackError(error));
      }
    });

    socket.on('room:unwatch', async (payload: { roomId?: number }, ack?: (res: unknown) => void) => {
      try {
        const roomId = Number(payload?.roomId);
        if (!Number.isInteger(roomId) || roomId <= 0) {
          throw new ApiError(400, 'INVALID_ROOM_ID', 'Invalid room id');
        }
        await socket.leave(roomKey(roomId));
        ack?.({ ok: true });
      } catch (error) {
        ack?.(ackError(error));
      }
    });

    socket.on('room:leave', async (payload: { roomId?: number }, ack?: (res: unknown) => void) => {
      try {
        const roomId = Number(payload?.roomId);
        if (!Number.isInteger(roomId) || roomId <= 0) {
          throw new ApiError(400, 'INVALID_ROOM_ID', 'Invalid room id');
        }
        await socket.leave(roomKey(roomId));
        joinedRooms.delete(roomId);
        const last = removeSocket(roomId, user.id, socket.id);
        if (last) {
          io.to(roomKey(roomId)).emit('presence', {
            roomId,
            onlineUserIds: onlineUserIds(roomId),
          });
        }
        ack?.({ ok: true });
      } catch (error) {
        ack?.(ackError(error));
      }
    });

    socket.on(
      'message:send',
      async (
        payload: {
          roomId?: number;
          content?: string;
          clientMsgId?: string;
          replyToId?: number | null;
        },
        ack?: (res: unknown) => void,
      ) => {
        try {
          const roomId = Number(payload?.roomId);
          const content = typeof payload?.content === 'string' ? payload.content.trim() : '';
          const clientMsgId =
            typeof payload?.clientMsgId === 'string' ? payload.clientMsgId : undefined;
          const replyToId =
            typeof payload?.replyToId === 'number' && Number.isInteger(payload.replyToId)
              ? payload.replyToId
              : null;
          if (!Number.isInteger(roomId) || roomId <= 0) {
            throw new ApiError(400, 'INVALID_ROOM_ID', 'Invalid room id');
          }
          if (content.length === 0 || content.length > 4000) {
            throw new ApiError(400, 'INVALID_CONTENT', 'Message must be 1-4000 characters');
          }
          await assertMember(roomId, user.id);
          if (replyToId != null && !(await messageExistsInRoom(replyToId, roomId))) {
            throw new ApiError(400, 'INVALID_REPLY_TARGET', 'Reply target not found in this room');
          }
          if (!checkRate(`msg:${user.id}:${roomId}`, 10, 10_000)) {
            throw new ApiError(429, 'RATE_LIMITED', 'Too many messages');
          }
          const message = await createMessage({
            roomId,
            senderId: user.id,
            senderType: 'user',
            content,
            clientMsgId,
            replyToId,
          });
          if (!message.duplicate) {
            io.to(roomKey(roomId)).emit('message:new', { roomId, message });
          }
          ack?.({ ok: true, message });
          if (!message.duplicate) {
            void gateway.onUserMessage(roomId, message).catch((error) => {
              logger.error({ err: error, roomId }, 'bot trigger failed');
            });
          }
        } catch (error) {
          ack?.(ackError(error));
        }
      },
    );

    socket.on(
      'typing',
      async (payload: { roomId?: number; isTyping?: boolean }, ack?: (res: unknown) => void) => {
        try {
          const roomId = Number(payload?.roomId);
          if (!Number.isInteger(roomId) || roomId <= 0) {
            throw new ApiError(400, 'INVALID_ROOM_ID', 'Invalid room id');
          }
          await assertMember(roomId, user.id);
          socket.to(roomKey(roomId)).emit('typing', {
            roomId,
            userId: user.id,
            displayName: user.displayName,
            isTyping: Boolean(payload?.isTyping),
          });
          ack?.({ ok: true });
        } catch (error) {
          ack?.(ackError(error));
        }
      },
    );

    socket.on('disconnect', () => {
      for (const roomId of joinedRooms) {
        const last = removeSocket(roomId, user.id, socket.id);
        if (last) {
          io.to(roomKey(roomId)).emit('presence', {
            roomId,
            onlineUserIds: onlineUserIds(roomId),
          });
        }
      }
      joinedRooms.clear();
    });
  });
}
