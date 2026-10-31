import { Router, type Request } from 'express';
import { z } from 'zod';
import { badRequest, forbidden, tooMany } from '../errors';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/error';
import { checkRate } from '../middleware/ratelimit';
import {
  deleteMessage,
  editMessage,
  listMessages,
  listPinned,
  pinMessage,
  searchMessages,
  toggleReaction,
  unpinMessage,
} from '../services/message';
import {
  assertMember,
  createRoom,
  getRoomOwnerId,
  joinRoom,
  leaveRoom,
  listMembers,
  listRooms,
  updateReadCursor,
  updateRoom,
} from '../services/room';
import { evictUserFromRoom } from '../socket';
import { broadcastMessageUpdated, getSocketServer } from '../socket/broadcast';
import type { AuthUser } from '../types';

const router = Router();

router.use(requireAuth);

const createRoomSchema = z.object({
  name: z.string().min(1).max(64),
  topic: z.string().max(255).optional(),
  isPublic: z.boolean().optional(),
});

const updateRoomSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  topic: z.string().max(255).optional(),
});

const joinSchema = z.object({
  inviteCode: z.string().min(1).max(16).optional(),
});

const readSchema = z.object({
  seq: z.number().int().nonnegative(),
});

const searchSchema = z.object({
  q: z.string().trim().min(1).max(100),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

const listQuerySchema = z.object({
  beforeSeq: z.coerce.number().int().positive().optional(),
  afterSeq: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const editMessageSchema = z.object({
  content: z.string().trim().min(1).max(4000),
});

const reactionSchema = z.object({
  emoji: z.string().trim().min(1).max(16),
});

const pinsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

function currentUser(req: Request): AuthUser {
  return req.user as AuthUser;
}

function parseRoomId(req: Request): number {
  const roomId = Number(req.params.id);
  if (!Number.isInteger(roomId) || roomId <= 0) {
    throw badRequest('INVALID_ROOM_ID', 'Invalid room id');
  }
  return roomId;
}

function parseSeq(req: Request): number {
  const seq = Number(req.params.seq);
  if (!Number.isInteger(seq) || seq <= 0) {
    throw badRequest('INVALID_SEQ', 'Invalid message seq');
  }
  return seq;
}

async function assertModerator(roomId: number, user: AuthUser): Promise<void> {
  if (user.role === 'admin') {
    return;
  }
  const ownerId = await getRoomOwnerId(roomId);
  if (ownerId !== user.id) {
    throw forbidden('ROOM_OWNER_REQUIRED', 'Only the room owner can moderate this room');
  }
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(await listRooms(currentUser(req).id));
  }),
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const parsed = createRoomSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('INVALID_INPUT', parsed.error.issues[0]?.message ?? 'Invalid input');
    }
    const user = currentUser(req);
    if (!checkRate(`room:create:${user.id}`, 5, 60_000)) {
      throw tooMany('Too many rooms created, try again later');
    }
    const room = await createRoom(user.id, parsed.data);
    res.status(201).json({ room });
  }),
);

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const parsed = updateRoomSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('INVALID_INPUT', parsed.error.issues[0]?.message ?? 'Invalid input');
    }
    if (parsed.data.name === undefined && parsed.data.topic === undefined) {
      throw badRequest('INVALID_INPUT', 'Nothing to update');
    }
    const user = currentUser(req);
    const room = await updateRoom(parseRoomId(req), user.id, user.role, parsed.data);
    res.json({ room });
  }),
);

router.post(
  '/:id/read',
  asyncHandler(async (req, res) => {
    const roomId = parseRoomId(req);
    const parsed = readSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('INVALID_INPUT', 'seq must be a non-negative integer');
    }
    const user = currentUser(req);
    await assertMember(roomId, user.id);
    await updateReadCursor(roomId, user.id, parsed.data.seq);
    res.json({ ok: true });
  }),
);

router.post(
  '/:id/join',
  asyncHandler(async (req, res) => {
    const parsed = joinSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw badRequest('INVALID_INPUT', 'Invalid invite code');
    }
    const roomId = parseRoomId(req);
    const user = currentUser(req);
    // Per user+room: joining is idempotent, so the only reason to hammer it is
    // guessing a private room's invite code.
    if (!checkRate(`room:join:${user.id}:${roomId}`, 10, 60_000)) {
      throw tooMany('Too many join attempts for this room, try again later');
    }
    const room = await joinRoom(user.id, roomId, parsed.data.inviteCode);
    res.json({ room });
  }),
);

