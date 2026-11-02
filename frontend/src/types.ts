export interface User {
  id: number;
  username: string;
  displayName: string;
  avatar: string | null;
  type: 'human' | 'bot';
  role: 'admin' | 'user';
  // User-authored presence line: a short emoji plus a short text. Both are
  // optional and stored as NULL when the user clears them.
  statusEmoji: string | null;
  statusText: string | null;
}

export interface AdminUser {
  id: number;
  username: string;
  displayName: string;
  avatar: string | null;
  type: 'human' | 'bot';
  role: 'admin' | 'user';
  status: 'active' | 'banned';
  statusEmoji: string | null;
  statusText: string | null;
  createdAt: string;
}

// Platform-wide notice posted by an admin. `GET /announcements/current` only
// ever returns the newest active one (or null), so the banner never queues.
export interface Announcement {
  id: number;
  body: string;
  actorName: string;
  createdAt: string;
}

// The admin history keeps deactivated posts, so it also reports the flag.
export interface AdminAnnouncement extends Announcement {
  active: boolean;
}

export interface AuditEntry {
  id: number;
  actorId: number;
  actorName: string;
  action: string;
  targetType: string;
  targetId: number | null;
  detail: unknown;
  createdAt: string;
}

export interface RoomSummary {
  id: number;
  name: string;
  topic: string;
  announcement: string;
  // Minimum seconds between two messages from the same member; 0 = off.
  slowModeSeconds: number;
  // How long ordinary messages are kept; 0 = forever. Pinned messages are
  // never cleaned up, and the sweep runs on an interval, so deletion may lag.
  retentionDays: number;
  createdAt: string;
  muted: boolean;
  favorite: boolean;
  // Archiving is per member, like `favorite`: the room stays joined, it just
  // leaves the default rail. Public rooms the viewer has not joined report false.
  archived: boolean;
  group: string | null;
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

// `GET /rooms`: the viewer's rooms plus the newest window of public rooms.
// That window is capped server-side, so `publicTotal` is the real count.
export interface RoomListResponse {
  mine: RoomSummary[];
  public: RoomSummary[];
  publicTotal: number;
}

// `GET /rooms/public`: server-side search over public rooms the viewer has not
// joined yet, newest first.
export interface PublicRoomPage {
  rooms: RoomSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface Reaction {
  emoji: string;
  count: number;
  userIds: number[];
}

export interface PollOption {
  id: number;
  label: string;
  count: number;
  userIds: number[];
}

// A poll rides on a normal message row (`kind === 'poll'`): `content` mirrors
// the question so previews and notifications need no special case, while
// `poll` carries the tallies. `closed` is computed by the server from
// `closesAt` at response time, and `totalVotes` counts distinct voters.
// Anonymous polls never expose per-option voters: `userIds` stays empty for
// everyone, and the viewer's own ballot comes from the my-votes endpoint.
export interface Poll {
  id: number;
  question: string;
  multiple: boolean;
  anonymous: boolean;
  closesAt: string | null;
  closed: boolean;
  totalVotes: number;
  options: PollOption[];
}

export interface ForwardedFrom {
  roomId: number | null;
  roomName: string;
  senderName: string;
}

// A file uploaded to a room and bound to a message. The original `filename` is
// display-only; `url` points at the authenticated download route, so the client
// fetches it through `http` (a plain href would not carry the bearer token).
export interface Attachment {
  id: number;
  filename: string;
  mime: string;
  size: number;
  url: string;
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
  kind: 'text' | 'poll';
  status: 'done' | 'streaming' | 'error';
  replyToId: number | null;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
  pinned: boolean;
  pinnedBy: number | null;
  forwardedFrom: ForwardedFrom | null;
  preview: LinkPreview | null;
  reactions: Reaction[];
  poll: Poll | null;
  attachments: Attachment[];
}

export interface LinkPreview {
  url: string;
  title: string;
  description: string;
  site: string;
}

export interface GlobalMessage extends Message {
  roomName: string;
}

// A message the viewer bookmarked, from `GET /me/saved`. The message keeps
// the normal DTO shape — a withdrawn row arrives as `deleted` with an empty
// body — and `savedAt` orders the list newest first.
export interface SavedMessage {
  message: Message;
  roomName: string;
  savedAt: string;
}

// A queued delivery owned by the viewer. `POST /rooms/:id/messages/schedule`
// returns the created row; `GET /rooms/:id/messages/scheduled` lists the
// pending ones soonest first. `sendAt` is an ISO timestamp from the server.
export interface ScheduledMessage {
  id: number;
  content: string;
  sendAt: string;
  createdAt: string;
}

export interface NotificationItem {
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

// Notification scope is synced per account so every device agrees; the
// browser's localStorage copy only covers offline/failed requests.
// `dndStart`/`dndEnd` are local wall-clock "HH:MM" strings, or null when the
// do-not-disturb window is off. `dndAllowMentions` lets @mentions break it.
export interface NotificationSettings {
  notifyMode: 'all' | 'mention';
  dndStart: string | null;
  dndEnd: string | null;
  dndAllowMentions: boolean;
}

export interface JoinRequest {
  userId: number;
  username: string;
  displayName: string;
  createdAt: string;
}

export interface Member {
  userId: number;
  username: string;
  displayName: string;
  avatar: string | null;
  type: 'human' | 'bot';
  role: 'owner' | 'admin' | 'member' | 'bot';
  online: boolean;
  // Last socket connect/disconnect timestamp; null when the account never connected.
  lastSeenAt: string | null;
  // Optional self-described status; bots never have one.
  statusEmoji: string | null;
  statusText: string | null;
  joinedAt: string;
  // Highest message seq this member has read; drives own-message receipts.
  lastReadSeq: number;
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
