import { ElMessage } from 'element-plus';
import { defineStore } from 'pinia';
import type { Socket } from 'socket.io-client';
import http, { errorMessage } from '../api/http';
import router from '../router';
import { getSocket } from '../socket';
import type {
  Attachment,
  Member,
  Message,
  NotificationItem,
  NotificationSettings,
  RoomListResponse,
  RoomSummary,
} from '../types';
import { plainPreview } from '../utils/format';
import { useAuthStore } from './auth';

interface TypingUser {
  userId: number;
  displayName: string;
  at: number;
}

interface ChatState {
  rooms: { mine: RoomSummary[]; public: RoomSummary[] };
  // Server-side count of public rooms the viewer has not joined; the
  // `rooms.public` window itself is capped, so its length is not the total.
  publicTotal: number;
  currentRoomId: number | null;
  messages: Record<number, Message[]>;
  // Anonymous polls carry no voters in `userIds`, so the viewer's own ballot
  // is fetched on demand. Keyed by poll id (globally unique), and reset with
  // the rest of the state on logout so another account never sees it.
  pollMyVotes: Record<number, number[]>;
  lastSeq: Record<number, number>;
  lastReadSent: Record<number, number>;
  hasMore: Record<number, boolean>;
  loadingOlder: Record<number, boolean>;
  unreadMarker: Record<number, number>;
  watchedRooms: number[];
  online: Record<number, number[]>;
  members: Record<number, Member[]>;
  typing: Record<number, TypingUser[]>;
  notifications: NotificationItem[];
  // Server-side size of the *filtered* list: `notifications` only holds the
  // pages fetched so far, so its length says nothing about what is left.
  notificationsTotal: number;
  notificationsUnread: number;
  notificationsLoadingMore: boolean;
  notificationsFilter: NotificationFilter;
  notifyMode: NotifyMode;
  // The DND window is account-wide but evaluated locally: these are the
  // server's last known "HH:MM" ends, or null when DND is off.
  dndStart: string | null;
  dndEnd: string | null;
  dndAllowMentions: boolean;
  bound: boolean;
  loading: boolean;
  connected: boolean;
}

interface NewMessagePayload {
  roomId: number;
  message: Message;
}

interface DeltaPayload {
  roomId: number;
  seq: number;
  delta: string;
}

interface FinalPayload {
  roomId: number;
  seq: number;
  content: string;
  status: 'done' | 'error';
  error?: string;
}

interface UpdatedPayload {
  roomId: number;
  message: Message;
}

interface PresencePayload {
  roomId: number;
  onlineUserIds: number[];
}

interface ReadUpdatedPayload {
  roomId: number;
  userId: number;
  seq: number;
}

interface TypingPayload {
  roomId: number;
  userId: number;
  displayName: string;
  isTyping: boolean;
}

interface NoticePayload {
  roomId: number;
  code: string;
  message: string;
}

interface RevokedPayload {
  roomId: number;
}

interface RoomUpdatedPayload {
  roomId: number;
  name: string;
  topic: string;
  announcement: string;
  slowModeSeconds?: number;
}

interface OwnerChangedPayload {
  roomId: number;
  ownerId: number;
}

interface NotificationPayload {
  notification: NotificationItem;
}

const readTimers = new Map<number, number>();
const readPending = new Map<number, number>();

// Desktop notifications are batched per room: a burst of messages in one room
// must not stack a notification per line. The window starts at the first call
// and is not re-armed, so the user never waits longer than this for a toast.
const NOTIFY_BURST_MS = 700;

interface PendingNotify {
  timer: number;
  count: number;
  senderName: string;
  content: string;
  roomName: string;
  // Newest seq folded into this batch; the toast deep-links to it.
  seq: number | null;
}

const pendingNotifies = new Map<number, PendingNotify>();

// Per-device opt-in for the beep: no server round trip, and flipping it in the
// settings dialog applies to the next toast without a reload.
const NOTIFY_SOUND_KEY = 'bfa_notify_sound';

// Safari before 14.1 only exposes the prefixed constructor, which the DOM
// lib does not declare; the check keeps `new AudioCtor()` sound on engines
// where neither exists.
function prefixedAudioContext(scope: Window): typeof AudioContext | undefined {
  const prefixed = scope as Window & {
    webkitAudioContext?: typeof AudioContext;
  };
  return prefixed.webkitAudioContext;
}

// One throwaway AudioContext per beep, closed as soon as the tone ends:
// browsers cap live contexts (a handful per page), so a long-lived one would
// either run into that cap or hold the audio device open for the whole session.
function playNotifyBeep() {
  if (localStorage.getItem(NOTIFY_SOUND_KEY) !== '1') {
    return;
  }
  const AudioCtor = window.AudioContext ?? prefixedAudioContext(window);
  if (!AudioCtor) {
    return;
  }
  try {
    const context = new AudioCtor();
    let released = false;
    const release = () => {
      if (released) {
        return;
      }
      released = true;
      void context.close().catch(() => undefined);
    };
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = 880;
    const start = context.currentTime;
    // Ramped edges: a hard start/stop on a sine clicks.
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.06, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.12);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.onended = release;
    oscillator.start(start);
    oscillator.stop(start + 0.12);
    // A context the autoplay policy keeps suspended never fires `ended`; the
    // timer closes it anyway so the per-page cap is never reached.
    window.setTimeout(release, 1000);
  } catch {
    // No audio device, or the browser refused to start a context: stay silent
    // and let the toast do the talking.
  }
}

function flushNotify(roomId: number) {
  const pending = pendingNotifies.get(roomId);
  if (!pending) {
    return;
  }
  pendingNotifies.delete(roomId);
  const title =
    pending.count > 1
      ? `${pending.roomName} · ${pending.count} 条新消息`
      : `${pending.senderName} · ${pending.roomName}`;
  try {
    // The tag stays per room, so a later batch replaces this toast instead of
    // piling up next to it.
    const notification = new Notification(title, {
      body: pending.content.slice(0, 140),
      tag: `bfa-room-${roomId}`,
    });
    // Deep-link to the newest message of the batch: the room view loads
    // around that seq and highlights it. Batches without a message anchor
    // (join requests, bot replies with no row) just open the room.
    const target =
      pending.seq != null
        ? `/rooms/${roomId}?seq=${pending.seq}`
        : `/rooms/${roomId}`;
    notification.onclick = () => {
      window.focus();
      void router.push(target);
      notification.close();
    };
    playNotifyBeep();
  } catch {
    // Notification can fail in restricted contexts; ignore.
  }
}

// The bell list is a live tail: 20 rows from the API plus anything pushed
// while the tab is open. Cap it so a long session cannot grow unbounded; the
// unread count stays the server's number, not a count of these rows.
const NOTIFICATION_LIMIT = 50;

// The panel's chips narrow the list server-side; the unread badge stays the
// account-wide number, so a filter never changes what "全部已读" covers.
export type NotificationFilter = 'all' | 'mention' | 'join' | 'invite';

const NOTIFICATION_FILTER_TYPES: Record<NotificationFilter, readonly string[] | null> = {
  all: null,
  mention: ['mention'],
  join: ['join_request', 'join_approved', 'join_rejected'],
  invite: ['room_invite'],
};

function notificationMatchesFilter(
  type: string,
  filter: NotificationFilter,
): boolean {
  const types = NOTIFICATION_FILTER_TYPES[filter];
  return types === null || types.includes(type);
}

// A slow request for a filter the user already left must not land on top of
// the newer one (chips switch faster than the network).
let notificationsRequestId = 0;
// The last filter/list pair that actually loaded; a failed chip switch falls
// back to it rather than to an empty list under a chip that never resolved.
let notificationsSnapshot: {
  filter: NotificationFilter;
  items: NotificationItem[];
} | null = null;
// The page size of the list on screen: "load more" must append a page of the
// same height, even though the caller of the first load picked it.
let notificationsPageLimit = 20;

