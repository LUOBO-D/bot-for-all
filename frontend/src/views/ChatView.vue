<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import BotDialog from '../components/BotDialog.vue';
import Composer from '../components/Composer.vue';
import EditHistoryDialog from '../components/EditHistoryDialog.vue';
import ForwardDialog from '../components/ForwardDialog.vue';
import Icon from '../components/Icon.vue';
import MediaGalleryDialog from '../components/MediaGalleryDialog.vue';
import MemberList from '../components/MemberList.vue';
import MemberProfileDialog from '../components/MemberProfileDialog.vue';
import MessageList from '../components/MessageList.vue';
import PollDialog from '../components/PollDialog.vue';
import ReportDialog from '../components/ReportDialog.vue';
import RoomSettingsDialog from '../components/RoomSettingsDialog.vue';
import RoomSidebar from '../components/RoomSidebar.vue';
import ScheduleDialog from '../components/ScheduleDialog.vue';
import http, { errorMessage } from '../api/http';
import { useAuthStore } from '../stores/auth';
import { useChatStore } from '../stores/chat';
import { getSocket } from '../socket';
import type { Member, Message } from '../types';
import { avatarClass, formatTime, initialOf, plainPreview } from '../utils/format';

/** One stored revision returned by the edit-history endpoint. */
interface MessageEditItem {
  oldContent: string;
  editedBy: number;
  editorName: string;
  editedAt: string;
}

interface MessageEditsResponse {
  current: string;
  edits: MessageEditItem[];
}

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const chat = useChatStore();

const sidebarOpen = ref(false);
const membersOpen = ref(false);
// The mobile "more" sheet holds the actions the topbar no longer shows at
// 390px; it is only reachable from the compact bar.
const moreOpen = ref(false);
const messageListRef = ref<InstanceType<typeof MessageList> | null>(null);
const profileVisible = ref(false);
const profileMember = ref<Member | null>(null);
const botVisible = ref(false);
const settingsVisible = ref(false);
const pinsOpen = ref(false);
// The gallery lists every attachment bound to a live message in this room;
// it fetches its own pages, so the view only owns the open flag.
const mediaOpen = ref(false);
const pinnedMessages = ref<Message[]>([]);
const pinnedLoading = ref(false);
// The pin filter is view-only: it never changes what is pinned, so unpinning
// and jumping keep working from the filtered rows, and clearing it restores
// the full list. Matching ignores case and looks at content plus sender.
const pinQuery = ref('');
const pinSearching = computed(() => pinQuery.value.trim().length > 0);
const pinFiltered = computed(() => {
  const query = pinQuery.value.trim().toLowerCase();
  if (!query) return pinnedMessages.value;
  return pinnedMessages.value.filter((message) =>
    `${message.senderName}\n${message.content}`.toLowerCase().includes(query),
  );
});
const replyTarget = ref<Message | null>(null);
const editingMessage = ref<Message | null>(null);
const forwardSourceSeqs = ref<number[]>([]);
const forwardVisible = ref(false);
// The composer hands over its text plus a `done` ack; the dialog keeps both
// until it closes, so a queued row can clear exactly that draft.
const scheduleVisible = ref(false);
const scheduleContent = ref('');
const scheduleDone = ref<((ok: boolean) => void) | null>(null);
const pollVisible = ref(false);
const reportTarget = ref<Message | null>(null);
const reportVisible = ref(false);
// Edit history is fetched per message: the dialog only renders what this view
// loaded, so closing (or leaving the room) cannot leak another message's trail.
const historyTarget = ref<Message | null>(null);
const historyVisible = ref(false);
const historyLoading = ref(false);
const historyError = ref('');
const historyCurrent = ref('');
const historyEdits = ref<MessageEditItem[]>([]);
let historyRequestId = 0;
const searchOpen = ref(false);
const searchQuery = ref('');
// Search history is personal and room-scoped (see searchStorageKey); the list
// only mirrors what the current room's storage holds, newest first.
const recentQueries = ref<string[]>([]);
// Filters narrow the content query with AND; empty string means "not set".
const searchSenderId = ref<number | ''>('');
const searchFrom = ref('');
const searchTo = ref('');
const searchFilterError = ref('');
const searchResults = ref<Message[]>([]);
// `hasMore` comes from the server; the load-more button pages by the number of
// results already shown, so it is also the offset for the next request.
const searchHasMore = ref(false);
const searchLoadingMore = ref(false);
const searching = ref(false);
// A failed request is not an empty result set: keep its own state so the panel
// can offer a retry instead of claiming there were no matches.
const searchError = ref('');
// Retry re-runs the same query/filter watcher without pretending anything
// about the inputs changed.
const searchRetry = ref(0);
const highlightSeq = ref<number | null>(null);
// Multi-select is open to every member (bulk forward); only bulk delete stays
// moderator-only. Seqs, not objects, keep a row's identity across a re-render.
const selectMode = ref(false);
const selectedSeqs = ref<Set<number>>(new Set());
const bulkDeleting = ref(false);
let searchTimer: number | undefined;
let highlightTimer: number | undefined;
let searchRequestId = 0;

// Mobile edge swipe: a rightward drag that begins against the left edge opens
// the room drawer. The chat column owns the listeners so the gesture works
// over the top bar and the message list alike, and it stays inert on desktop.
const MOBILE_BREAKPOINT = 860;
const EDGE_START_MAX_X = 24;
const EDGE_OPEN_DISTANCE = 60;
const EDGE_VERTICAL_SLOP = 40;
const EDGE_DECIDE_SLOP = 10;
let edgeStartX = 0;
let edgeStartY = 0;
let edgeTracking = false;
let edgeHorizontal = false;

const roomId = computed(() => Number(route.params.id));
const inviteCode = computed(() =>
  typeof route.query.invite === 'string' ? route.query.invite : undefined,
);
// ?seq= deep-links to a single message (global search results, notifications).
// Anything that is not a positive integer is ignored.
const seqParam = computed(() => {
  const raw = route.query.seq;
  const value = typeof raw === 'string' ? Number(raw) : Number.NaN;
  return Number.isInteger(value) && value > 0 ? value : null;
});
const room = computed(() => chat.currentRoom);
const roomInitial = computed(() => initialOf(room.value?.name ?? 'R'));
const announcementText = computed(() => room.value?.announcement?.trim() ?? '');
// A dismissal is remembered per account and room as a fingerprint of the
// text it hid: an admin edit changes the fingerprint, so the announcement
// comes back on its own without the browser keeping a copy of the content.
const announcementFingerprint = computed(() => fingerprintAnnouncement(announcementText.value));
const dismissedAnnouncementFingerprint = ref<string | null>(null);
const showAnnouncement = computed(
  () =>
    announcementText.value.length > 0 &&
    dismissedAnnouncementFingerprint.value !== announcementFingerprint.value,
);
// Slow mode arrives with the room summary, but a PATCH only rebroadcasts
// `room:updated`; mirroring the interval locally keeps the chip live for
// everyone in the room instead of waiting for the next rooms refresh.
const slowModeOverride = ref<number | null>(null);
const slowModeSeconds = computed(
  () => slowModeOverride.value ?? room.value?.slowModeSeconds ?? 0,
);
const canModerate = computed(() => {
  const user = auth.user;
  if (!room.value || !user) {
    return false;
  }
  if (user.role === 'admin' || room.value.ownerId === user.id) {
    return true;
  }
  return chat.currentMembers.some(
    (member) => member.userId === user.id && member.role === 'admin',
  );
});
const selectedCount = computed(() => selectedSeqs.value.size);
const typingText = computed(() =>
  chat.typingUsers
    .filter((user) => user.userId !== auth.user?.id)
    .map((user) => user.displayName)
    .join('、'),
);

// Bots stream into a placeholder row; while one is still open the room has
// something the user may want to abort.
const hasStreamingBot = computed(() =>
  chat.currentMessages.some(
    (message) => message.senderType === 'bot' && message.status === 'streaming',
  ),
);
const stopBotsBusy = ref(false);

async function handleStopBots() {
  if (stopBotsBusy.value) {
    return;
  }
  stopBotsBusy.value = true;
  try {
    const canceled = await chat.stopBots();
    if (canceled) {
      ElMessage.success('已停止机器人回复');
    } else if (hasStreamingBot.value) {
      // Still streaming means the request never reached the server (or its ack
      // timed out), so the generation is untouched.
      ElMessage.error('停止失败，请重试');
    } else {
      ElMessage.warning('没有正在生成的回复');
    }
  } finally {
    stopBotsBusy.value = false;
  }
}

