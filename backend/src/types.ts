export type UserType = 'human' | 'bot';
export type UserRole = 'admin' | 'user';
export type UserStatus = 'active' | 'banned';
export type SenderType = 'user' | 'bot' | 'system';
export type MessageStatus = 'done' | 'streaming' | 'error';
/** A message is either plain text or the host of a poll. */
export type MessageKind = 'text' | 'poll';

export interface AuthUser {
  id: number;
  username: string;
  displayName: string;
  avatar: string | null;
  type: UserType;
  role: UserRole;
  status: UserStatus;
  /**
   * Revocation counter mirrored in the token's `ver` claim. Tokens signed with
   * an older version are rejected by the auth middleware, so bumping this value
   * logs the account out everywhere at once.
   */
  tokenVersion: number;
  /**
   * Self-described status shown next to the display name: a short emoji plus a
   * short line of text, both NULL when unset. Optional on the type because the
   * auth middleware resolves tokens from the identity columns alone; every
   * endpoint that answers with a user loads the columns and sends `null`.
   */
  statusEmoji?: string | null;
  statusText?: string | null;
}

export interface MessageForwardOrigin {
  roomId: number | null;
  roomName: string;
  senderName: string;
}

export interface MessageReaction {
  emoji: string;
  count: number;
  userIds: number[];
}

/** Open Graph metadata of the first URL in a message. */
export interface MessagePreview {
  url: string;
  title: string;
  description: string;
  site: string;
}

export interface PollOptionDTO {
  id: number;
  label: string;
  count: number;
  userIds: number[];
}

export interface PollDTO {
  id: number;
  question: string;
  multiple: boolean;
  /**
   * Anonymous polls keep their tally but never expose voter ids: every
   * option's `userIds` stays empty and each member reads their own selection
   * through the my-votes endpoint instead.
   */
  anonymous: boolean;
  closesAt: string | null;
  /** Computed by the server on read: `closesAt` has passed. */
  closed: boolean;
  /** Distinct members who voted for at least one option. */
  totalVotes: number;
  options: PollOptionDTO[];
}

/** A file uploaded to a room and (optionally) pinned to one message. */
export interface AttachmentDTO {
  id: number;
  filename: string;
  mime: string;
  size: number;
  /** Same-origin download path: `/api/rooms/<roomId>/attachments/<id>`. */
  url: string;
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
  kind: MessageKind;
  /** Populated only for `kind === 'poll'`; null on text (and withdrawn) rows. */
  poll: PollDTO | null;
  /** Files bound to this message; empty on withdrawn rows and plain messages. */
  attachments: AttachmentDTO[];
  status: MessageStatus;
  replyToId: number | null;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
  pinned: boolean;
  pinnedBy: number | null;
  forwardedFrom: MessageForwardOrigin | null;
  preview: MessagePreview | null;
  reactions: MessageReaction[];
}

export interface NotificationDTO {
  id: number;
  type: string;
  roomId: number;
  roomName: string;
  messageId: number | null;
  messageSeq: number | null;
  actorName: string;
  content: string;
  createdAt: string;
  readAt: string | null;
}

export interface RoomSummary {
  id: number;
  name: string;
  topic: string;
  announcement: string;
  /** Minimum gap in seconds between two messages of one member; 0 = off. */
  slowModeSeconds: number;
  /** Days messages are kept; 0 = keep forever. Pinned messages are exempt. */
  retentionDays: number;
  createdAt: string;
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
  muted: boolean;
  favorite: boolean;
  group: string | null;
  /** Per-user archive flag: archived rooms are hidden from the default sidebar. */
  archived: boolean;
}

export interface MemberDTO {
  userId: number;
  username: string;
  displayName: string;
  avatar: string | null;
  type: UserType;
  role: 'owner' | 'admin' | 'member' | 'bot';
  online: boolean;
  /**
   * Last time the member's socket connected or dropped. Null when they have not
   * been online since the column existed, so clients can tell "offline since
   * Tuesday" from "never seen".
   */
  lastSeenAt: string | null;
  /** Custom status of the member; bots never have one. */
  statusEmoji: string | null;
  statusText: string | null;
  joinedAt: string;
  /** Highest message seq this member has read; 0 means "nothing read". */
  lastReadSeq: number;
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
