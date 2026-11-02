import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import type { BotGateway } from '../bot/gateway';
import { ApiError } from '../errors';
import { logger } from '../logger';
import { getUserFromToken } from '../middleware/auth';
import { checkRate } from '../middleware/ratelimit';
import { attachLinkPreview } from '../services/link-preview';
import {
  createMessage,
  getLastUserMessageAt,
  messageExistsInRoom,
  normalizeAttachmentIds,
} from '../services/message';
import { notifyMentions, userRoom } from '../services/notifications';
import { addSocket, onlineUserIds, removeSocket } from '../services/presence';
import { assertMember, getRoomMaxSeq, getRoomSlowMode, touchRead } from '../services/room';
import { touchLastSeen } from '../services/user';
import type { AuthUser } from '../types';
import { getSocketServer, setSocketServer } from './broadcast';

export function roomKey(roomId: number): string {
  return `room:${roomId}`;
}

function ackError(error: unknown): { ok: false; code: string; message: string } {
  if (error instanceof ApiError) {
    return { ok: false, code: error.code, message: error.message };
  }
  logger.error({ err: error }, 'socket handler failed');
  return { ok: false, code: 'INTERNAL', message: 'Internal error' };
}

/**
 * Aborts every live bot generation of `roomId`. The whole room is told why the
 * reply stopped, so clients can drop their "stop" affordance without guessing.
 */
function stopBots(io: Server, gateway: BotGateway, roomId: number): boolean {
  const canceled = gateway.cancelRoom(roomId) > 0;
  if (canceled) {
    io.to(roomKey(roomId)).emit('system:notice', {
      roomId,
      code: 'BOT_STOPPED',
      message: '已停止机器人回复',
    });
  }
  return canceled;
}

/**
 * Best-effort "last seen" bookkeeping. A failed write must never take the
 * connection (or its disconnect cleanup) down with it, so it is fire-and-forget.
 */
function markSeen(userId: number): void {
  void touchLastSeen(userId).catch((error) => {
    logger.warn({ err: error, userId }, 'failed to update last seen');
  });
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
    const lastSocket = await removeSocket(roomId, userId, socket.id);
    socket.emit('room:revoked', { roomId });
    if (lastSocket) {
      io.to(roomKey(roomId)).emit('presence', {
        roomId,
        onlineUserIds: await onlineUserIds(roomId),
      });
    }
  }
}

/**
 * Kills every live socket of `userId` after a REST-side session revocation
 * (ban, password change, logout-all). Sockets authenticate once at handshake, so without this
 * an already-open connection keeps receiving and sending messages. The reason
 * is emitted first so clients can tell a revocation from a network drop;
 * clients that still hold a valid token reconnect on their own.
 */
export async function disconnectUserSockets(userId: number, reason: string): Promise<void> {
  const io = getSocketServer();
  if (!io) {
    return;
  }
  try {
    const sockets = await io.in(userRoom(userId)).fetchSockets();
    for (const socket of sockets) {
      socket.emit('session:revoked', { reason });
      socket.disconnect(true);
    }
  } catch (error) {
    // The revocation is already committed; a socket-adapter hiccup must not
    // turn a successful ban or logout into a 500.
    logger.warn({ err: error, userId, reason }, 'failed to disconnect user sockets');
  }
}