function handleSend(
  content: string,
  attachmentIds: number[],
  done: (ok: boolean) => void,
) {
  const editing = editingMessage.value;
  if (editing) {
    chat.editMessage(roomId.value, editing.seq, content).then(
      () => {
        done(true);
        editingMessage.value = null;
      },
      (error: unknown) => {
        done(false);
        ElMessage.error(errorMessage(error));
      },
    );
    return;
  }
  const target = replyTarget.value;
  chat.send(
    content,
    (ok) => {
      done(ok);
      if (ok) {
        replyTarget.value = null;
      }
    },
    target?.id,
    attachmentIds,
  );
}

function setReply(message: Message) {
  editingMessage.value = null;
  replyTarget.value = message;
}

function clearReply() {
  replyTarget.value = null;
}

function startEdit(message: Message) {
  replyTarget.value = null;
  editingMessage.value = message;
}

function cancelEdit() {
  editingMessage.value = null;
}

function startForward(message: Message) {
  forwardSourceSeqs.value = [message.seq];
  forwardVisible.value = true;
}

// Bulk forward is all-or-nothing: validate the whole selection before opening
// the dialog so a single withdrawn or missing row aborts every message.
// Attachments and polls pass: the server copies attachment files into the
// target room and turns a forwarded poll into a fresh vote.
// The set is seq-based and bounded by the endpoint's 1..10 contract, which
// matches the per-member message rate limit (10 per 10s): a full batch spends
// one window, so anything larger would be rejected server-side.
const FORWARD_BULK_LIMIT = 10;
const FORWARD_UNSUPPORTED_HINT = '选中的消息包含已撤回或已失效的内容，暂不支持转发';

function isForwardable(message: Message): boolean {
  return !message.deleted;
}

function handleBulkForward() {
  const seqs = [...selectedSeqs.value].sort((a, b) => a - b);
  if (!seqs.length) {
    return;
  }
  if (seqs.length > FORWARD_BULK_LIMIT) {
    ElMessage.warning(`一次最多转发 ${FORWARD_BULK_LIMIT} 条消息`);
    return;
  }
  const bySeq = new Map(chat.currentMessages.map((message) => [message.seq, message]));
  const unsupported = seqs.some((seq) => {
    const message = bySeq.get(seq);
    return !message || !isForwardable(message);
  });
  if (unsupported) {
    ElMessage.warning(FORWARD_UNSUPPORTED_HINT);
    return;
  }
  forwardSourceSeqs.value = seqs;
  forwardVisible.value = true;
}

function startReport(message: Message) {
  reportTarget.value = message;
  reportVisible.value = true;
}

function openSchedule(content: string, done: (ok: boolean) => void) {
  scheduleContent.value = content;
  scheduleDone.value = done;
  scheduleVisible.value = true;
}

// Closing drops the composer's ack: a reopened dialog must never call the
// previous draft's callback (or clear text the user has since typed).
watch(scheduleVisible, (open) => {
  if (!open) {
    scheduleDone.value = null;
  }
});

// The dialog has already toasted; refresh previews so the target room's
// unread badge and last-message line reflect the forwarded copy.
function handleForwarded() {
  void chat.loadRooms().catch(() => undefined);
}

const forwardPreview = computed(() => {
  if (forwardSourceSeqs.value.length !== 1) {
    return '';
  }
  const seq = forwardSourceSeqs.value[0];
  const message = chat.currentMessages.find((item) => item.seq === seq);
  if (!message) {
    return '';
  }
  // A poll's `content` mirrors its question; reading the poll payload keeps the
  // preview correct even if the two ever drift. An attachment-only message has
  // no text to show, so name the payload instead.
  const text = message.poll?.question ?? message.content;
  return (
    plainPreview(text).slice(0, 120) ||
    ((message.attachments?.length ?? 0) > 0 ? '[附件]' : '')
  );
});

async function loadHistory() {
  const target = historyTarget.value;
  if (!target) {
    return;
  }
  const requestId = (historyRequestId += 1);
  historyLoading.value = true;
  historyError.value = '';
  try {
    const { data } = await http.get<MessageEditsResponse>(
      `/rooms/${target.roomId}/messages/${target.seq}/edits`,
    );
    if (requestId !== historyRequestId) {
      return;
    }
    historyCurrent.value =
      typeof data.current === 'string' ? data.current : target.content;
    historyEdits.value = Array.isArray(data.edits) ? data.edits : [];
  } catch (error) {
    if (requestId !== historyRequestId) {
      return;
    }
    historyError.value = errorMessage(error);
    ElMessage.error(historyError.value);
  } finally {
    if (requestId === historyRequestId) {
      historyLoading.value = false;
    }
  }
}

function openHistory(message: Message) {
  historyTarget.value = message;
  historyCurrent.value = message.content;
  historyEdits.value = [];
  historyVisible.value = true;
  void loadHistory();
}

// Closing always drops the trail: a reopened dialog must never show the
// previous message's revisions while the new request is in flight.
watch(historyVisible, (open) => {
  if (open) {
    return;
  }
  historyTarget.value = null;
  historyCurrent.value = '';
  historyEdits.value = [];
  historyError.value = '';
  historyLoading.value = false;
  historyRequestId += 1;
});

// ArrowUp on an empty composer edits the newest message this account can
// still edit (same eligibility rule the message row uses).
function editLast() {
  const userId = auth.user?.id;
  if (userId == null) {
    return;
  }
  const list = chat.currentMessages;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index];
    if (
      message.senderId === userId &&
      message.senderType === 'user' &&
      !message.deleted &&
      message.status === 'done'
    ) {
      startEdit(message);
      return;
    }
  }
}

async function markCurrentRead() {
  const latestSeq = chat.currentMessages.reduce(
    (max, message) => Math.max(max, message.seq),
    0,
  );
  if (latestSeq <= 0) {
    return;
  }
  chat.markRead(roomId.value, latestSeq);
  await chat.flushRead(roomId.value);
  chat.markRoomRead(roomId.value);
  ElMessage.success('已标记为已读');
}

// Shift+Esc stays global: it must fire even while the composer has focus,
// and the composer leaves modified Escape keys alone.
function onGlobalKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || event.ctrlKey || event.metaKey || event.altKey) {
    return;
  }
  if (event.shiftKey) {
    event.preventDefault();
    void markCurrentRead();
    return;
  }
  // A control that already claimed Escape (the composer cancelling an edit or
  // reply) keeps it; selection only takes the key when nobody else did.
  if (event.defaultPrevented) {
    return;
  }
  if (selectMode.value && !overlayVisible()) {
    event.preventDefault();
    exitSelectMode();
  }
}

// Element Plus keeps closed overlays mounted (`display: none`), so presence in
// the DOM is not enough: only a painted confirm box/dialog/drawer owns Escape.
function overlayVisible(): boolean {
  for (const overlay of document.querySelectorAll<HTMLElement>('.el-overlay')) {
    if (overlay.getClientRects().length > 0) {
      return true;
    }
  }
  return false;
}

function enterSelectMode() {
  if (!room.value) {
    return;
  }
  selectMode.value = true;
  selectedSeqs.value = new Set();
}

function exitSelectMode() {
  selectMode.value = false;
  selectedSeqs.value = new Set();
}

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(target.closest('input, textarea, select, [contenteditable="true"]'))
  );
}

function resetEdgeSwipe() {
  edgeTracking = false;
  edgeHorizontal = false;
}

function onEdgeTouchStart(event: TouchEvent) {
  resetEdgeSwipe();
  if (
    event.touches.length !== 1 ||
    window.innerWidth > MOBILE_BREAKPOINT ||
    selectMode.value ||
    isEditableTarget(event.target)
  ) {
    return;
  }
  const touch = event.touches[0];
  // Only a drag that starts against the left edge is an open-drawer gesture;
  // anywhere else the row gesture (reply) or a normal tap owns the touch.
  if (touch.clientX > EDGE_START_MAX_X || overlayVisible()) {
    return;
  }
  edgeStartX = touch.clientX;
  edgeStartY = touch.clientY;
  edgeTracking = true;
}

