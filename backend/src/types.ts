export type UserType = 'human' | 'bot';
export type UserRole = 'admin' | 'user';
export type UserStatus = 'active' | 'banned';
export type SenderType = 'user' | 'bot' | 'system';
export type MessageStatus = 'done' | 'streaming' | 'error';

export interface AuthUser {
  id: number;
  username: string;
  displayName: string;
  avatar: string | null;
  type: UserType;
  role: UserRole;
  status: UserStatus;
}

export interface MessageReaction {
  emoji: string;
  count: number;
  userIds: number[];
}

export interface MessageDTO {
  id: number;
  seq: number;
  roomId: number;
  senderId: number;
  senderType: SenderType;
  senderName: string;
  senderAvatar: string | null;
  content: string;
  status: MessageStatus;
  replyToId: number | null;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
  pinned: boolean;
  pinnedBy: number | null;
  reactions: MessageReaction[];
}

export interface RoomSummary {
  id: number;
  name: string;
  topic: string;
  ownerId: number;
  isPublic: boolean;
  inviteCode: string | null;
  memberCount: number;
  unreadCount: number;
  lastMessage: {
    seq: number;
    content: string;
    senderName: string;
    createdAt: string;
  } | null;
  joined: boolean;
}

export interface MemberDTO {
  userId: number;
  username: string;
  displayName: string;
  avatar: string | null;
  type: UserType;
  role: 'owner' | 'admin' | 'member' | 'bot';
  online: boolean;
}

export interface BotRow {
  userId: number;
  username: string;
  name: string;
  baseUrl: string;
  apiKeyEncrypted: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  triggerMode: 'mention' | 'all';
  scope: 'global' | 'room';
  roomId: number | null;
  temperature: number;
  maxTokens: number;
  extraBody: Record<string, unknown> | null;
  enabled: boolean;
  ownerUserId: number;
  createdAt: string;
}

export interface BotDTO {
  userId: number;
  username: string;
  name: string;
  baseUrl: string;
  apiKeyMasked: string;
  model: string;
  systemPrompt: string;
  triggerMode: 'mention' | 'all';
  scope: 'global' | 'room';
  roomId: number | null;
  temperature: number;
  maxTokens: number;
  extraBody: Record<string, unknown> | null;
  enabled: boolean;
  ownerUserId: number;
  createdAt: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export {};
