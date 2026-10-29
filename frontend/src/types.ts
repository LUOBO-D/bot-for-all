export interface User {
  id: number;
  username: string;
  displayName: string;
  avatar: string | null;
  type: 'human' | 'bot';
  role: 'admin' | 'user';
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

export interface Reaction {
  emoji: string;
  count: number;
  userIds: number[];
}

export interface Message {
  id: number;
  seq: number;
  roomId: number;
  senderId: number;
  senderType: 'user' | 'bot' | 'system';
  senderName: string;
  senderAvatar: string | null;
  content: string;
  status: 'done' | 'streaming' | 'error';
  replyToId: number | null;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
  pinned: boolean;
  pinnedBy: number | null;
  reactions: Reaction[];
}

export interface Member {
  userId: number;
  username: string;
  displayName: string;
  avatar: string | null;
  type: 'human' | 'bot';
  role: 'owner' | 'admin' | 'member' | 'bot';
  online: boolean;
}

export interface Bot {
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