function onEdgeTouchMove(event: TouchEvent) {
  if (!edgeTracking) {
    return;
  }
  if (event.touches.length !== 1) {
    resetEdgeSwipe();
    return;
  }
  const touch = event.touches[0];
  const dx = touch.clientX - edgeStartX;
  const dy = touch.clientY - edgeStartY;
  // A drag that drifts vertically past the slop is a scroll, not a drawer
  // pull — including one that started horizontally but changed direction.
  if (Math.abs(dy) >= EDGE_VERTICAL_SLOP) {
    resetEdgeSwipe();
    return;
  }
  if (!edgeHorizontal) {
    if (Math.abs(dx) < EDGE_DECIDE_SLOP && Math.abs(dy) < EDGE_DECIDE_SLOP) {
      return;
    }
    // Leftward or vertical-first movement belongs to the browser/list.
    if (dx <= 0 || Math.abs(dy) >= dx) {
      resetEdgeSwipe();
      return;
    }
    edgeHorizontal = true;
  }
  // From here the gesture is ours; until this point scrolling was never
  // blocked, so a vertical flick keeps its native momentum.
  event.preventDefault();
  if (dx > EDGE_OPEN_DISTANCE) {
    resetEdgeSwipe();
    sidebarOpen.value = true;
  }
}

function onEdgeTouchEnd() {
  resetEdgeSwipe();
}

function toggleSelect(message: Message) {
  if (!selectMode.value || message.deleted) {
    return;
  }
  const next = new Set(selectedSeqs.value);
  if (next.has(message.seq)) {
    next.delete(message.seq);
  } else {
    next.add(message.seq);
  }
  selectedSeqs.value = next;
}