// The notification scope lives on the server so every device of the account
// agrees; localStorage is only the offline/failed-request fallback.
const NOTIFY_MODE_KEY = 'bfa_notify_mode';
type NotifyMode = NotificationSettings['notifyMode'];

// The DND window is wall-clock, not UTC: each device applies the same "HH:MM"
// pair to its own clock, so a travelling user gets their night where they are.
// `start > end` wraps midnight (e.g. 22:00–07:00). Start is inclusive, end is
// exclusive — 07:00 on the dot is already a normal morning.
const CLOCK_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function clockMinutes(value: string | null): number | null {
  if (value == null || !CLOCK_PATTERN.test(value)) {
    return null;
  }
  const [hours, minutes] = value.split(':');
  return Number(hours) * 60 + Number(minutes);
}

function inDndWindow(start: string | null, end: string | null, now: Date): boolean {
  const from = clockMinutes(start);
  const to = clockMinutes(end);
  if (from == null || to == null || from === to) {
    return false;
  }
  const current = now.getHours() * 60 + now.getMinutes();
  return from < to
    ? current >= from && current < to
    : current >= from || current < to;
}

// Server values are trusted for type but not shape: an older deployment or a
// malformed row must degrade to "DND off" instead of suppressing forever.
function normalizeClock(value: unknown): string | null {
  return typeof value === 'string' && CLOCK_PATTERN.test(value) ? value : null;
}

// The socket is a singleton that outlives store instances, so the binding's
// teardown lives here: `$reset()` clears state but cannot unhook listeners.
type SocketListener = Parameters<Socket['on']>[1];
let unbindSocket: (() => void) | null = null;
// A late GET /me/settings must not clobber a choice the user just made.
let settingsRequestId = 0;
// Room switches are async end to end (join ack, socket join, snapshot), so a
// fast A→B switch can finish A's chain after B already owns the view. Every
// openRoom run takes a generation; a stale run may leave cache behind but must
// never mark read, drop the loading flag, or toast over the new room.
let openRoomGeneration = 0;

function waitForSocketConnect(): Promise<void> {
  const socket = getSocket();
  if (socket.connected) {
    return Promise.resolve();
  }
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  let timer: number | undefined;
  const cleanup = () => {
    if (timer !== undefined) {
      window.clearTimeout(timer);
    }
    socket.off('connect', onConnect);
    socket.off('connect_error', onConnectError);
  };
  const onConnect = () => {
    cleanup();
    resolve();
  };
  const onConnectError = (error: Error) => {
    cleanup();
    reject(error);
  };
  timer = window.setTimeout(() => {
    cleanup();
    reject(new Error('连接超时'));
  }, 5000);
  socket.once('connect', onConnect);
  socket.once('connect_error', onConnectError);
  return promise;
}

const JOIN_ACK_TIMEOUT_MS = 8000;
const SEND_ACK_TIMEOUT_MS = 8000;
const STOP_ACK_TIMEOUT_MS = 8000;

// The button that asks for a stop toasts its own result; the server's
// broadcast notice for the same action would repeat it a moment later. Only
// the tab that initiated the stop suppresses the generic notice, and only for
// a short window so an unrelated BOT_STOPPED from another user still shows.
const STOP_NOTICE_QUIET_MS = 3000;
let localStopAt = 0;
// A gap repair walks pages of 200 until the server says there is no more.
// Cap it so a bogus/stale lastSeq (e.g. 0 on first entry) cannot replay the
// whole room history in an unbounded loop.
const MAX_GAP_PAGES = 25;
// The bulk-delete route takes at most 50 seqs per call; a longer selection is
// swept in order so one confirm still covers everything the moderator picked.
const BULK_DELETE_LIMIT = 50;

function joinSocket(roomId: number, read = true): Promise<void> {
  const socket = getSocket();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  let settled = false;
  let timer: number | undefined;
  const settle = (apply: () => void) => {
    if (settled) {
      return;
    }
    settled = true;
    if (timer !== undefined) {
      window.clearTimeout(timer);
    }
    apply();
  };
  timer = window.setTimeout(() => {
    settle(() => reject(new Error('加入房间超时，请重试')));
  }, JOIN_ACK_TIMEOUT_MS);
  socket.emit(
    'room:join',
    { roomId, read },
    (response: { ok?: boolean; message?: string }) => {
      if (response?.ok) {
        settle(resolve);
      } else {
        settle(() => reject(new Error(response?.message ?? '加入房间失败')));
      }
    },
  );
  return promise;
}

// crypto.randomUUID is only exposed in secure contexts; plain http on a LAN
// address leaves it undefined, so fall back to a RFC 4122 v4 string.
function makeClientMsgId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Mirrors the server's listRooms order for "mine": favourites first, then the
// most recent activity, then the newest id. A summary without a last message
// carries no activity timestamp, so those rooms fall back to id order.
function sortRoomsByActivity(list: RoomSummary[]): RoomSummary[] {
  return [...list].sort((left, right) => {
    if (left.favorite !== right.favorite) {
      return left.favorite ? -1 : 1;
    }
    if (left.lastMessage && right.lastMessage) {
      const leftAt = Date.parse(left.lastMessage.createdAt) || 0;
      const rightAt = Date.parse(right.lastMessage.createdAt) || 0;
      if (leftAt !== rightAt) {
        return rightAt - leftAt;
      }
    } else if (!left.lastMessage && !right.lastMessage) {
      const leftAt = Date.parse(left.createdAt) || 0;
      const rightAt = Date.parse(right.createdAt) || 0;
      if (leftAt !== rightAt) {
        return rightAt - leftAt;
      }
    } else {
      const leftAt = Date.parse(left.lastMessage?.createdAt ?? left.createdAt) || 0;
      const rightAt = Date.parse(right.lastMessage?.createdAt ?? right.createdAt) || 0;
      if (leftAt !== rightAt) {
        return rightAt - leftAt;
      }
    }
    return right.id - left.id;
  });
}

