import { ElMessage } from 'element-plus';
import { defineStore } from 'pinia';
import http, { errorMessage } from '../api/http';
import { getSocket } from '../socket';
import type { Member, Message, RoomSummary } from '../types';
import { plainPreview } from '../utils/format';
import { useAuthStore } from './auth';

interface TypingUser {
  userId: number;
  displayName: string;
  at: number;
}

interface ChatState {
  rooms: { mine: RoomSummary[]; public: RoomSummary[] };
  currentRoomId: number | null;
  messages: Record<number, Message[]>;
  lastSeq: Record<number, number>;
  lastReadSent: Record<number, number>;
  hasMore: Record<number, boolean>;
  loadingOlder: Record<number, boolean>;
  unreadMarker: Record<number, number>;
  watchedRooms: number[];
  online: Record<number, number[]>;
  members: Record<number, Member[]>;
  typing: Record<number, TypingUser[]>;
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

const readTimers = new Map<number, number>();
const readPending = new Map<number, number>();

function waitForSocketConnect(): Promise<void> {
  const socket = getSocket();
  if (socket.connected) {
    return Promise.resolve();
  }
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const timer = window.setTimeout(() => reject(new Error('连接超时')), 5000);
  socket.once('connect', () => {
    window.clearTimeout(timer);
    resolve();
  });
  socket.once('connect_error', (error) => {
    window.clearTimeout(timer);
    reject(error);
  });
  return promise;
}

const JOIN_ACK_TIMEOUT_MS = 8000;
const SEND_ACK_TIMEOUT_MS = 10000;

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

export const useChatStore = defineStore('chat', {
  state: (): ChatState => ({
    rooms: { mine: [], public: [] },
    currentRoomId: null,
    messages: {},
    lastSeq: {},
    lastReadSent: {},
    hasMore: {},
    loadingOlder: {},
    unreadMarker: {},
    watchedRooms: [],
    online: {},
    members: {},
    typing: {},
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
      const { data } = await http.get<{ mine: RoomSummary[]; public: RoomSummary[] }>('/rooms');
      this.rooms = data;
      const mineIds = new Set(data.mine.map((room) => room.id));
      for (const roomId of [...this.watchedRooms]) {
        if (!mineIds.has(roomId)) {
          this.unwatchRoom(roomId);
        }
      }
      this.watchRooms();
      this.updateTitle();
    },
    bind() {
      if (this.bound) {
        return;
      }
      this.bound = true;
      const socket = getSocket();
      this.connected = socket.connected;
      socket.on('message:new', (payload: NewMessagePayload) => {
        void this.handleNew(payload.roomId, payload.message);
      });
      socket.on('message:delta', (payload: DeltaPayload) => {
        this.handleDelta(payload);
      });
      socket.on('message:final', (payload: FinalPayload) => {
        void this.handleFinal(payload);
      });
      socket.on('message:updated', (payload: UpdatedPayload) => {
        this.handleUpdated(payload.roomId, payload.message);
      });
      socket.on('presence', (payload: PresencePayload) => {
        this.handlePresence(payload);
      });
      socket.on('typing', (payload: TypingPayload) => {
        this.handleTyping(payload);
      });
      socket.on('system:notice', (payload: NoticePayload) => {
        ElMessage.warning(payload.message);
      });
      socket.on('room:revoked', (payload: RevokedPayload) => {
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
      socket.on('connect', () => {
        this.connected = true;
        this.watchedRooms = [];
        this.watchRooms();
        void this.loadRooms().catch(() => {
          // reconnect will retry; avoid toast spam
        });
        if (this.currentRoomId != null) {
          void this.rejoin(this.currentRoomId);
        }
      });
      socket.on('disconnect', () => {
        this.connected = false;
      });
      socket.on('connect_error', () => {
        this.connected = false;
      });
      window.setInterval(() => {
        const now = Date.now();
        for (const [roomId, list] of Object.entries(this.typing)) {
          const fresh = list.filter((user) => now - user.at < 4000);
          if (fresh.length !== list.length) {
            this.typing[Number(roomId)] = fresh;
          }
        }
      }, 2000);
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          for (const roomId of readPending.keys()) {
            void this.flushRead(roomId);
          }
        }
      });
    },
    async openRoom(roomId: number, inviteCode?: string) {
      if (this.currentRoomId != null && this.currentRoomId !== roomId) {
        this.leaveSocket(this.currentRoomId);
      }
      this.currentRoomId = roomId;
      this.loading = true;
      try {
        await http.post(`/rooms/${roomId}/join`, {
          inviteCode: inviteCode || undefined,
        });
        await waitForSocketConnect();
        await joinSocket(roomId, true);
        this.watchRooms();
        const { data } = await http.get<{ messages: Message[]; hasMore: boolean }>(
          `/rooms/${roomId}/messages`,
          { params: { limit: 50 } },
        );
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
        this.lastSeq[roomId] = Math.max(this.lastSeq[roomId] ?? 0, latest?.seq ?? 0);
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
        this.markRoomRead(roomId);
        if (latest) {
          this.updateRoomPreview(roomId, latest, { markRead: true });
          this.markRead(roomId, latest.seq);
        }
      } catch (error) {
        ElMessage.error(errorMessage(error));
      } finally {
        this.loading = false;
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
    send(content: string, onDone?: (ok: boolean) => void, replyToId?: number) {
      const roomId = this.currentRoomId;
      if (roomId == null || content.trim().length === 0) {
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
    ) {
      if (!document.hidden || !content) {
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
      try {
        const notification = new Notification(`${senderName} · ${room?.name ?? '新消息'}`, {
          body: content.slice(0, 140),
          tag: `bfa-room-${roomId}`,
        });
        notification.onclick = () => {
          window.focus();
          notification.close();
        };
      } catch {
        // Notification can fail in restricted contexts; ignore.
      }
    },
    updateTitle() {
      const total = this.rooms.mine.reduce(
        (sum, room) => sum + Math.max(room.unreadCount, 0),
        0,
      );
      document.title = total > 0 ? `(${total}) bot-for-all` : 'bot-for-all';
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
    updateRoomPreview(
      roomId: number,
      message: Message,
      options: { markRead?: boolean; incrementUnread?: boolean },
    ) {
      const content = message.content
        ? plainPreview(message.content)
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
    async toggleReaction(roomId: number, seq: number, emoji: string): Promise<Message> {
      const { data } = await http.post<{ message: Message }>(
        `/rooms/${roomId}/messages/${seq}/reactions`,
        { emoji },
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
      for (;;) {
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
        this.maybeNotify(roomId, message.senderId, message.senderName, message.content);
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
        await this.fillGap(roomId);
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
        );
        this.updateTitle();
        return;
      }
      let target = this.messages[payload.roomId]?.find(
        (message) => message.seq === payload.seq,
      );
      if (!target) {
        await this.fillGap(payload.roomId);
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
    handlePresence(payload: PresencePayload) {
      this.online[payload.roomId] = payload.onlineUserIds;
      const members = this.members[payload.roomId];
      if (members) {
        for (const member of members) {
          member.online = payload.onlineUserIds.includes(member.userId);
        }
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