export function registerSocketHandlers(io: Server, gateway: BotGateway): void {
  io.on('connection', (socket) => {
    const user = socket.data.user as AuthUser;
    const joinedRooms = socket.data.rooms as Set<number>;

    // Every live socket of a user joins `user:<id>` so notifications reach
    // them regardless of which rooms they have open.
    void socket.join(userRoom(user.id));
    markSeen(user.id);

    socket.on('room:join', async (payload: { roomId?: number; read?: boolean }, ack?: (res: unknown) => void) => {
      try {
        const roomId = Number(payload?.roomId);
        if (!Number.isInteger(roomId) || roomId <= 0) {
          throw new ApiError(400, 'INVALID_ROOM_ID', 'Invalid room id');
        }
        await assertMember(roomId, user.id);
        await socket.join(roomKey(roomId));
        joinedRooms.add(roomId);
        await addSocket(roomId, user.id, socket.id);
        if (payload?.read !== false) {
          // touchRead writes rooms.max_seq into the member row, so it must run
          // before lastSeq is read for the broadcast to advertise the cursor we
          // actually stored.
          await touchRead(roomId, user.id);
        }
        const lastSeq = await getRoomMaxSeq(roomId);
        if (payload?.read !== false) {
          io.to(roomKey(roomId)).emit('read:updated', {
            roomId,
            userId: user.id,
            seq: lastSeq,
          });
        }
        ack?.({ ok: true, lastSeq });
        io.to(roomKey(roomId)).emit('presence', {
          roomId,
          onlineUserIds: await onlineUserIds(roomId),
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
        const last = await removeSocket(roomId, user.id, socket.id);
        if (last) {
          io.to(roomKey(roomId)).emit('presence', {
            roomId,
            onlineUserIds: await onlineUserIds(roomId),
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
          attachmentIds?: unknown;
        },
        ack?: (res: unknown) => void,
      ) => {
        try {
          const roomId = Number(payload?.roomId);
          const content = typeof payload?.content === 'string' ? payload.content.trim() : '';
          const clientMsgId =
            typeof payload?.clientMsgId === 'string' ? payload.clientMsgId : undefined;
          const attachmentIds = normalizeAttachmentIds(payload?.attachmentIds);
          const replyToId =
            typeof payload?.replyToId === 'number' && Number.isInteger(payload.replyToId)
              ? payload.replyToId
              : null;
          if (!Number.isInteger(roomId) || roomId <= 0) {
            throw new ApiError(400, 'INVALID_ROOM_ID', 'Invalid room id');
          }
          // `/stop` is a control command, not a message: it aborts the room's
          // live generations and never creates a row, so it bypasses the
          // content checks, the idempotency key and the message rate limit.
          if (content === '/stop') {
            await assertMember(roomId, user.id);
            ack?.({ ok: true, stopped: stopBots(io, gateway, roomId) });
            return;
          }
          if (content.length > 4000) {
            throw new ApiError(400, 'INVALID_CONTENT', 'Message must be at most 4000 characters');
          }
          if (content.length === 0 && attachmentIds.length === 0) {
            throw new ApiError(
              400,
              'INVALID_CONTENT',
              'Message must have text or at least one attachment',
            );
          }
          await assertMember(roomId, user.id);
          // Slow mode is a room setting, not a global rate-limit toggle: compare
          // against the member's latest message so it still enforces when
          // RATE_LIMIT_ENABLED=false and survives process restarts.
          const slowModeSeconds = await getRoomSlowMode(roomId);
          if (slowModeSeconds > 0) {
            const lastAt = await getLastUserMessageAt(roomId, user.id);
            const elapsed = lastAt == null ? Infinity : Date.now() - lastAt;
            const windowMs = slowModeSeconds * 1000;
            if (elapsed < windowMs) {
              const wait = Math.ceil((windowMs - elapsed) / 1000);
              throw new ApiError(
                429,
                'SLOW_MODE',
                `慢速模式：每 ${slowModeSeconds} 秒只能发送一条消息（还需等待 ${wait} 秒）`,
              );
            }
          }
          if (replyToId != null && !(await messageExistsInRoom(replyToId, roomId))) {
            throw new ApiError(400, 'INVALID_REPLY_TARGET', 'Reply target not found in this room');
          }
          if (!(await checkRate(`msg:${user.id}:${roomId}`, 10, 10_000))) {
            throw new ApiError(429, 'RATE_LIMITED', 'Too many messages');
          }
          const message = await createMessage({
            roomId,
            senderId: user.id,
            senderType: 'user',
            content,
            clientMsgId,
            replyToId,
            attachmentIds,
          });
          if (!message.duplicate) {
            io.to(roomKey(roomId)).emit('message:new', { roomId, message });
            void attachLinkPreview(io, roomId, message);
            void notifyMentions(io, roomId, message, {
              id: user.id,
              name: user.displayName,
            }).catch((error) => {
              logger.error({ err: error, roomId }, 'mention notification failed');
            });
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
      'bot:stop',
      async (payload: { roomId?: number }, ack?: (res: unknown) => void) => {
        try {
          const roomId = Number(payload?.roomId);
          if (!Number.isInteger(roomId) || roomId <= 0) {
            throw new ApiError(400, 'INVALID_ROOM_ID', 'Invalid room id');
          }
          await assertMember(roomId, user.id);
          ack?.({ ok: true, canceled: stopBots(io, gateway, roomId) });
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

    socket.on('disconnect', async () => {
      for (const roomId of joinedRooms) {
        const last = await removeSocket(roomId, user.id, socket.id);
        if (last) {
          io.to(roomKey(roomId)).emit('presence', {
            roomId,
            onlineUserIds: await onlineUserIds(roomId),
          });
        }
      }
      joinedRooms.clear();
      markSeen(user.id);
    });
  });
}