export const useChatStore = defineStore('chat', {
  state: (): ChatState => ({
    rooms: { mine: [], public: [] },
    publicTotal: 0,
    currentRoomId: null,
    messages: {},
    pollMyVotes: {},
    lastSeq: {},
    lastReadSent: {},
    hasMore: {},
    loadingOlder: {},
    unreadMarker: {},
    watchedRooms: [],
    online: {},
    members: {},
    typing: {},
    notifications: [],
    notificationsTotal: 0,
    notificationsUnread: 0,
    notificationsLoadingMore: false,
    notificationsFilter: 'all',
    notifyMode: localStorage.getItem(NOTIFY_MODE_KEY) === 'mention' ? 'mention' : 'all',
    dndStart: null,
    dndEnd: null,
    dndAllowMentions: true,
    bound: false,
    loading: false,
    connected: false,
  }),
  getters: {
    currentRoom(state): RoomSummary | null {
      if (state.currentRoomId == null) {
        return null;
      }
      return (
        state.rooms.mine.find((room) => room.id === state.currentRoomId) ??
        state.rooms.public.find((room) => room.id === state.currentRoomId) ??
        null
      );
    },
    currentMessages(state): Message[] {
      return state.currentRoomId == null ? [] : state.messages[state.currentRoomId] ?? [];
    },
    currentMembers(state): Member[] {
      return state.currentRoomId == null ? [] : state.members[state.currentRoomId] ?? [];
    },
    currentOnline(state): number[] {
      return state.currentRoomId == null ? [] : state.online[state.currentRoomId] ?? [];
    },
    typingUsers(state): TypingUser[] {
      return state.currentRoomId == null ? [] : state.typing[state.currentRoomId] ?? [];
    },
  },
  actions: {
    async loadRooms() {
      const { data } = await http.get<RoomListResponse>('/rooms');
      this.rooms = {
        mine: sortRoomsByActivity(data.mine),
        public: data.public,
      };
      this.publicTotal = data.publicTotal;
      const mineIds = new Set(data.mine.map((room) => room.id));
      for (const roomId of [...this.watchedRooms]) {
        if (!mineIds.has(roomId)) {
          this.unwatchRoom(roomId);
        }
      }
      this.watchRooms();
      this.updateTitle();
    },
    // Server is the source of truth for the notification scope: every device
    // of the account converges here. A failed request keeps the local value,
    // so offline use and older deployments still behave sensibly.
    async loadSettings() {
      const requestId = ++settingsRequestId;
      try {
        const { data } = await http.get<NotificationSettings>('/me/settings');
        if (requestId !== settingsRequestId) {
          return;
        }
        this.notifyMode = data.notifyMode === 'mention' ? 'mention' : 'all';
        localStorage.setItem(NOTIFY_MODE_KEY, this.notifyMode);
        this.dndStart = normalizeClock(data.dndStart);
        this.dndEnd = normalizeClock(data.dndEnd);
        this.dndAllowMentions = data.dndAllowMentions !== false;
      } catch {
        // Keep the locally stored mode.
      }
    },
    // Optimistic: the switch must respond instantly. A rejected PATCH restores
    // both the store and the localStorage fallback, then surfaces the error.
    async setNotifyMode(mode: NotifyMode) {
      const previous = this.notifyMode;
      const requestId = ++settingsRequestId;
      this.notifyMode = mode;
      localStorage.setItem(NOTIFY_MODE_KEY, mode);
      try {
        const { data } = await http.patch<NotificationSettings>('/me/settings', {
          notifyMode: mode,
        });
        if (requestId !== settingsRequestId) {
          return;
        }
        this.notifyMode = data.notifyMode === 'mention' ? 'mention' : 'all';
        localStorage.setItem(NOTIFY_MODE_KEY, this.notifyMode);
      } catch (error) {
        if (requestId === settingsRequestId) {
          this.notifyMode = previous;
          localStorage.setItem(NOTIFY_MODE_KEY, previous);
        }
        throw error;
      }
    },
    // Both DND ends travel together: the server rejects a half-set window, and
    // `null` on both turns DND off. No optimistic update — a two-field save
    // that rolls back halfway would be worse than a short wait. A rejected
    // PATCH leaves the store untouched and rethrows for the caller's toast.
    async saveDnd(start: string | null, end: string | null, allowMentions: boolean) {
      const requestId = ++settingsRequestId;
      const { data } = await http.patch<NotificationSettings>('/me/settings', {
        dndStart: start,
        dndEnd: end,
        dndAllowMentions: allowMentions,
      });
      if (requestId !== settingsRequestId) {
        return;
      }
      this.dndStart = normalizeClock(data.dndStart);
      this.dndEnd = normalizeClock(data.dndEnd);
      this.dndAllowMentions = data.dndAllowMentions !== false;
    },
    // The bell is auxiliary: a failed fetch must never interrupt the app, and
    // reconnect/panel-open simply retry. The server keeps the authoritative
    // unread total, so a stale local list self-heals on the next load.
    // `filter` narrows the rows server-side; switching it drops the old rows
    // first so the panel never shows one filter's list under another's chip.
    async loadNotifications(filter: NotificationFilter = 'all', limit = 20) {
      const requestId = ++notificationsRequestId;
      const previousFilter = this.notificationsFilter;
      const previousItems = this.notifications;
      const previousTotal = this.notificationsTotal;
      const switching = filter !== previousFilter;
      if (switching) {
        this.notifications = [];
      }
      this.notificationsFilter = filter;
      // A first page replaces the list, so any page still in flight is moot;
      // its own request id check keeps it from landing on the new list.
      this.notificationsLoadingMore = false;
      notificationsPageLimit = limit;
      try {
        const { data } = await http.get<{
          items: NotificationItem[];
          total: number;
          unread: number;
        }>('/notifications', { params: { limit, offset: 0, filter } });
        if (requestId !== notificationsRequestId) {
          return;
        }
        this.notifications = data.items;
        this.notificationsTotal = data.total;
        this.notificationsUnread = data.unread;
        notificationsSnapshot = { filter, items: data.items };
      } catch {
        if (requestId !== notificationsRequestId) {
          return;
        }
        // Keep whatever is already on screen. A failed switch never took
        // effect, so the last list that loaded comes back with its own chip.
        if (switching) {
          this.notifications = notificationsSnapshot?.items ?? previousItems;
          this.notificationsFilter = notificationsSnapshot?.filter ?? previousFilter;
          this.notificationsTotal = previousTotal;
        }
      }
    },
    // Appends the next page to the list on screen. The list length is the
    // offset: rows are newest-first and every loaded row is still in the list,
    // so it names exactly the first row not shown yet. A failure leaves the
    // rows already loaded untouched — the button simply offers another try.
    async loadMoreNotifications() {
      if (this.notificationsLoadingMore) {
        return;
      }
      const requestId = notificationsRequestId;
      const filter = this.notificationsFilter;
      const offset = this.notifications.length;
      this.notificationsLoadingMore = true;
      try {
        const { data } = await http.get<{
          items: NotificationItem[];
          total: number;
          unread: number;
        }>('/notifications', {
          params: { limit: notificationsPageLimit, offset, filter },
        });
        // A reload or a chip switch happened while this page was in flight;
        // its rows belong to a list that is no longer on screen.
        if (requestId !== notificationsRequestId || filter !== this.notificationsFilter) {
          return;
        }
        // A row inserted at the head after the first page shifts the window, so
        // the server may repeat rows already on screen. Ids are the identity
        // here: a duplicate would render twice and break the row keys.
        const seen = new Set(this.notifications.map((item) => item.id));
        const appended = data.items.filter((item) => !seen.has(item.id));
        this.notifications = [...this.notifications, ...appended];
        this.notificationsTotal = data.total;
        this.notificationsUnread = data.unread;
        if (notificationsSnapshot?.filter === filter) {
          notificationsSnapshot = { filter, items: this.notifications };
        }
      } catch {
        // Deliberately silent: the bell is auxiliary and the list is intact.
      } finally {
        // Only clear the flag this call set; a newer load owns it otherwise.
        if (requestId === notificationsRequestId) {
          this.notificationsLoadingMore = false;
        }
      }
    },
    async markNotificationsRead(ids?: number[]) {
      const body = ids && ids.length > 0 ? { ids } : {};
      const { data } = await http.post<{ updated: number; unread: number }>(
        '/notifications/read',
        body,
      );
      const targets = ids && ids.length > 0 ? new Set(ids) : null;
      const readAt = new Date().toISOString();
      for (const item of this.notifications) {
        if (!item.readAt && (!targets || targets.has(item.id))) {
          item.readAt = readAt;
        }
      }
      // The server's total wins: it also covers rows outside this page.
      this.notificationsUnread = data.unread;
      return data;
    },
    // The server already dropped the row, so the local list and the badge
    // follow immediately; `unread` comes back account-wide.
    async deleteNotification(id: number) {
      const { data } = await http.delete<{ deleted: number; unread: number }>(
        `/notifications/${id}`,
      );
      this.notifications = this.notifications.filter((item) => item.id !== id);
      // The row is gone server-side, so the filtered total loses it too. It
      // can never fall under what is still on screen: a stale total must not
      // make the list look longer than the account really is.
      this.notificationsTotal = Math.max(
        this.notificationsTotal - 1,
        this.notifications.length,
      );
      // The filter-switch fallback keeps its own copy of the list; pruning it
      // too stops a failed chip switch from resurrecting a deleted row.
      if (notificationsSnapshot) {
        notificationsSnapshot = {
          ...notificationsSnapshot,
          items: notificationsSnapshot.items.filter((item) => item.id !== id),
        };
      }
      this.notificationsUnread = data.unread;
      return data;
    },
    // Batch delete: one request, one local prune. `deleted` counts rows that
    // actually existed, so a selection mixing stale ids still subtracts only
    // what the server removed; the total is floored at the rows on screen so
    // "load more" never disappears behind a stale count.
    async deleteNotifications(ids: number[]) {
      const { data } = await http.post<{ deleted: number; unread: number; total: number }>(
        '/notifications/delete',
        { ids },
      );
      const targets = new Set(ids);
      this.notifications = this.notifications.filter((item) => !targets.has(item.id));
      this.notificationsTotal = Math.max(
        this.notificationsTotal - data.deleted,
        this.notifications.length,
      );
      // The filter-switch fallback keeps its own copy of the list; pruning it
      // too stops a failed chip switch from resurrecting deleted rows.
      if (notificationsSnapshot) {
        notificationsSnapshot = {
          ...notificationsSnapshot,
          items: notificationsSnapshot.items.filter((item) => !targets.has(item.id)),
        };
      }
      this.notificationsUnread = data.unread;
      return data;
    },
    // Clears every read row of the account; unread ones stay in the list.
    async clearReadNotifications() {
      const { data } = await http.delete<{ deleted: number; unread: number }>(
        '/notifications/read',
      );
      this.notifications = this.notifications.filter((item) => !item.readAt);
      // `deleted` covers read rows outside this page as well, so the server's
      // number is the only honest decrement — floored at the rows on screen,
      // because a total below the list length would hide "load more" forever.
      this.notificationsTotal = Math.max(
        this.notificationsTotal - data.deleted,
        this.notifications.length,
      );
      if (notificationsSnapshot) {
        notificationsSnapshot = {
          ...notificationsSnapshot,
          items: notificationsSnapshot.items.filter((item) => !item.readAt),
        };
      }
      this.notificationsUnread = data.unread;
      return data;
    },
    handleNotification(notification: NotificationItem) {
      const index = this.notifications.findIndex((item) => item.id === notification.id);
      if (index >= 0) {
        const previous = this.notifications[index];
        this.notifications[index] = notification;
        if (!previous.readAt && notification.readAt) {
          this.notificationsUnread = Math.max(this.notificationsUnread - 1, 0);
        }
        return;
      }
      // A row the active chip excludes still counts as unread (that number is
      // account-wide), it just has no place in the narrowed list.
      if (notificationMatchesFilter(notification.type, this.notificationsFilter)) {
        // The list is a newest-first window over the filtered set: a new head
        // row pushes the oldest loaded row out, so a long session cannot grow
        // it without bound and the window still starts at offset 0. A list the
        // user paged past one page keeps its height instead of being cut back.
        const window = Math.max(NOTIFICATION_LIMIT, this.notifications.length);
        this.notifications = [notification, ...this.notifications].slice(0, window);
        // Only a row this chip would show joins the filtered total.
        this.notificationsTotal += 1;
      }
      if (!notification.readAt) {
        this.notificationsUnread += 1;
      }
      // The bell and the desktop notification share the same guards: opt-in,
      // granted permission, hidden page, unmuted room. Message paths already
      // notify for plain messages; this covers mention notifications, which
      // still fire when the user narrowed the desktop scope to "仅提及".
      this.maybeNotify(
        notification.roomId,
        null,
        notification.actorName,
        notification.content,
        'mention',
        notification.messageSeq,
      );
    },
    bind() {
      // Views remount often; re-reading here keeps a change made on another
      // device visible without waiting for the next socket connect.
      void this.loadSettings();
      // Idempotent: the socket outlives store instances, so a second bind()
      // (or a bind() after $reset) must not stack duplicate listeners.
      if (unbindSocket) {
        this.bound = true;
        return;
      }
      this.bound = true;
      const socket = getSocket();
      this.connected = socket.connected;
      const cleanups: Array<() => void> = [];
      const listen = (event: string, handler: SocketListener) => {
        socket.on(event, handler);
        cleanups.push(() => socket.off(event, handler));
      };
      listen('message:new', (payload: NewMessagePayload) => {
        void this.handleNew(payload.roomId, payload.message);
      });
      listen('message:delta', (payload: DeltaPayload) => {
        this.handleDelta(payload);
      });
      listen('message:final', (payload: FinalPayload) => {
        void this.handleFinal(payload);
      });
      listen('message:updated', (payload: UpdatedPayload) => {
        this.handleUpdated(payload.roomId, payload.message);
      });
      listen('presence', (payload: PresencePayload) => {
        this.handlePresence(payload);
      });
      listen('members:changed', (payload: { roomId: number }) => {
        void this.refreshMembers(payload.roomId).catch(() => undefined);
      });
      listen('read:updated', (payload: ReadUpdatedPayload) => {
        this.handleReadUpdated(payload);
      });
      listen('typing', (payload: TypingPayload) => {
        this.handleTyping(payload);
      });
      listen('system:notice', (payload: NoticePayload) => {
        if (
          payload.code === 'BOT_STOPPED' &&
          Date.now() - localStopAt < STOP_NOTICE_QUIET_MS
        ) {
          return;
        }
        ElMessage.warning(payload.message);
      });
      listen('room:updated', (payload: RoomUpdatedPayload) => {
        this.handleRoomUpdated(payload);
      });
      listen('room:owner', (payload: OwnerChangedPayload) => {
        this.handleRoomOwner(payload);
      });
      listen('room:revoked', (payload: RevokedPayload) => {
        this.watchedRooms = this.watchedRooms.filter((id) => id !== payload.roomId);
        this.rooms.mine = this.rooms.mine.filter((room) => room.id !== payload.roomId);
        this.rooms.public = this.rooms.public.filter((room) => room.id !== payload.roomId);
        this.updateTitle();
        if (this.currentRoomId === payload.roomId) {
          this.closeRoom();
          ElMessage.warning('你已离开该房间');
          window.location.href = '/rooms';
        }
      });
      listen('notification:new', (payload: NotificationPayload) => {
        this.handleNotification(payload.notification);
      });
      listen('connect', () => {
        this.connected = true;
        this.watchedRooms = [];
        this.watchRooms();
        void this.loadRooms().catch(() => {
          // reconnect will retry; avoid toast spam
        });
        // Keep the panel's chip selected across reconnects.
        void this.loadNotifications(this.notificationsFilter);
        void this.loadSettings();
        if (this.currentRoomId != null) {
          void this.rejoin(this.currentRoomId);
        }
      });
      listen('disconnect', () => {
        this.connected = false;
      });
      listen('connect_error', () => {
        this.connected = false;
      });
      const typingTimer = window.setInterval(() => {
        const now = Date.now();
        for (const [roomId, list] of Object.entries(this.typing)) {
          const fresh = list.filter((user) => now - user.at < 4000);
          if (fresh.length !== list.length) {
            this.typing[Number(roomId)] = fresh;
          }
        }
      }, 2000);
      cleanups.push(() => window.clearInterval(typingTimer));
      // bind() can run after the socket already connected (the connect event
      // fired before this store mounted), so seed the bell here as well.
      if (socket.connected) {
        void this.loadNotifications(this.notificationsFilter);
      }
      const onVisibilityChange = () => {
        if (document.hidden) {
          for (const roomId of readPending.keys()) {
            void this.flushRead(roomId);
          }
        }
      };
      document.addEventListener('visibilitychange', onVisibilityChange);
      cleanups.push(() => document.removeEventListener('visibilitychange', onVisibilityChange));
      unbindSocket = () => {
        for (const cleanup of cleanups) {
          cleanup();
        }
        unbindSocket = null;
      };
    },
    dispose() {
      unbindSocket?.();
      unbindSocket = null;
      for (const timer of readTimers.values()) {
        window.clearTimeout(timer);
      }
      readTimers.clear();
      readPending.clear();
      for (const pending of pendingNotifies.values()) {
        window.clearTimeout(pending.timer);
      }
      pendingNotifies.clear();
      notificationsSnapshot = null;
      this.bound = false;
      this.connected = false;
    },
    async openRoom(roomId: number, inviteCode?: string): Promise<boolean> {
      const generation = ++openRoomGeneration;
      const stale = () => generation !== openRoomGeneration;
      if (this.currentRoomId != null && this.currentRoomId !== roomId) {
        this.leaveSocket(this.currentRoomId);
      }
      this.currentRoomId = roomId;
      this.loading = true;
      try {
        await http.post(`/rooms/${roomId}/join`, {
          inviteCode: inviteCode || undefined,
        });
        if (stale()) {
          return false;
        }
        await waitForSocketConnect();
        if (stale()) {
          return false;
        }
        await joinSocket(roomId, true);
        if (stale()) {
          // This join landed after a newer room switch. Undo it unless the
          // user came back to this room in the meantime (A→B→A).
          if (this.currentRoomId !== roomId) {
            this.leaveSocket(roomId);
          }
          return false;
        }
        this.watchRooms();
        const { data } = await http.get<{ messages: Message[]; hasMore: boolean }>(
          `/rooms/${roomId}/messages`,
          { params: { limit: 50 } },
        );
        if (stale()) {
          return false;
        }
        const merged = new Map<number, Message>();
        for (const message of this.messages[roomId] ?? []) {
          merged.set(message.seq, message);
        }
        // Server rows win once finalised; a local streaming partial only wins
        // while the server still reports that seq as streaming (it carries the
        // deltas received after this snapshot was taken).
        for (const message of data.messages) {
          const local = merged.get(message.seq);
          if (local && message.status === 'streaming') {
            continue;
          }
          merged.set(message.seq, message);
        }
        const list = [...merged.values()].sort((a, b) => a.seq - b.seq);
        this.messages[roomId] = list;
        this.hasMore[roomId] = data.hasMore;
        const latest = list[list.length - 1];
        // Seed the gap cursor from the snapshot the server just sent: with a
        // fresh store lastSeq is 0, and leaving it there would make the first
        // incoming message replay the entire room history through fillGap.
        const serverMaxSeq = data.messages.reduce(
          (max, message) => Math.max(max, message.seq),
          0,
        );
        this.lastSeq[roomId] = Math.max(this.lastSeq[roomId] ?? 0, serverMaxSeq);
        const summary =
          this.rooms.mine.find((room) => room.id === roomId) ??
          this.rooms.public.find((room) => room.id === roomId);
        const unread = summary?.unreadCount ?? 0;
        if (unread > 0 && latest) {
          this.unreadMarker[roomId] = Math.max(latest.seq - unread + 1, 1);
        } else {
          delete this.unreadMarker[roomId];
        }
        await this.refreshMembers(roomId);
        if (stale()) {
          return false;
        }
        this.markRoomRead(roomId);
        if (latest) {
          this.updateRoomPreview(roomId, latest, { markRead: true });
          this.markRead(roomId, latest.seq);
        }
        return true;
      } catch (error) {
        // A stale run's failure belongs to the room the user already left;
        // toasting it would blame the new room for the old request.
        if (!stale()) {
          ElMessage.error(errorMessage(error));
        }
        return false;
      } finally {
        if (!stale()) {
          this.loading = false;
        }
      }
    },
    async rejoin(roomId: number) {
      try {
        await joinSocket(roomId, true);
        this.watchRooms();
        // A message:final missed while offline is only repaired by reading the
        // server rows back; do it before the seq gap fill so placeholders that
        // are already in the list get their final content.
        await this.refreshRecent(roomId);
        await this.fillGap(roomId);
        this.markRoomRead(roomId);
      } catch (error) {
        ElMessage.error(errorMessage(error));
      }
    },
    closeRoom() {
      if (this.currentRoomId != null) {
        void this.flushRead(this.currentRoomId);
        this.leaveSocket(this.currentRoomId);
      }
      this.currentRoomId = null;
      this.watchRooms();
    },
    leaveSocket(roomId: number) {
      getSocket().emit('room:leave', { roomId });
    },
    // Files are uploaded before the message exists: a multi-megabyte body on
    // the socket ack path would stall the room, and the returned row stays
    // unbound until `send` claims it. The caller keeps the row so a failed
    // send can retry with the same ids.
    async uploadAttachment(roomId: number, file: File): Promise<Attachment> {
      const form = new FormData();
      form.append('file', file);
      const { data } = await http.post<{ attachment: Attachment }>(
        `/rooms/${roomId}/attachments`,
        form,
      );
      return data.attachment;
    },
    // `attachmentIds` are rows uploaded ahead of time by `uploadAttachment`
    // and still unbound. The server binds them in the same transaction as the
    // message row, so an empty body is allowed exactly when at least one id
    // rides along. A failure rejects the whole send, leaving the rows unbound
    // for a retry.
    send(
      content: string,
      onDone?: (ok: boolean) => void,
      replyToId?: number,
      attachmentIds: number[] = [],
    ) {
      const roomId = this.currentRoomId;
      // Mirror the server's order/dedup rules so the ack never rejects a
      // payload the composer could have normalised itself.
      const ids = [...new Set(attachmentIds.filter((id) => Number.isInteger(id) && id > 0))].slice(
        0,
        10,
      );
      if (roomId == null || (content.trim().length === 0 && ids.length === 0)) {
        onDone?.(false);
        return;
      }
      if (!this.connected) {
        onDone?.(false);
        ElMessage.error('连接已断开，正在重连');
        return;
      }
      let settled = false;
      let timer: number | undefined;
      const finish = (ok: boolean, errorText?: string) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer !== undefined) {
          window.clearTimeout(timer);
        }
        onDone?.(ok);
        if (!ok) {
          ElMessage.error(errorText ?? '发送失败');
        }
      };
      timer = window.setTimeout(() => {
        finish(false, '发送超时，请重试');
      }, SEND_ACK_TIMEOUT_MS);
      getSocket().emit(
        'message:send',
        {
          roomId,
          content,
          clientMsgId: makeClientMsgId(),
          ...(replyToId ? { replyToId } : {}),
          ...(ids.length > 0 ? { attachmentIds: ids } : {}),
        },
        (response: { ok?: boolean; message?: Message | string }) => {
          if (response?.ok) {
            if (response.message && typeof response.message === 'object') {
              void this.handleNew(roomId, response.message);
            }
            finish(true);
            return;
          }
          finish(
            false,
            typeof response?.message === 'string' ? response.message : '发送失败',
          );
        },
      );
    },
    // Poll creation is a plain HTTP POST (the server broadcasts `message:new`
    // to the room). The response row is applied through the same path as the
    // socket ack for a sent message, so the new card appears even if the
    // broadcast is late. Failures (slow mode, rate limit, duplicates) reject
    // with the API error and reach the dialog.
    async createPoll(
      roomId: number,
      input: {
        question: string;
        options: string[];
        multiple?: boolean;
        anonymous?: boolean;
        closesInMinutes?: number;
      },
    ): Promise<Message> {
      const { data } = await http.post<{ message: Message }>(
        `/rooms/${roomId}/polls`,
        input,
      );
      void this.handleNew(roomId, data.message);
      return data.message;
    },
    // Stops whatever the bots are generating in the open room. The server
    // aborts every active stream for the room and finalizes each placeholder as
    // an error, so `message:final` keeps the partial text the user already saw.
    // Resolves true only when the server confirms it cancelled at least one
    // generation; a timeout or a rejected ack resolves false so the caller can
    // tell the user nothing was stopped.
    stopBots(): Promise<boolean> {
      const roomId = this.currentRoomId;
      if (roomId == null || !Number.isInteger(roomId) || roomId <= 0) {
        return Promise.resolve(false);
      }
      if (!this.connected) {
        return Promise.resolve(false);
      }
      // The BOT_STOPPED notice is broadcast before the ack, so open the quiet
      // window before emitting; otherwise the notice and the local toast double up.
      localStopAt = Date.now();
      const { promise, resolve } = Promise.withResolvers<boolean>();
      let settled = false;
      let timer: number | undefined;
      const finish = (canceled: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer !== undefined) {
          window.clearTimeout(timer);
        }
        if (canceled) {
          localStopAt = Date.now();
        }
        resolve(canceled);
      };
      timer = window.setTimeout(() => {
        finish(false);
      }, STOP_ACK_TIMEOUT_MS);
      getSocket().emit(
        'bot:stop',
        { roomId },
        (response: { ok?: boolean; canceled?: boolean }) => {
          finish(Boolean(response?.ok) && Boolean(response?.canceled));
        },
      );
      return promise;
    },
    sendTyping(isTyping: boolean) {
      if (this.currentRoomId != null) {
        getSocket().emit('typing', { roomId: this.currentRoomId, isTyping });
      }
    },
    watchRoom(roomId: number) {
      if (this.currentRoomId === roomId || this.watchedRooms.includes(roomId)) {
        return;
      }
      const socket = getSocket();
      if (!socket.connected) {
        return;
      }
      socket.emit('room:watch', { roomId });
      this.watchedRooms.push(roomId);
    },
    watchRooms() {
      for (const room of this.rooms.mine) {
        this.watchRoom(room.id);
      }
    },
    unwatchRoom(roomId: number) {
      const socket = getSocket();
      if (socket.connected) {
        socket.emit('room:unwatch', { roomId });
      }
      this.watchedRooms = this.watchedRooms.filter((id) => id !== roomId);
    },
    reconnect() {
      const socket = getSocket();
      if (!socket.connected) {
        socket.connect();
      }
    },
    maybeNotify(
      roomId: number,
      senderId: number | null,
      senderName: string,
      content: string,
      kind: 'message' | 'mention' = 'message',
      seq: number | null = null,
    ) {
      if (!document.hidden || !content) {
        return;
      }
      if (kind === 'message' && this.notifyMode === 'mention') {
        return;
      }
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
        return;
      }
      if (localStorage.getItem('bfa_notify') !== '1') {
        return;
      }
      const auth = useAuthStore();
      if (senderId != null && senderId === auth.user?.id) {
        return;
      }
      const room =
        this.rooms.mine.find((item) => item.id === roomId) ??
        this.rooms.public.find((item) => item.id === roomId);
      if (room?.muted) {
        return;
      }
      // DND comes last, right before the toast joins the burst queue: the
      // cheap local guards above already decided the notification is
      // otherwise wanted. Mentions pierce the window only when the user left
      // `dndAllowMentions` on; everything else is dropped, not deferred.
      if (
        inDndWindow(this.dndStart, this.dndEnd, new Date()) &&
        !(kind === 'mention' && this.dndAllowMentions)
      ) {
        return;
      }
      const roomName = room?.name ?? '新消息';
      const pending = pendingNotifies.get(roomId);
      if (pending) {
        // Same room, same window: fold this message into the toast that is
        // still waiting to be shown. The click target follows the newest seq
        // so the toast never lands on a line that arrived before it.
        pending.count += 1;
        pending.senderName = senderName;
        pending.content = content;
        if (seq != null) {
          pending.seq = pending.seq == null ? seq : Math.max(pending.seq, seq);
        }
        return;
      }
      pendingNotifies.set(roomId, {
        timer: window.setTimeout(() => flushNotify(roomId), NOTIFY_BURST_MS),
        count: 1,
        senderName,
        content,
        roomName,
        seq,
      });
    },
    updateTitle() {
      // Archived rooms are hidden from the rail, so their unread would count
      // toward a badge the reader cannot reach from the default view.
      const total = this.rooms.mine.reduce(
        (sum, room) =>
          sum + (room.muted || room.archived ? 0 : Math.max(room.unreadCount, 0)),
        0,
      );
      document.title = total > 0 ? `(${total}) bot-for-all` : 'bot-for-all';
    },
    async setRoomMuted(roomId: number, muted: boolean): Promise<boolean> {
      const { data } = await http.post<{ muted: boolean }>(`/rooms/${roomId}/mute`, {
        muted,
      });
      const next = data.muted;
      for (const list of [this.rooms.mine, this.rooms.public]) {
        const room = list.find((item) => item.id === roomId);
        if (room) {
          room.muted = next;
        }
      }
      this.updateTitle();
      return next;
    },
    async setRoomFavorite(roomId: number, favorite: boolean): Promise<boolean> {
      const { data } = await http.post<{ favorite: boolean }>(`/rooms/${roomId}/favorite`, {
        favorite,
      });
      const next = data.favorite;
      for (const list of [this.rooms.mine, this.rooms.public]) {
        const room = list.find((item) => item.id === roomId);
        if (room) {
          room.favorite = next;
        }
      }
      this.rooms.mine = sortRoomsByActivity(this.rooms.mine);
      return next;
    },
    // Archiving is per member and never broadcast, so only this tab's lists
    // change. The rail order is left alone: the room keeps its slot for when
    // the reader unarchives it.
    async setRoomArchived(roomId: number, archived: boolean): Promise<boolean> {
      const { data } = await http.post<{ archived: boolean }>(`/rooms/${roomId}/archive`, {
        archived,
      });
      const next = data.archived;
      for (const list of [this.rooms.mine, this.rooms.public]) {
        const room = list.find((item) => item.id === roomId);
        if (room) {
          room.archived = next;
        }
      }
      this.updateTitle();
      return next;
    },
    // Groups are per-user and never reorder the rail: only the label changes.
    async setRoomGroup(roomId: number, group: string | null): Promise<string | null> {
      const { data } = await http.post<{ group: string | null }>(`/rooms/${roomId}/group`, {
        group,
      });
      const next = data.group;
      for (const list of [this.rooms.mine, this.rooms.public]) {
        const room = list.find((item) => item.id === roomId);
        if (room) {
          room.group = next;
        }
      }
      return next;
    },
    async refreshMembers(roomId: number) {
      const { data } = await http.get<{ members: Member[] }>(`/rooms/${roomId}/members`);
      this.members[roomId] = data.members;
      for (const list of [this.rooms.mine, this.rooms.public]) {
        const room = list.find((item) => item.id === roomId);
        if (room) {
          room.memberCount = data.members.length;
        }
      }
    },
    markRoomRead(roomId: number) {
      for (const list of [this.rooms.mine, this.rooms.public]) {
        const room = list.find((item) => item.id === roomId);
        if (room) {
          room.unreadCount = 0;
        }
      }
      this.updateTitle();
    },
    markRead(roomId: number, seq: number) {
      if (seq <= (this.lastReadSent[roomId] ?? 0)) {
        return;
      }
      this.lastReadSent[roomId] = seq;
      readPending.set(roomId, Math.max(readPending.get(roomId) ?? 0, seq));
      window.clearTimeout(readTimers.get(roomId));
      readTimers.set(
        roomId,
        window.setTimeout(() => {
          void this.flushRead(roomId);
        }, 800),
      );
    },
    async flushRead(roomId: number) {
      window.clearTimeout(readTimers.get(roomId));
      readTimers.delete(roomId);
      const seq = readPending.get(roomId);
      if (seq == null) {
        return;
      }
      readPending.delete(roomId);
      try {
        await http.post(`/rooms/${roomId}/read`, { seq });
      } catch {
        if (this.lastReadSent[roomId] === seq) {
          this.lastReadSent[roomId] = 0;
        }
      }
    },
    // Clearing the badge is one receipt per room, taken from the seq the
    // unread count is derived from. Each room stands alone: a refusal must not
    // strand the rooms behind it, and the next sync restores whatever the
    // server still reports as unread.
    async markAllRead(): Promise<void> {
      const targets = this.rooms.mine.filter((room) => room.unreadCount > 0);
      for (const room of targets) {
        const seq = room.lastMessage?.seq;
        if (seq == null) {
          continue;
        }
        try {
          this.markRead(room.id, seq);
          this.markRoomRead(room.id);
          await this.flushRead(room.id);
        } catch {
          // Ignored on purpose: the loop keeps going for the other rooms.
        }
      }
      this.updateTitle();
    },
    updateRoomPreview(
      roomId: number,
      message: Message,
      options: { markRead?: boolean; incrementUnread?: boolean },
    ) {
      const content = message.content
        ? plainPreview(message.content)
        : (message.attachments?.length ?? 0) > 0
          ? '[附件]'
          : message.status === 'streaming'
            ? '正在生成…'
            : message.status === 'error'
              ? '生成失败'
              : '';
      for (const list of [this.rooms.mine, this.rooms.public]) {
        const room = list.find((item) => item.id === roomId);
        if (!room) {
          continue;
        }
        if (!room.lastMessage || message.seq >= room.lastMessage.seq) {
          room.lastMessage = {
            seq: message.seq,
            content,
            senderName: message.senderName,
            createdAt: message.createdAt,
          };
        }
        if (options.markRead) {
          room.unreadCount = 0;
        } else if (options.incrementUnread && room.joined) {
          room.unreadCount += 1;
        }
      }
      this.updateTitle();
    },
    async loadOlder(roomId: number): Promise<number> {
      if (!this.hasMore[roomId] || this.loadingOlder[roomId]) {
        return 0;
      }
      const first = this.messages[roomId]?.[0]?.seq;
      if (!first) {
        return 0;
      }
      this.loadingOlder[roomId] = true;
      try {
        const { data } = await http.get<{ messages: Message[]; hasMore: boolean }>(
          `/rooms/${roomId}/messages`,
          { params: { beforeSeq: first, limit: 50 } },
        );
        for (const message of data.messages) {
          this.insertMessage(roomId, message);
        }
        this.hasMore[roomId] = data.hasMore;
        return data.messages.length;
      } catch (error) {
        ElMessage.error(errorMessage(error));
        return 0;
      } finally {
        this.loadingOlder[roomId] = false;
      }
    },
    async loadAround(roomId: number, seq: number): Promise<void> {
      const { data } = await http.get<{ messages: Message[] }>(
        `/rooms/${roomId}/messages`,
        { params: { beforeSeq: seq + 1, limit: 50 } },
      );
      for (const message of data.messages) {
        this.insertMessage(roomId, message);
      }
      this.lastSeq[roomId] = Math.max(
        this.lastSeq[roomId] ?? 0,
        data.messages[data.messages.length - 1]?.seq ?? 0,
      );
    },
    async searchMessages(roomId: number, query: string): Promise<Message[]> {
      const { data } = await http.get<{ messages: Message[] }>(
        `/rooms/${roomId}/search`,
        { params: { q: query, limit: 20 } },
      );
      return data.messages;
    },
    async editMessage(roomId: number, seq: number, content: string): Promise<Message> {
      const { data } = await http.patch<{ message: Message }>(
        `/rooms/${roomId}/messages/${seq}`,
        { content },
      );
      this.handleUpdated(roomId, data.message);
      return data.message;
    },
    async deleteMessage(roomId: number, seq: number): Promise<Message> {
      const { data } = await http.delete<{ message: Message }>(
        `/rooms/${roomId}/messages/${seq}`,
      );
      this.handleUpdated(roomId, data.message);
      return data.message;
    },
    // Moderator-only sweep. The server broadcasts one `message:updated` per
    // withdrawn row, so the transcript updates through the same path as a
    // single delete; the counts only drive the toast.
    async bulkDeleteMessages(
      roomId: number,
      seqs: number[],
    ): Promise<{ deleted: number; skipped: number }> {
      const total = { deleted: 0, skipped: 0 };
      for (let index = 0; index < seqs.length; index += BULK_DELETE_LIMIT) {
        const { data } = await http.post<{ deleted: number; skipped: number }>(
          `/rooms/${roomId}/messages/bulk-delete`,
          { seqs: seqs.slice(index, index + BULK_DELETE_LIMIT) },
        );
        total.deleted += data.deleted;
        total.skipped += data.skipped;
      }
      return total;
    },
    async toggleReaction(roomId: number, seq: number, emoji: string): Promise<Message> {
      const { data } = await http.post<{ message: Message }>(
        `/rooms/${roomId}/messages/${seq}/reactions`,
        { emoji },
      );
      this.handleUpdated(roomId, data.message);
      return data.message;
    },
    // Anonymous polls expose no voters in the message payload, so the card
    // asks for the viewer's own ballot here. The card only knows the poll id,
    // hence the lookup in the room cache for its `roomId`/`seq`; a poll that
    // is not in any loaded message cannot be voted on from this client and
    // resolves to an empty ballot. The result is cached per poll id because
    // socket broadcasts deliberately never carry it.
    async loadPollMyVotes(pollId: number): Promise<number[]> {
      const cached = this.pollMyVotes[pollId];
      if (cached) {
        return [...cached];
      }
      let target: Message | undefined;
      for (const list of Object.values(this.messages)) {
        target = list.find((message) => message.poll?.id === pollId);
        if (target) {
          break;
        }
      }
      if (!target) {
        return [];
      }
      const { data } = await http.get<{ optionIds: number[] }>(
        `/rooms/${target.roomId}/messages/${target.seq}/poll/my-votes`,
      );
      this.pollMyVotes[pollId] = data.optionIds;
      return [...data.optionIds];
    },
    // Votes are replacement semantics server-side: the sent option ids become
    // the viewer's whole ballot for that poll, and an empty list clears it.
    // The broadcast carries the same row to everyone else; applying the
    // response locally keeps this client in step without waiting for it.
    async votePoll(
      roomId: number,
      seq: number,
      optionIds: number[],
    ): Promise<Message> {
      const { data } = await http.post<{ message: Message }>(
        `/rooms/${roomId}/messages/${seq}/poll/votes`,
        { optionIds },
      );
      if (data.message.poll) {
        // The request just replaced the viewer's ballot, so the my-votes
        // cache is exact even though the response row hides voters.
        this.pollMyVotes[data.message.poll.id] = [...optionIds];
      }
      this.handleUpdated(roomId, data.message);
      return data.message;
    },
    // Closing ends the poll for everyone at once: the server stamps `closesAt`
    // and the response (as well as the broadcast) carries `closed: true`.
    async closePoll(roomId: number, seq: number): Promise<Message> {
      const { data } = await http.post<{ message: Message }>(
        `/rooms/${roomId}/messages/${seq}/poll/close`,
      );
      this.handleUpdated(roomId, data.message);
      return data.message;
    },
    async pinMessage(roomId: number, seq: number, pinned: boolean): Promise<Message> {
      const url = `/rooms/${roomId}/messages/${seq}/pin`;
      const { data } = pinned
        ? await http.post<{ message: Message }>(url)
        : await http.delete<{ message: Message }>(url);
      this.handleUpdated(roomId, data.message);
      return data.message;
    },
    async loadPinned(roomId: number): Promise<Message[]> {
      const { data } = await http.get<{ messages: Message[] }>(`/rooms/${roomId}/pins`);
      for (const message of data.messages) {
        this.handleUpdated(roomId, message);
      }
      return data.messages;
    },
    async fillGap(roomId: number) {
      let last = this.lastSeq[roomId] ?? 0;
      for (let page = 0; page < MAX_GAP_PAGES; page += 1) {
        const { data } = await http.get<{ messages: Message[]; hasMore: boolean }>(
          `/rooms/${roomId}/messages`,
          { params: { afterSeq: last, limit: 200 } },
        );
        if (data.messages.length === 0) {
          break;
        }
        for (const message of data.messages) {
          this.upsertMessage(roomId, message);
        }
        last = data.messages[data.messages.length - 1].seq;
        this.lastSeq[roomId] = Math.max(this.lastSeq[roomId] ?? 0, last);
        if (!data.hasMore) {
          break;
        }
      }
      const list = this.messages[roomId];
      const latest = list?.[list.length - 1];
      if (latest) {
        this.updateRoomPreview(roomId, latest, {
          markRead: this.currentRoomId === roomId,
        });
        if (this.currentRoomId === roomId) {
          this.markRead(roomId, latest.seq);
        }
      }
    },
    insertMessage(roomId: number, message: Message) {
      const list = this.messages[roomId] ?? [];
      if (list.some((item) => item.seq === message.seq)) {
        return;
      }
      const index = list.findIndex((item) => item.seq > message.seq);
      if (index === -1) {
        list.push(message);
      } else {
        list.splice(index, 0, message);
      }
      this.messages[roomId] = list;
    },
    // Authoritative refresh path: a server row replaces whatever the client
    // holds for that seq, except when the server itself is still streaming —
    // the local copy then carries the deltas received after the snapshot.
    upsertMessage(roomId: number, message: Message) {
      const list = this.messages[roomId] ?? [];
      const index = list.findIndex((item) => item.seq === message.seq);
      if (index === -1) {
        this.insertMessage(roomId, message);
        return;
      }
      if (message.status === 'streaming') {
        return;
      }
      list[index] = message;
      this.messages[roomId] = list;
    },
    async refreshRecent(roomId: number) {
      const { data } = await http.get<{ messages: Message[]; hasMore: boolean }>(
        `/rooms/${roomId}/messages`,
        { params: { limit: 50 } },
      );
      for (const message of data.messages) {
        this.upsertMessage(roomId, message);
      }
      const latest = data.messages[data.messages.length - 1];
      if (latest) {
        this.lastSeq[roomId] = Math.max(this.lastSeq[roomId] ?? 0, latest.seq);
      }
    },
    async handleNew(roomId: number, message: Message) {
      if (message.status !== 'streaming' && message.content) {
        this.maybeNotify(
          roomId,
          message.senderId,
          message.senderName,
          message.content,
          'message',
          message.seq,
        );
      }
      if (roomId !== this.currentRoomId) {
        this.updateRoomPreview(roomId, message, { incrementUnread: true });
        return;
      }
      const last = this.lastSeq[roomId] ?? 0;
      if (message.seq <= last) {
        return;
      }
      if (message.seq > last + 1) {
        try {
          await this.fillGap(roomId);
        } catch {
          // The gap repair is best-effort: the live row below still belongs in
          // the transcript, and advancing lastSeq keeps later rows contiguous.
          // A later rejoin/refresh retries the missing range from the server.
        }
      }
      this.upsertMessage(roomId, message);
      this.lastSeq[roomId] = Math.max(this.lastSeq[roomId] ?? 0, message.seq);
      this.updateRoomPreview(roomId, message, {
        markRead: this.currentRoomId === roomId,
        incrementUnread: this.currentRoomId !== roomId,
      });
      if (this.currentRoomId === roomId) {
        this.markRead(roomId, message.seq);
      }
    },
    handleDelta(payload: DeltaPayload) {
      const target = this.messages[payload.roomId]?.find(
        (message) => message.seq === payload.seq,
      );
      if (!target) {
        return;
      }
      target.content += payload.delta;
      target.status = 'streaming';
    },
    async handleFinal(payload: FinalPayload) {
      if (payload.roomId !== this.currentRoomId) {
        const room =
          this.rooms.mine.find((item) => item.id === payload.roomId) ??
          this.rooms.public.find((item) => item.id === payload.roomId);
        if (room?.lastMessage && payload.seq >= room.lastMessage.seq) {
          room.lastMessage = {
            ...room.lastMessage,
            content: payload.content
              ? plainPreview(payload.content)
              : payload.status === 'error'
                ? '生成失败'
                : room.lastMessage.content,
          };
        }
        this.maybeNotify(
          payload.roomId,
          null,
          room?.lastMessage?.senderName ?? '机器人',
          payload.content,
          'message',
          payload.seq,
        );
        this.updateTitle();
        return;
      }
      let target = this.messages[payload.roomId]?.find(
        (message) => message.seq === payload.seq,
      );
      if (!target) {
        try {
          await this.fillGap(payload.roomId);
        } catch {
          // Keep going: if the row did make it into the gap response we can
          // still apply the final below. Otherwise the next rejoin/refresh
          // fetches the finalised row from the server instead of throwing the
          // socket event away.
        }
        target = this.messages[payload.roomId]?.find(
          (message) => message.seq === payload.seq,
        );
      }
      if (!target) {
        return;
      }
      target.content = payload.content;
      target.status = payload.status;
      this.maybeNotify(
        payload.roomId,
        target.senderId,
        target.senderName,
        payload.content,
        'message',
        payload.seq,
      );
      this.updateRoomPreview(payload.roomId, target, {
        markRead: this.currentRoomId === payload.roomId,
      });
    },
    handleUpdated(roomId: number, message: Message) {
      const list = this.messages[roomId];
      if (list) {
        const index = list.findIndex((item) => item.seq === message.seq);
        if (index >= 0) {
          list[index] = message;
        } else {
          this.insertMessage(roomId, message);
        }
      }
      // A withdrawn message must not leak its old text into the room preview.
      const preview = message.deleted
        ? { ...message, content: '消息已撤回', status: 'done' as const }
        : message;
      this.updateRoomPreview(roomId, preview, {});
    },
    handleRoomUpdated(payload: RoomUpdatedPayload) {
      for (const list of [this.rooms.mine, this.rooms.public]) {
        const room = list.find((item) => item.id === payload.roomId);
        if (!room) {
          continue;
        }
        room.name = payload.name;
        room.topic = payload.topic;
        room.announcement = payload.announcement;
        if (typeof payload.slowModeSeconds === 'number') {
          room.slowModeSeconds = payload.slowModeSeconds;
        }
      }
    },
    // Ownership transfer is pushed to the room so every open tab flips
    // permissions without a reload: the summary's ownerId drives `canEdit`,
    // and the roster roles (owner/member) come back from the refetch.
    handleRoomOwner(payload: OwnerChangedPayload) {
      for (const list of [this.rooms.mine, this.rooms.public]) {
        const room = list.find((item) => item.id === payload.roomId);
        if (room) {
          room.ownerId = payload.ownerId;
        }
      }
      void this.refreshMembers(payload.roomId).catch(() => undefined);
    },
    // Read cursors only move forward: an out-of-order packet must never rewind
    // a receipt we already show. Unknown rooms/members are ignored — the roster
    // refetch that follows a join carries the current cursor anyway.
    handleReadUpdated(payload: ReadUpdatedPayload) {
      const members = this.members[payload.roomId];
      if (!members) {
        return;
      }
      const member = members.find((item) => item.userId === payload.userId);
      if (!member) {
        return;
      }
      member.lastReadSeq = Math.max(member.lastReadSeq ?? 0, payload.seq);
    },
    handlePresence(payload: PresencePayload) {
      this.online[payload.roomId] = payload.onlineUserIds;
      const members = this.members[payload.roomId];
      if (!members) {
        return;
      }
      // A joining member is online before their row exists locally; refetch
      // the roster instead of leaving them invisible until a manual reload.
      const known = new Set(members.map((member) => member.userId));
      if (payload.onlineUserIds.some((id) => !known.has(id))) {
        void this.refreshMembers(payload.roomId).catch(() => undefined);
        return;
      }
      for (const member of members) {
        member.online = payload.onlineUserIds.includes(member.userId);
      }
    },
    handleTyping(payload: TypingPayload) {
      const list = this.typing[payload.roomId] ?? [];
      const index = list.findIndex((user) => user.userId === payload.userId);
      if (payload.isTyping) {
        if (index >= 0) {
          list[index].at = Date.now();
          list[index].displayName = payload.displayName;
        } else {
          list.push({
            userId: payload.userId,
            displayName: payload.displayName,
            at: Date.now(),
          });
        }
      } else if (index >= 0) {
        list.splice(index, 1);
      }
      this.typing[payload.roomId] = list;
    },
  },
});