async function handleBulkDelete() {
  if (bulkDeleting.value) {
    return;
  }
  const seqs = [...selectedSeqs.value];
  if (!seqs.length) {
    return;
  }
  try {
    await ElMessageBox.confirm(
      `确定删除选中的 ${seqs.length} 条消息？删除后会显示为「消息已撤回」。`,
      '批量删除消息',
      { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' },
    );
  } catch {
    return;
  }
  bulkDeleting.value = true;
  try {
    const result = await chat.bulkDeleteMessages(roomId.value, seqs);
    // The composer must not keep editing/replying to a row it just withdrew.
    if (editingMessage.value && selectedSeqs.value.has(editingMessage.value.seq)) {
      editingMessage.value = null;
    }
    if (replyTarget.value && selectedSeqs.value.has(replyTarget.value.seq)) {
      replyTarget.value = null;
    }
    exitSelectMode();
    ElMessage.success(
      result.skipped > 0
        ? `已删除 ${result.deleted} 条，跳过 ${result.skipped} 条`
        : `已删除 ${result.deleted} 条消息`,
    );
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    bulkDeleting.value = false;
  }
}

// The media library can withdraw a row the composer is still editing or
// replying to; drop that target so the next send does not reference a ghost.
function handleGalleryDeleted(seqs: number[]) {
  const gone = new Set(seqs);
  if (editingMessage.value && gone.has(editingMessage.value.seq)) {
    editingMessage.value = null;
  }
  if (replyTarget.value && gone.has(replyTarget.value.seq)) {
    replyTarget.value = null;
  }
}

async function handleDelete(message: Message) {
  try {
    await ElMessageBox.confirm(
      '删除后消息会显示为「消息已撤回」，确定删除？',
      '删除消息',
      { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' },
    );
  } catch {
    return;
  }
  try {
    await chat.deleteMessage(roomId.value, message.seq);
    if (editingMessage.value?.seq === message.seq) {
      editingMessage.value = null;
    }
  } catch (error) {
    ElMessage.error(errorMessage(error));
  }
}

async function handleReact(message: Message, emoji: string) {
  try {
    await chat.toggleReaction(roomId.value, message.seq, emoji);
  } catch (error) {
    ElMessage.error(errorMessage(error));
  }
}

// The card owns its pending ballot and its busy state; this handler only talks
// to the server and reports the outcome back through `done`. Replacements and
// duplicates are server decisions (409 POLL_CLOSED, 400 INVALID_OPTION), so
// the API message is surfaced verbatim.
async function handleVote(
  message: Message,
  optionIds: number[],
  done: (ok: boolean) => void,
) {
  try {
    await chat.votePoll(message.roomId, message.seq, optionIds);
    done(true);
  } catch (error) {
    done(false);
    ElMessage.error(errorMessage(error));
  }
}

// The card confirms first and then emits; this handler owns the request, the
// toast, and releasing the card's busy state.
async function handlePollClose(message: Message, done: (ok: boolean) => void) {
  try {
    await chat.closePoll(message.roomId, message.seq);
    done(true);
    ElMessage.success('投票已截止');
  } catch (error) {
    done(false);
    ElMessage.error(errorMessage(error));
  }
}

async function handlePin(message: Message, pinned: boolean) {
  try {
    const updated = await chat.pinMessage(roomId.value, message.seq, pinned);
    if (pinned) {
      if (!pinnedMessages.value.some((item) => item.seq === updated.seq)) {
        pinnedMessages.value = [updated, ...pinnedMessages.value];
      }
    } else {
      pinnedMessages.value = pinnedMessages.value.filter((item) => item.seq !== updated.seq);
    }
  } catch (error) {
    ElMessage.error(errorMessage(error));
  }
}

function handleProfile(member: Member) {
  profileMember.value = member;
  profileVisible.value = true;
}

async function handleKick(member: Member) {
  try {
    await http.delete(`/rooms/${roomId.value}/members/${member.userId}`);
    await chat.refreshMembers(roomId.value);
    ElMessage.success(`已将 ${member.displayName} 移出房间`);
  } catch (error) {
    ElMessage.error(errorMessage(error));
  }
}

async function handleSetRole(member: Member, role: 'admin' | 'member') {
  try {
    await http.patch(`/rooms/${roomId.value}/members/${member.userId}`, { role });
    await chat.refreshMembers(roomId.value);
    ElMessage.success(
      role === 'admin'
        ? `已将 ${member.displayName} 设为管理员`
        : `已取消 ${member.displayName} 的管理员`,
    );
  } catch (error) {
    ElMessage.error(errorMessage(error));
  }
}

async function handleSetRoles(
  userIds: number[],
  role: 'admin' | 'member',
  done: (ok: boolean) => void,
) {
  try {
    const { data } = await http.patch<{ updated: number }>(
      `/rooms/${roomId.value}/members/roles`,
      { userIds, role },
    );
    await chat.refreshMembers(roomId.value);
    ElMessage.success(`已更新 ${data.updated} 名成员角色`);
    done(true);
  } catch (error) {
    ElMessage.error(errorMessage(error));
    done(false);
  }
}

async function handleRemoveMembers(userIds: number[], done: (ok: boolean) => void) {
  try {
    const { data } = await http.delete<{ removed: number }>(`/rooms/${roomId.value}/members`, {
      data: { userIds },
    });
    await chat.refreshMembers(roomId.value);
    ElMessage.success(`已移出 ${data.removed} 名成员`);
    done(true);
  } catch (error) {
    ElMessage.error(errorMessage(error));
    done(false);
  }
}

async function loadPins() {
  pinnedLoading.value = true;
  try {
    pinnedMessages.value = await chat.loadPinned(roomId.value);
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    pinnedLoading.value = false;
  }
}

function togglePins() {
  pinsOpen.value = !pinsOpen.value;
  if (pinsOpen.value) {
    void loadPins();
  }
}

function loadOlder() {
  return chat.loadOlder(roomId.value);
}

// Search history and filters belong to one account in one room: the key
// carries both ids, so a shared browser never shows another member's queries
// and each room keeps its own last sender/date pair. Storage is best-effort
// (private mode, quota) and every read treats a corrupted value as empty.
const SEARCH_RECENT_LIMIT = 5;
const SEARCH_QUERY_MAX = 100;
const SEARCH_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

interface SearchFilters {
  senderId: number | '';
  from: string;
  to: string;
}

function searchStorageKey(kind: 'recent' | 'filters'): string | null {
  const userId = auth.user?.id;
  const id = roomId.value;
  if (!userId || !Number.isInteger(id) || id <= 0) {
    return null;
  }
  return `bfa_search_${kind}_${userId}_${id}`;
}

function readStoredSearch(key: string | null): unknown {
  if (!key) {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

function writeStoredSearch(key: string | null, value: unknown) {
  if (!key) {
    return;
  }
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode or a full quota: search still works, it just forgets.
  }
}

// Announcement dismissals follow the same per-account, per-room key shape.
// The value is only a fingerprint (FNV-1a plus length) of the trimmed text:
// stable across reloads, and enough to notice an edit without storing the
// announcement itself.
function announcementStorageKey(): string | null {
  const userId = auth.user?.id;
  const id = roomId.value;
  if (!userId || !Number.isInteger(id) || id <= 0) {
    return null;
  }
  return `bfa_announcement_${userId}_${id}`;
}

function fingerprintAnnouncement(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${text.length.toString(36)}:${hash.toString(36)}`;
}

function readDismissedAnnouncement(): string | null {
  const key = announcementStorageKey();
  if (!key) {
    return null;
  }
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function rememberDismissedAnnouncement(fingerprint: string) {
  const key = announcementStorageKey();
  if (!key) {
    return;
  }
  try {
    window.localStorage.setItem(key, fingerprint);
  } catch {
    // Private mode or a full quota: the close button still hides it now.
  }
}

function dismissAnnouncement() {
  const fingerprint = announcementFingerprint.value;
  if (!fingerprint || !announcementText.value) {
    return;
  }
  dismissedAnnouncementFingerprint.value = fingerprint;
  rememberDismissedAnnouncement(fingerprint);
}

// Mount, room switch, login switch, or an edited announcement: whatever this
// account already closed for the text on screen stays closed. Waiting until
// the room on screen matches the route keeps one room's key from being read
// while the previous room's summary is still rendered. An unreadable or
// missing value simply shows the announcement again.
watch(
  [
    announcementFingerprint,
    () => roomId.value,
    () => chat.currentRoom?.id ?? null,
    () => auth.user?.id ?? null,
  ],
  () => {
    if (chat.currentRoom?.id !== roomId.value) {
      return;
    }
    dismissedAnnouncementFingerprint.value = readDismissedAnnouncement();
  },
  { immediate: true },
);

function normalizeSearchDate(value: unknown): string {
  if (typeof value !== 'string' || !SEARCH_DATE_PATTERN.test(value)) {
    return '';
  }
  // The pattern alone accepts 2026-13-45; a date the picker could not produce
  // would make every request fail, so drop it instead.
  return Number.isNaN(Date.parse(`${value}T00:00:00`)) ? '' : value;
}

function readRecentQueries(): string[] {
  const stored = readStoredSearch(searchStorageKey('recent'));
  if (!Array.isArray(stored)) {
    return [];
  }
  const seen = new Set<string>();
  const list: string[] = [];
  for (const entry of stored) {
    if (typeof entry !== 'string') {
      continue;
    }
    const query = entry.trim().slice(0, SEARCH_QUERY_MAX);
    if (!query || seen.has(query)) {
      continue;
    }
    seen.add(query);
    list.push(query);
    if (list.length === SEARCH_RECENT_LIMIT) {
      break;
    }
  }
  return list;
}

function readSearchFilters(): SearchFilters {
  const stored = readStoredSearch(searchStorageKey('filters'));
  const filters: SearchFilters = { senderId: '', from: '', to: '' };
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    return filters;
  }
  const record = stored as Record<string, unknown>;
  const sender = record.senderId;
  if (typeof sender === 'number' && Number.isInteger(sender) && sender > 0) {
    filters.senderId = sender;
  }
  filters.from = normalizeSearchDate(record.from);
  filters.to = normalizeSearchDate(record.to);
  return filters;
}

function writeRecentQueries(list: string[]) {
  const key = searchStorageKey('recent');
  if (!key) {
    return;
  }
  if (!list.length) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Nothing to clean up when storage is unavailable.
    }
    return;
  }
  writeStoredSearch(key, list);
}

// Enter records the query; the same text moves to the front instead of
// appearing twice, and the list stays a one-glance row of five.
function rememberSearchQuery(raw: string) {
  const query = raw.trim().slice(0, SEARCH_QUERY_MAX);
  if (!query) {
    return;
  }
  const next = [query, ...recentQueries.value.filter((item) => item !== query)].slice(
    0,
    SEARCH_RECENT_LIMIT,
  );
  recentQueries.value = next;
  writeRecentQueries(next);
}

// A chip is a search: filling the input re-runs the existing watcher, and the
// query jumps back to the front of the history.
function applyRecentQuery(query: string) {
  searchQuery.value = query;
  rememberSearchQuery(query);
}

// Enter records the query. Confirming an IME candidate also arrives as Enter,
// so the composition flags keep that key inside the input.
function onSearchInputKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) {
    return;
  }
  event.preventDefault();
  rememberSearchQuery(searchQuery.value);
}

function clearRecentQueries() {
  recentQueries.value = [];
  writeRecentQueries([]);
}

// Called on mount and on every room switch: the incoming room's history and
// last filters replace the previous room's.
function loadSearchPreferences() {
  recentQueries.value = readRecentQueries();
  const filters = readSearchFilters();
  searchSenderId.value = filters.senderId;
  searchFrom.value = filters.from;
  searchTo.value = filters.to;
  searchFilterError.value = '';
  searchError.value = '';
}

// Filters are a preference, not part of one query, so closing the panel or
// leaving the room keeps them. `sync` files each change under the room that
// produced it, so a pending room switch cannot store it under the next key.
watch(
  [searchSenderId, searchFrom, searchTo],
  () => {
    const key = searchStorageKey('filters');
    if (!key) {
      return;
    }
    writeStoredSearch(key, {
      senderId: searchSenderId.value,
      from: searchFrom.value,
      to: searchTo.value,
    });
  },
  { flush: 'sync' },
);

// A stored sender may have left the room since the filter was saved; an
// unknown id would filter invisibly (the select falls back to its blank
// state), so opening the panel drops it once the current roster is known.
function pruneMissingSender() {
  if (searchSenderId.value === '' || chat.currentRoom?.id !== roomId.value) {
    return;
  }
  const members = chat.currentMembers;
  if (!members.length) {
    return;
  }
  if (members.some((member) => member.userId === searchSenderId.value)) {
    return;
  }
  searchSenderId.value = '';
}

function toggleSearch() {
  searchOpen.value = !searchOpen.value;
  if (!searchOpen.value) {
    searchQuery.value = '';
    resetSearchResults();
    searchFilterError.value = '';
    searchError.value = '';
    return;
  }
  pruneMissingSender();
}

/** Room search page size; the server caps it at 50 either way. */
const SEARCH_PAGE_SIZE = 20;

interface SearchResponse {
  messages: Message[];
  hasMore: boolean;
}

/** Current query + filters as request params, or null when there is no query. */
function currentSearchParams(): Record<string, string | number> | null {
  const value = searchQuery.value.trim();
  if (!value) {
    return null;
  }
  const params: Record<string, string | number> = { q: value, limit: SEARCH_PAGE_SIZE };
  if (searchSenderId.value !== '') {
    params.senderId = searchSenderId.value;
  }
  if (searchFrom.value) {
    params.from = searchFrom.value;
  }
  if (searchTo.value) {
    params.to = searchTo.value;
  }
  return params;
}

// Any query or filter change starts a new search: the old page (and its
// offset) is dropped so a later load-more cannot append another filter set.
function resetSearchResults() {
  searchResults.value = [];
  searchHasMore.value = false;
  searchLoadingMore.value = false;
}

// The content query and every filter are AND-ed, so any change re-runs the
// search. An inverted date range is a local error: the server would reject it
// with 400, so no request is sent while the form is invalid.
watch([searchQuery, searchSenderId, searchFrom, searchTo, searchRetry], () => {
  window.clearTimeout(searchTimer);
  searchRequestId += 1;
  resetSearchResults();
  const params = currentSearchParams();
  if (!params) {
    searchFilterError.value = '';
    searchError.value = '';
    searching.value = false;
    return;
  }
  if (searchFrom.value && searchTo.value && searchFrom.value > searchTo.value) {
    searchFilterError.value = '开始日期不能晚于结束日期';
    searchError.value = '';
    searching.value = false;
    return;
  }
  searchFilterError.value = '';
  searchError.value = '';
  // The previous page is already gone, so show the pending state during the
  // debounce as well; otherwise the empty list reads as "no matches".
  searching.value = true;

  searchTimer = window.setTimeout(async () => {
    const requestId = (searchRequestId += 1);
    try {
      const { data } = await http.get<SearchResponse>(
        `/rooms/${roomId.value}/search`,
        { params },
      );
      if (requestId !== searchRequestId) {
        return;
      }
      searchResults.value = data.messages;
      searchHasMore.value = data.hasMore;
    } catch {
      if (requestId === searchRequestId) {
        resetSearchResults();
        searchError.value = '搜索失败，请重试';
      }
    } finally {
      if (requestId === searchRequestId) {
        searching.value = false;
      }
    }
  }, 250);
});

// A failed search keeps its inputs; this re-runs them without the user having
// to touch the query (the watcher treats the counter as a new request).
function retrySearch() {
  searchRetry.value += 1;
}

// Appends the next page using the current filters and the shown result count
// as offset. A message deleted or inserted between pages shifts the seq
// window, so rows are de-duplicated by seq (a room-unique key) before append.
async function loadMoreSearchResults() {
  if (!searchHasMore.value || searchLoadingMore.value || searching.value) {
    return;
  }
  const params = currentSearchParams();
  if (!params) {
    return;
  }
  const requestId = (searchRequestId += 1);
  searchLoadingMore.value = true;
  try {
    const { data } = await http.get<SearchResponse>(`/rooms/${roomId.value}/search`, {
      params: { ...params, offset: searchResults.value.length },
    });
    if (requestId !== searchRequestId) {
      return;
    }
    const known = new Set(searchResults.value.map((message) => message.seq));
    searchResults.value = [
      ...searchResults.value,
      ...data.messages.filter((message) => !known.has(message.seq)),
    ];
    searchHasMore.value = data.hasMore;
  } catch (error) {
    if (requestId === searchRequestId) {
      searchError.value = '加载更多失败，请重试';
      ElMessage.error(errorMessage(error));
    }
  } finally {
    if (requestId === searchRequestId) {
      searchLoadingMore.value = false;
    }
  }
}

interface SearchSegment {
  text: string;
  hit: boolean;
}

// The query is user input, never a pattern: every regex metacharacter is
// escaped so `.` or `(` is searched literally instead of altering the match.
function escapeSearchPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The server matches case-insensitively, so the highlight does too (`i` flag).
// plainPreview truncation happens before splitting, so a hit never straddles
// the cut and the rendered text always equals the plain preview.
function searchSegments(content: string): SearchSegment[] {
  const preview = plainPreview(content).slice(0, 120);
  const needle = searchQuery.value.trim();
  if (!needle) {
    return [{ text: preview, hit: false }];
  }
  const pattern = new RegExp(escapeSearchPattern(needle), 'gi');
  const segments: SearchSegment[] = [];
  let cursor = 0;
  for (const match of preview.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      segments.push({ text: preview.slice(cursor, index), hit: false });
    }
    segments.push({ text: match[0], hit: true });
    cursor = index + match[0].length;
  }
  if (!segments.length) {
    return [{ text: preview, hit: false }];
  }
  if (cursor < preview.length) {
    segments.push({ text: preview.slice(cursor), hit: false });
  }
  return segments;
}

async function jumpTo(seq: number): Promise<boolean> {
  try {
    await chat.loadAround(roomId.value, seq);
  } catch (error) {
    ElMessage.error(errorMessage(error));
    return false;
  }
  // The list owns its window: setting the highlight first would only style a
  // row that may not be mounted yet. Ask it to unfold and wait for the row to
  // exist before deciding the message is unavailable.
  highlightSeq.value = seq;
  const found = await messageListRef.value?.revealMessage(seq);
  if (!found) {
    ElMessage.info('目标消息暂不可用，请稍后重试');
    return false;
  }
  window.clearTimeout(highlightTimer);
  highlightTimer = window.setTimeout(() => {
    highlightSeq.value = null;
  }, 2200);
  return true;
}

async function jumpToResult(message: Message) {
  searchOpen.value = false;
  searchQuery.value = '';
  resetSearchResults();
  searchFilterError.value = '';
  searchError.value = '';
  await jumpTo(message.seq);
}

async function jumpToPinned(message: Message) {
  pinsOpen.value = false;
  await jumpTo(message.seq);
}

// Guards against mount + watcher both jumping to the same target, and against
// re-jumping after the query is stripped.
let lastJumpedSeq: number | null = null;

async function applySeqQuery() {
  const seq = seqParam.value;
  if (seq == null || lastJumpedSeq === seq) {
    return;
  }
  lastJumpedSeq = seq;
  const jumped = await jumpTo(seq);
  if (!jumped) {
    // Leave ?seq= in place so a later visit can retry.
    lastJumpedSeq = null;
    return;
  }
  if (typeof route.query.seq !== 'string') {
    // Another navigation already cleared the parameter.
    lastJumpedSeq = null;
    return;
  }
  const query = { ...route.query };
  delete query.seq;
  await router.replace({ query });
  lastJumpedSeq = null;
}

onUnmounted(() => {
  window.clearTimeout(searchTimer);
  window.clearTimeout(highlightTimer);
  window.removeEventListener('keydown', onGlobalKeydown);
  resetEdgeSwipe();
});

onMounted(() => window.addEventListener('keydown', onGlobalKeydown));

// `room:updated` is broadcast to the whole room on PATCH, so every open tab
// follows the new slow-mode interval immediately.
const socket = getSocket();
function onRoomUpdated(payload: { roomId?: number; slowModeSeconds?: number }) {
  if (payload.roomId !== roomId.value || typeof payload.slowModeSeconds !== 'number') {
    return;
  }
  slowModeOverride.value = payload.slowModeSeconds;
}

onMounted(() => socket.on('room:updated', onRoomUpdated));
onUnmounted(() => socket.off('room:updated', onRoomUpdated));

// The invite code is a one-shot credential: once the join succeeded it is
// dropped from the URL so a refresh or a shared link cannot replay it.
async function openRoomWithInvite(id: number, invite: string | undefined): Promise<boolean> {
  const ok = await chat.openRoom(id, invite);
  if (!ok || !invite || !('invite' in route.query)) {
    return ok;
  }
  const query = { ...route.query };
  delete query.invite;
  await router.replace({ query });
  return ok;
}

// Marks a room switch in flight so the ?seq= watcher does not jump before
// openRoom finishes; the room watcher applies the jump once it resolves.
let openingRoomId: number | null = null;

async function openRoomAndApplySeq(id: number, invite: string | undefined) {
  openingRoomId = id;
  let opened = false;
  try {
    opened = await openRoomWithInvite(id, invite);
  } finally {
    // A slower, superseded open must not clear the flag the newer one set.
    if (openingRoomId === id) {
      openingRoomId = null;
    }
  }
  // A stale/superseded open has no room to jump into; the newest watcher run
  // applies its own ?seq= once it resolves.
  if (!opened || roomId.value !== id) {
    return;
  }
  await applySeqQuery();
}

// A failed open leaves the route pointing at a room that never loaded; the
// store's openError becomes a full-pane retryable state, not a toast.
const roomOpenError = computed(() => chat.openError);

function retryOpenRoom() {
  if (chat.loading) {
    return;
  }
  void openRoomAndApplySeq(roomId.value, inviteCode.value);
}

function backToRoomList() {
  void router.push('/rooms');
}

onMounted(async () => {
  chat.bind();
  loadSearchPreferences();
  try {
    await chat.loadRooms();
  } catch {
    // room loading errors are surfaced by openRoom
  }
  await openRoomAndApplySeq(roomId.value, inviteCode.value);
});

watch([roomId, inviteCode], async ([next, invite], [previous, previousInvite]) => {
  // A cleared invite (after a successful join) is not a new navigation.
  if (next && (next !== previous || (invite !== previousInvite && invite !== undefined))) {
    replyTarget.value = null;
    editingMessage.value = null;
    forwardSourceSeqs.value = [];
    forwardVisible.value = false;
    scheduleVisible.value = false;
    pollVisible.value = false;
    reportVisible.value = false;
    historyVisible.value = false;
    profileVisible.value = false;
    moreOpen.value = false;
    // The announcement dismissal is restored from storage once the incoming
    // room's summary resolves, so there is nothing to reset here.
    slowModeOverride.value = null;
    pinsOpen.value = false;
    pinnedMessages.value = [];
    mediaOpen.value = false;
    searchOpen.value = false;
    searchQuery.value = '';
    resetSearchResults();
    loadSearchPreferences();
    lastJumpedSeq = null;
    exitSelectMode();
    await openRoomAndApplySeq(next, invite);
  }
});

// Same-room ?seq= changes (e.g. a global search hit) jump without reopening.
// Room switches are handled by the watcher above once openRoom resolves.
watch(seqParam, async (seq) => {
  if (seq == null || openingRoomId != null || chat.currentRoom?.id !== roomId.value) {
    return;
  }
  await applySeqQuery();
});

onUnmounted(() => {
  chat.closeRoom();
});
</script>

<template>
  <div class="app-layout chat-layout">
    <RoomSidebar
      class="desktop-sidebar"
      :active-room-id="roomId"
      @navigate="sidebarOpen = false"
    />

    <main
      class="chat-main"
      @touchstart="onEdgeTouchStart"
      @touchmove="onEdgeTouchMove"
      @touchend="onEdgeTouchEnd"
      @touchcancel="onEdgeTouchEnd"
    >
      <header class="chat-topbar" data-testid="chat-topbar">
        <button class="icon-btn mobile-only" title="房间列表" @click="sidebarOpen = true">
          <Icon name="menu" />
        </button>
        <span class="avatar room-avatar" :class="avatarClass(roomId)">
          {{ roomInitial }}
        </span>
        <div class="chat-title">
          <h1 data-testid="room-title">{{ room?.name ?? '房间' }}</h1>
          <p class="chat-meta">
            {{ chat.currentOnline.length }} 在线 · {{ chat.currentMembers.length }} 成员
            <span v-if="room?.topic">· {{ room.topic }}</span>
          </p>
        </div>
        <span
          v-if="slowModeSeconds > 0"
          class="slow-mode-badge"
          data-testid="slow-mode-badge"
          :title="`慢速模式：每 ${slowModeSeconds} 秒只能发送一条消息`"
        >
          <span class="slow-mode-prefix">慢速模式 · </span>{{ slowModeSeconds }}s
        </span>
        <span class="spacer"></span>
        <button
          v-if="!selectMode"
          class="btn ghost small select-toggle topbar-secondary"
          type="button"
          data-testid="select-mode"
          title="多选消息"
          aria-label="选择"
          @click="enterSelectMode"
        >
          <Icon name="check" :size="13" />
          <span class="select-toggle-text">选择</span>
        </button>
        <button
          class="icon-btn topbar-secondary"
          type="button"
          title="媒体库"
          aria-label="媒体库"
          data-testid="media-open"
          @click="mediaOpen = true"
        >
          <Icon name="copy" />
        </button>
        <button
          class="icon-btn topbar-secondary"
          type="button"
          title="置顶消息"
          aria-label="置顶消息"
          @click="togglePins"
        >
          <Icon name="pin" />
        </button>
        <button
          class="icon-btn topbar-secondary"
          type="button"
          title="发起投票"
          aria-label="发起投票"
          data-testid="poll-open"
          @click="pollVisible = true"
        >
          <Icon name="plus" />
        </button>
        <button
          class="icon-btn topbar-search"
          type="button"
          title="搜索消息"
          aria-label="搜索消息"
          data-testid="search-open"
          @click="toggleSearch"
        >
          <Icon name="search" />
        </button>
        <button
          class="icon-btn topbar-members"
          type="button"
          title="成员"
          aria-label="成员"
          data-testid="members-open"
          @click="membersOpen = true"
        >
          <Icon name="users" />
        </button>
        <button
          v-if="canModerate"
          class="icon-btn topbar-secondary"
          type="button"
          title="机器人"
          aria-label="机器人"
          @click="botVisible = true"
        >
          <Icon name="bot" />
        </button>
        <button
          class="icon-btn topbar-secondary"
          type="button"
          title="房间设置"
          aria-label="房间设置"
          data-testid="settings-open"
          @click="settingsVisible = true"
        >
          <Icon name="settings" />
        </button>
        <button
          class="icon-btn topbar-more"
          type="button"
          title="更多"
          aria-label="更多操作"
          data-testid="more-open"
          @click="moreOpen = true"
        >
          <Icon name="more" />
        </button>
      </header>

      <div
        v-if="showAnnouncement"
        class="room-announcement"
        data-testid="room-announcement"
      >
        <span class="announcement-label">
          <Icon name="megaphone" :size="14" />
          公告
        </span>
        <div class="announcement-text">{{ announcementText }}</div>
        <button
          class="icon-btn announcement-close"
          title="关闭公告"
          aria-label="关闭公告"
          @click="dismissAnnouncement"
        >
          <Icon name="close" :size="14" />
        </button>
      </div>

      <div v-if="searchOpen" class="room-search-panel">
        <div class="room-search-bar">
          <Icon name="search" :size="16" />
          <input
            v-model="searchQuery"
            aria-label="搜索本房间消息"
            placeholder="搜索本房间消息"
            maxlength="100"
            @keydown="onSearchInputKeydown"
          />
          <button class="icon-btn small-icon" title="关闭搜索" @click="toggleSearch">
            <Icon name="close" :size="14" />
          </button>
        </div>
        <div
          v-if="!searchQuery.trim() && recentQueries.length"
          class="search-recent-row"
        >
          <span class="search-recent-label">最近</span>
          <div class="search-recent-list" data-testid="search-recent-list">
            <button
              v-for="query in recentQueries"
              :key="query"
              type="button"
              class="search-recent"
              data-testid="search-recent"
              :title="query"
              @click="applyRecentQuery(query)"
            >{{ query }}</button>
          </div>
          <button
            type="button"
            class="search-recent-clear"
            data-testid="search-recent-clear"
            title="清空最近搜索"
            aria-label="清空最近搜索"
            @click="clearRecentQueries"
          >清空</button>
        </div>
        <div class="room-search-filters">
          <label class="search-filter">
            <span>发送者</span>
            <select
              v-model="searchSenderId"
              data-testid="search-sender"
              aria-label="按发送者筛选"
            >
              <option value="">全部</option>
              <option
                v-for="member in chat.currentMembers"
                :key="member.userId"
                :value="member.userId"
              >{{ member.displayName }}</option>
            </select>
          </label>
          <label class="search-filter">
            <span>开始</span>
            <input
              v-model="searchFrom"
              type="date"
              data-testid="search-from"
              :max="searchTo || undefined"
              aria-label="开始日期"
            />
          </label>
          <label class="search-filter">
            <span>结束</span>
            <input
              v-model="searchTo"
              type="date"
              data-testid="search-to"
              :min="searchFrom || undefined"
              aria-label="结束日期"
            />
          </label>
        </div>
        <div
          v-if="searchFilterError"
          class="search-empty search-filter-error"
          role="alert"
        >
          {{ searchFilterError }}
        </div>
        <div
          v-if="searchError"
          class="search-empty search-filter-error search-failure"
          role="alert"
          data-testid="search-error"
        >
          <span>{{ searchError }}</span>
          <button
            class="btn ghost small"
            type="button"
            data-testid="search-retry"
            @click="retrySearch"
          >
            重试
          </button>
        </div>
        <div class="room-search-results">
          <button
            v-for="message in searchResults"
            :key="message.seq"
            class="search-result"
            @click="jumpToResult(message)"
          >
            <span class="search-meta">
              {{ message.senderName }} · {{ formatTime(message.createdAt) }}
            </span>
            <span class="search-text">
              <template
                v-for="(segment, index) in searchSegments(message.content)"
                :key="index"
              >
                <span v-if="segment.hit" class="search-hit">{{ segment.text }}</span>
                <template v-else>{{ segment.text }}</template>
              </template>
            </span>
          </button>
          <div v-if="searching" class="search-empty">搜索中…</div>
          <div
            v-else-if="
              searchQuery.trim() &&
              !searchFilterError &&
              !searchError &&
              !searchResults.length
            "
            class="search-empty"
          >
            没有匹配消息
          </div>
          <button
            v-if="searchHasMore"
            class="btn ghost small search-load-more"
            type="button"
            data-testid="search-load-more"
            :disabled="searchLoadingMore"
            @click="loadMoreSearchResults"
          >
            {{ searchLoadingMore ? '加载中…' : '加载更多' }}
          </button>
        </div>
      </div>

      <div v-if="!chat.connected" class="connection-banner">
        <span>连接已断开，正在重连…</span>
        <button class="btn ghost small" @click="chat.reconnect">立即重连</button>
      </div>

      <div
        v-if="roomOpenError"
        class="room-error-pane"
        role="alert"
        data-testid="room-open-error"
      >
        <div class="room-error-card">
          <p class="room-error-title">无法打开房间</p>
          <p class="room-error-text">{{ roomOpenError }}</p>
          <div class="room-error-actions">
            <button
              class="btn primary"
              type="button"
              data-testid="room-open-retry"
              :disabled="chat.loading"
              @click="retryOpenRoom"
            >
              重试
            </button>
            <button
              class="btn ghost"
              type="button"
              data-testid="room-open-back"
              @click="backToRoomList"
            >
              返回房间列表
            </button>
          </div>
        </div>
      </div>

      <div v-else class="messages-pane">
        <div v-if="selectMode" class="select-bar" data-testid="select-toolbar">
          <span class="select-count" data-testid="selected-count">已选 {{ selectedCount }} 条</span>
          <span class="spacer"></span>
          <button class="btn ghost small" type="button" @click="exitSelectMode">取消</button>
          <button
            class="btn ghost small"
            type="button"
            data-testid="bulk-forward"
            :disabled="!selectedCount"
            @click="handleBulkForward"
          >
            转发选中
          </button>
          <button
            v-if="canModerate"
            class="btn danger small"
            type="button"
            data-testid="bulk-delete"
            :disabled="!selectedCount || bulkDeleting"
            :aria-busy="bulkDeleting"
            @click="handleBulkDelete"
          >
            {{ bulkDeleting ? '删除中…' : '删除选中' }}
          </button>
        </div>
        <MessageList
          ref="messageListRef"
          :messages="chat.currentMessages"
          :has-more="chat.hasMore[roomId]"
          :loading-older="chat.loadingOlder[roomId]"
          :unread-marker="chat.unreadMarker[roomId]"
          :highlight-seq="highlightSeq ?? undefined"
          :can-moderate="canModerate"
          :selectable="selectMode"
          :selected-seqs="selectedSeqs"
          :load-older="loadOlder"
          @reply="setReply"
          @forward="startForward"
          @edit="startEdit"
          @delete="handleDelete"
          @react="handleReact"
          @pin="handlePin"
          @select="toggleSelect"
          @history="openHistory"
          @report="startReport"
          @vote="handleVote"
          @close="handlePollClose"
        />
        <div class="typing-line">
          <span v-if="typingText">{{ typingText }} 正在输入…</span>
        </div>
        <div v-if="hasStreamingBot" class="stop-bots-bar">
          <button
            class="btn ghost small stop-bots-btn"
            type="button"
            data-testid="stop-bots"
            :disabled="stopBotsBusy || !chat.connected"
            :aria-busy="stopBotsBusy"
            @click="handleStopBots"
          >
            <span class="stop-glyph" aria-hidden="true"></span>
            {{ stopBotsBusy ? '正在停止…' : '停止生成' }}
          </button>
        </div>
        <Composer
          :disabled="chat.loading || !chat.connected || chat.currentRoom?.id !== roomId"
          :room-id="roomId"
          :members="chat.currentMembers"
          :reply-to="replyTarget"
          :editing="editingMessage"
          @send="handleSend"
          @schedule="openSchedule"
          @typing="chat.sendTyping"
          @cancel-reply="clearReply"
          @cancel-edit="cancelEdit"
          @edit-last="editLast"
        />
      </div>
    </main>

    <aside v-if="!roomOpenError" class="members-panel">
      <MemberList
        :members="chat.currentMembers"
        :room-id="roomId"
        @kick="handleKick"
        @set-role="handleSetRole"
        @set-roles="handleSetRoles"
        @remove-members="handleRemoveMembers"
        @profile="handleProfile"
      />
    </aside>

    <el-drawer
      v-model="sidebarOpen"
      direction="ltr"
      size="300px"
      :with-header="false"
    >
      <RoomSidebar :active-room-id="roomId" @navigate="sidebarOpen = false" />
    </el-drawer>

    <el-drawer v-model="membersOpen" direction="rtl" size="300px" title="成员">
      <MemberList
        :members="chat.currentMembers"
        :room-id="roomId"
        @kick="handleKick"
        @set-role="handleSetRole"
        @set-roles="handleSetRoles"
        @remove-members="handleRemoveMembers"
        @profile="handleProfile"
      />
    </el-drawer>

    <el-drawer
      v-model="pinsOpen"
      direction="rtl"
      size="320px"
      title="置顶消息"
      @closed="pinQuery = ''"
    >
      <div class="pins-panel">
        <div v-if="pinnedLoading" class="pins-empty">加载中…</div>
        <div v-else-if="!pinnedMessages.length" class="pins-empty">
          还没有置顶消息
        </div>
        <template v-else>
          <div class="room-search-bar">
            <Icon name="search" :size="16" />
            <input
              v-model="pinQuery"
              aria-label="搜索置顶消息"
              placeholder="搜索内容或发送者"
              maxlength="100"
            />
            <button
              v-if="pinSearching"
              class="icon-btn small-icon"
              type="button"
              title="清空搜索"
              aria-label="清空搜索"
              @click="pinQuery = ''"
            >
              <Icon name="close" :size="14" />
            </button>
          </div>
          <div
            v-if="pinSearching"
            class="pin-card-meta"
            data-testid="pins-match-count"
            style="padding: 0 4px"
          >
            匹配 {{ pinFiltered.length }} / {{ pinnedMessages.length }}
          </div>
          <div
            v-if="!pinFiltered.length"
            class="pins-empty"
            data-testid="pins-no-match"
          >
            没有匹配的置顶消息
          </div>
          <div v-for="message in pinFiltered" :key="message.seq" class="pin-card">
            <button class="pin-jump" type="button" @click="jumpToPinned(message)">
              <span class="pin-card-meta">
                {{ message.senderName }} · {{ formatTime(message.createdAt) }}
              </span>
              <span class="pin-card-text">
                {{ message.deleted ? '消息已撤回' : plainPreview(message.content) }}
              </span>
            </button>
            <button
              v-if="canModerate && !message.deleted"
              class="pin-unpin"
              type="button"
              title="取消置顶"
              @click="handlePin(message, false)"
            >
              取消置顶
            </button>
          </div>
        </template>
      </div>
    </el-drawer>

    <Teleport to="body">
      <div
        v-if="moreOpen"
        class="more-overlay"
        data-testid="more-overlay"
        @click.self="moreOpen = false"
      >
        <div
          class="more-sheet"
          role="dialog"
          aria-modal="true"
          aria-label="更多操作"
          data-testid="more-sheet"
        >
          <div class="more-sheet-head">
            <span class="more-sheet-title">更多</span>
            <button
              class="icon-btn small-icon"
              type="button"
              title="关闭"
              aria-label="关闭更多操作"
              @click="moreOpen = false"
            >
              <Icon name="close" :size="14" />
            </button>
          </div>
          <div class="more-grid">
            <button
              v-if="!selectMode"
              class="more-item"
              type="button"
              data-testid="more-select"
              @click="moreOpen = false; enterSelectMode()"
            >
              <Icon name="check" :size="18" />
              <span>选择消息</span>
            </button>
            <button
              class="more-item"
              type="button"
              data-testid="more-media"
              @click="moreOpen = false; mediaOpen = true"
            >
              <Icon name="copy" :size="18" />
              <span>媒体库</span>
            </button>
            <button
              class="more-item"
              type="button"
              data-testid="more-pins"
              @click="moreOpen = false; togglePins()"
            >
              <Icon name="pin" :size="18" />
              <span>置顶消息</span>
            </button>
            <button
              class="more-item"
              type="button"
              data-testid="more-poll"
              @click="moreOpen = false; pollVisible = true"
            >
              <Icon name="plus" :size="18" />
              <span>发起投票</span>
            </button>
            <button
              v-if="canModerate"
              class="more-item"
              type="button"
              data-testid="more-bot"
              @click="moreOpen = false; botVisible = true"
            >
              <Icon name="bot" :size="18" />
              <span>机器人</span>
            </button>
            <button
              class="more-item"
              type="button"
              data-testid="more-settings"
              @click="moreOpen = false; settingsVisible = true"
            >
              <Icon name="settings" :size="18" />
              <span>房间设置</span>
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <BotDialog v-model="botVisible" :room-id="roomId" />
    <RoomSettingsDialog v-model="settingsVisible" :room-id="roomId" />
    <MemberProfileDialog v-model="profileVisible" :member="profileMember" />
    <ForwardDialog
      v-if="forwardSourceSeqs.length"
      v-model="forwardVisible"
      :source-room-id="roomId"
      :source-seqs="forwardSourceSeqs"
      :source-preview="forwardPreview"
      @forwarded="handleForwarded"
    />
    <ReportDialog
      v-if="reportTarget"
      v-model="reportVisible"
      :message="reportTarget"
    />
    <ScheduleDialog
      v-if="scheduleVisible"
      v-model="scheduleVisible"
      :room-id="roomId"
      :initial-content="scheduleContent"
      :done="scheduleDone ?? undefined"
    />
    <PollDialog v-model="pollVisible" :room-id="roomId" />
    <MediaGalleryDialog
      v-model="mediaOpen"
      :room-id="roomId"
      :can-moderate="canModerate"
      @deleted="handleGalleryDeleted"
    />
    <EditHistoryDialog
      v-if="historyTarget"
      v-model="historyVisible"
      :sender-name="historyTarget.senderName"
      :current="historyCurrent"
      :edits="historyEdits"
      :loading="historyLoading"
      :error="historyError"
      @retry="loadHistory"
    />
  </div>
</template>

<style scoped>
/* Pacing hint next to the room title; the label collapses to the bare
   interval on narrow screens so the topbar actions keep their room. */
.slow-mode-badge {
  display: inline-flex;
  flex: none;
  align-items: center;
  padding: 2px 8px;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  background: var(--paper-2);
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  font-weight: 700;
  letter-spacing: 0.04em;
  white-space: nowrap;
}

@media (max-width: 640px) {
  .slow-mode-prefix {
    display: none;
  }
}

.room-announcement {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--line);
  background: var(--paper-2);
  color: var(--text);
  font-size: 13px;
}

.announcement-label {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 4px;
  padding-top: 2px;
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  font-weight: 700;
  letter-spacing: 0.08em;
}

.announcement-text {
  flex: 1;
  min-width: 0;
  max-height: 96px;
  overflow-y: auto;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.announcement-close {
  flex: none;
}

/* Sender/date filters under the keyword bar; they wrap instead of squeezing
   the keyword input on narrow screens. */
.room-search-filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 14px;
  margin-top: 8px;
}

.search-filter {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--muted);
  font-size: var(--fs-sub);
}

.search-filter > span {
  flex: none;
}

.search-filter select,
.search-filter input {
  padding: 4px 8px;
  border: 1px solid var(--line-strong);
  border-radius: var(--r-sm);
  background: var(--paper);
  color: var(--text);
  font-family: inherit;
  font-size: var(--fs-sub);
  outline: none;
}

.search-filter select:focus,
.search-filter input:focus {
  border-color: var(--ink);
  background: var(--paper-2);
}

.search-filter-error {
  color: var(--danger);
}

/* A failed search offers a retry beside the reason; it never doubles as the
   "no matches" empty state. */
.search-failure {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

/* A room that failed to open replaces the whole message shell (list + composer
   + member list) with one recoverable state: reason, retry, way back. */
.room-error-pane {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.room-error-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 360px;
  width: 100%;
  padding: 24px 20px;
  text-align: center;
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  background: var(--paper);
}

.room-error-title {
  margin: 0;
  color: var(--danger);
  font-weight: 700;
}

.room-error-text {
  margin: 0;
  color: var(--muted);
  font-size: var(--fs-sub);
  word-break: break-word;
}

.room-error-actions {
  display: flex;
  justify-content: center;
  gap: 10px;
  margin-top: 6px;
}

/* Desktop keeps the full action row; the compact topbar swaps the secondary
   actions for the sheet below. */
.topbar-more {
  display: none;
}

.more-overlay {
  position: fixed;
  inset: 0;
  z-index: 3000;
  display: flex;
  align-items: flex-end;
  background: rgba(21, 23, 15, 0.45);
}

.more-sheet {
  width: 100%;
  max-height: 70vh;
  overflow-y: auto;
  padding: 12px 16px calc(20px + env(safe-area-inset-bottom));
  border-top: 1px solid var(--line-strong);
  border-radius: 16px 16px 0 0;
  background: var(--paper-2);
  box-shadow: 0 -12px 32px rgba(21, 23, 15, 0.18);
}

.more-sheet-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.more-sheet-title {
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  font-weight: 700;
  letter-spacing: 0.08em;
}

.more-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.more-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 14px 8px;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: var(--paper);
  color: var(--text);
  font-family: inherit;
  font-size: 13px;
  cursor: pointer;
}

.more-item:hover {
  border-color: var(--ink);
}

.more-item:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: 1px;
}

/* 390px bar: title + search/members/更多 only. Everything else moves into the
   bottom sheet, so the bar never scrolls sideways and the room name keeps a
   readable width. */
@media (max-width: 640px) {
  .chat-topbar {
    gap: 4px;
    padding: 0 6px;
    overflow: hidden;
  }

  .chat-topbar .spacer {
    display: none;
  }

  .chat-title {
    flex: 1 1 auto;
    overflow: hidden;
  }

  .topbar-secondary {
    display: none;
  }

  .topbar-more {
    display: inline-flex;
  }
}

/* The page action closes the result list; stretching it keeps the whole row
   tappable inside the scrolling panel on touch screens. */
.search-load-more {
  flex: none;
  align-self: stretch;
  margin-top: 4px;
}

/* Matched fragment in a search result. `--lime` (#d8f24a) is the same token in
   both themes, and 38% alpha over paper / ink keeps the inherited text colour
   readable; inline spans leave the ellipsis and line-height of `.search-text`
   untouched. */
.search-hit {
  border-radius: 2px;
  background: rgba(216, 242, 74, 0.38);
  color: inherit;
  font-weight: 600;
}

/* Recent queries are the panel's empty state: a repeat search costs one click
   instead of a retype. Chips wrap and truncate so a long query cannot widen
   the bar, and the clear action sits at the end of the row. */
.search-recent-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  margin-top: 8px;
}

.search-recent-label {
  flex: none;
  color: var(--faint);
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  font-weight: 700;
  letter-spacing: 0.08em;
}

.search-recent-list {
  display: flex;
  flex: 1;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}

.search-recent {
  max-width: 180px;
  padding: 3px 8px;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--paper-2);
  color: var(--muted);
  font-family: inherit;
  font-size: var(--fs-sub);
  line-height: 1.4;
  white-space: nowrap;
  text-overflow: ellipsis;
  cursor: pointer;
  transition: border-color 0.12s ease-out, color 0.12s ease-out;
}

.search-recent:hover {
  border-color: var(--line-strong);
  color: var(--text);
}

.search-recent:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: 1px;
}

.search-recent-clear {
  flex: none;
  padding: 3px 6px;
  border: none;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--faint);
  font-family: inherit;
  font-size: var(--fs-sub);
  cursor: pointer;
}

.search-recent-clear:hover {
  background: var(--paper-3);
  color: var(--danger);
}

.search-recent-clear:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: 1px;
}

/* Sits directly above the transcript: a thin strip that names the mode and
   keeps the destructive action on the far right, away from the reading edge. */
.select-bar {
  display: flex;
  flex: none;
  align-items: center;
  gap: 10px;
  padding: 8px 20px;
  border-bottom: 1px solid var(--line);
  background: var(--paper-2);
}

.select-count {
  color: var(--rust-ink);
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  font-weight: 700;
  letter-spacing: 0.06em;
  white-space: nowrap;
}

.select-toggle {
  flex: none;
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  letter-spacing: 0.06em;
}

/* The topbar is icon-first; on a phone the label would crowd the room name,
   so the check glyph carries the action (the tooltip and aria-label remain). */
@media (max-width: 640px) {
  .select-toggle {
    padding: 0 8px;
  }

  .select-toggle-text {
    display: none;
  }
}

/* Sits directly above the composer so the action is next to where the bot's
   stream is being read. */
.stop-bots-bar {
  display: flex;
  flex: none;
  justify-content: flex-end;
  padding: 0 20px 6px;
}

.stop-bots-btn {
  gap: 8px;
  border-radius: 999px;
  font-family: var(--font-mono);
  letter-spacing: 0.04em;
}

.stop-glyph {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  background: currentColor;
}

@media (max-width: 860px) {
  .select-bar {
    gap: 6px;
    padding: 8px 12px;
  }

  .stop-bots-bar {
    padding: 0 12px 4px;
  }
}
</style>