router.post(
  '/:id/leave',
  asyncHandler(async (req, res) => {
    const roomId = parseRoomId(req);
    const user = currentUser(req);
    await leaveRoom(user.id, roomId);
    const io = getSocketServer();
    if (io) {
      await evictUserFromRoom(io, roomId, user.id);
    }
    res.json({ ok: true });
  }),
);

router.get(
  '/:id/members',
  asyncHandler(async (req, res) => {
    const roomId = parseRoomId(req);
    await assertMember(roomId, currentUser(req).id);
    res.json({ members: await listMembers(roomId) });
  }),
);

router.get(
  '/:id/search',
  asyncHandler(async (req, res) => {
    const roomId = parseRoomId(req);
    await assertMember(roomId, currentUser(req).id);
    const parsed = searchSchema.safeParse(req.query);
    if (!parsed.success) {
      throw badRequest('INVALID_INPUT', 'q must be 1-100 characters');
    }
    const messages = await searchMessages(roomId, parsed.data.q, parsed.data.limit ?? 20);
    res.json({ messages });
  }),
);

router.get(
  '/:id/messages',
  asyncHandler(async (req, res) => {
    const roomId = parseRoomId(req);
    await assertMember(roomId, currentUser(req).id);
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw badRequest('INVALID_INPUT', 'Invalid pagination parameters');
    }
    const result = await listMessages(roomId, parsed.data);
    res.json(result);
  }),
);

router.patch(
  '/:id/messages/:seq',
  asyncHandler(async (req, res) => {
    const roomId = parseRoomId(req);
    const seq = parseSeq(req);
    const user = currentUser(req);
    await assertMember(roomId, user.id);
    const parsed = editMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('INVALID_INPUT', 'content must be 1-4000 characters');
    }
    const message = await editMessage(roomId, seq, user.id, parsed.data.content);
    broadcastMessageUpdated(roomId, message);
    res.json({ message });
  }),
);

router.delete(
  '/:id/messages/:seq',
  asyncHandler(async (req, res) => {
    const roomId = parseRoomId(req);
    const seq = parseSeq(req);
    const user = currentUser(req);
    await assertMember(roomId, user.id);
    const canModerate = user.role === 'admin' || (await getRoomOwnerId(roomId)) === user.id;
    const message = await deleteMessage(roomId, seq, user.id, canModerate);
    broadcastMessageUpdated(roomId, message);
    res.json({ message });
  }),
);

router.post(
  '/:id/messages/:seq/reactions',
  asyncHandler(async (req, res) => {
    const roomId = parseRoomId(req);
    const seq = parseSeq(req);
    const user = currentUser(req);
    await assertMember(roomId, user.id);
    const parsed = reactionSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('INVALID_INPUT', 'emoji must be 1-16 characters');
    }
    const message = await toggleReaction(roomId, seq, user.id, parsed.data.emoji);
    broadcastMessageUpdated(roomId, message);
    res.json({ message });
  }),
);

router.post(
  '/:id/messages/:seq/pin',
  asyncHandler(async (req, res) => {
    const roomId = parseRoomId(req);
    const seq = parseSeq(req);
    const user = currentUser(req);
    await assertMember(roomId, user.id);
    await assertModerator(roomId, user);
    const message = await pinMessage(roomId, seq, user.id);
    broadcastMessageUpdated(roomId, message);
    res.json({ message });
  }),
);

router.delete(
  '/:id/messages/:seq/pin',
  asyncHandler(async (req, res) => {
    const roomId = parseRoomId(req);
    const seq = parseSeq(req);
    const user = currentUser(req);
    await assertMember(roomId, user.id);
    await assertModerator(roomId, user);
    const message = await unpinMessage(roomId, seq);
    broadcastMessageUpdated(roomId, message);
    res.json({ message });
  }),
);

router.get(
  '/:id/pins',
  asyncHandler(async (req, res) => {
    const roomId = parseRoomId(req);
    await assertMember(roomId, currentUser(req).id);
    const parsed = pinsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw badRequest('INVALID_INPUT', 'Invalid limit');
    }
    res.json({ messages: await listPinned(roomId, parsed.data.limit ?? 20) });
  }),
);

export default router;
