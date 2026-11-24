<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import http, { errorMessage } from '../api/http';
import { useChatStore, type NotificationFilter } from '../stores/chat';
import type { NotificationItem } from '../types';
import { formatRelative } from '../utils/format';
import Icon from './Icon.vue';

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  navigate: [];
}>();

const router = useRouter();
const chat = useChatStore();

const panel = ref<HTMLElement | null>(null);
const loading = ref(false);
const marking = ref(false);
// One list mutation at a time: deleting a row while a clear is in flight would
// make both toasts and both local removals race each other.
const busy = ref(false);
// The CSV download is its own action: it never touches the list, so it must
// not block (or be blocked by) marking and deleting.
const exporting = ref(false);

// Search is panel-local: it asks the same endpoint for `q` rows and keeps its
// own page chain, so the chip's cached list stays intact behind it. Clearing
// the box restores that list instead of refetching it row by row.
const SEARCH_LIMIT = 20;
const searchInput = ref('');
const searchQuery = ref('');
const searchItems = ref<NotificationItem[]>([]);
const searchTotal = ref(0);
const searchLoading = ref(false);
const searchLoadingMore = ref(false);
let searchRequestId = 0;
let searchOffset = 0;
let searchTimer: ReturnType<typeof setTimeout> | null = null;

const searchActive = computed(() => searchQuery.value !== '');
// One source of truth for everything the list renders: rows, paging and the
// empty state switch together with the query, never one before the other.
const items = computed(() => (searchActive.value ? searchItems.value : chat.notifications));
const listLoading = computed(() => (searchActive.value ? searchLoading.value : loading.value));
const loadingMore = computed(() =>
  searchActive.value ? searchLoadingMore.value : chat.notificationsLoadingMore,
);
const listTotal = computed(() =>
  searchActive.value ? searchTotal.value : chat.notificationsTotal,
);

// Only rows on screen can be judged; the server clears read rows account-wide,
// so this count decides whether the action is offered at all.
const readCount = computed(() => items.value.filter((item) => item.readAt).length);

// Ids ticked with the row checkboxes. The set can outlive a row (a socket
// window trim, a single delete), so every action narrows it to the rows on
// screen: a hidden id must never be deleted by a visible selection.
const selected = ref<Set<number>>(new Set());
const selectedIds = computed(() =>
  items.value.filter((item) => selected.value.has(item.id)).map((item) => item.id),
);
const selectedCount = computed(() => selectedIds.value.length);
// "标记已读" acts on ticked rows only, and only unread ones make it meaningful:
// a selection of read rows would be a no-op request, so it disables instead.
const selectedUnreadCount = computed(
  () => items.value.filter((item) => selected.value.has(item.id) && !item.readAt).length,
);
const allSelected = computed(
  () => items.value.length > 0 && selectedCount.value === items.value.length,
);
const someSelected = computed(() => selectedCount.value > 0 && !allSelected.value);

function toggleSelect(item: NotificationItem, event: Event) {
  const checked = (event.target as HTMLInputElement).checked;
  if (checked) {
    selected.value.add(item.id);
  } else {
    selected.value.delete(item.id);
  }
}

function toggleSelectAll(event: Event) {
  selected.value = (event.target as HTMLInputElement).checked
    ? new Set(items.value.map((item) => item.id))
    : new Set();
}

function clearSelection() {
  if (selected.value.size > 0) {
    selected.value = new Set();
  }
}

const unreadText = computed(() =>
  chat.notificationsUnread > 0 ? `${chat.notificationsUnread} 未读` : '已全部读完',
);

// Chips narrow the list server-side; the badge and 全部已读 stay account-wide.
const filterOptions: { value: NotificationFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'mention', label: '提及' },
  { value: 'join', label: '加入' },
  { value: 'invite', label: '邀请' },
];

// Each chip has its own empty copy: "暂无通知" under 提及 would read as if
// mentions had been lost rather than that none exist. A search is its own
// state, so it must never use a chip's copy: the rows exist, the query missed.
const emptyText = computed(() => {
  if (searchActive.value) {
    return { title: '没有匹配的通知', sub: '换个关键词试试' };
  }
  switch (chat.notificationsFilter) {
    case 'mention':
      return { title: '暂无提及', sub: '有人 @你 时，会出现在这里' };
    case 'join':
      return { title: '暂无加入通知', sub: '加入申请与审批结果会出现在这里' };
    case 'invite':
      return { title: '暂无邀请', sub: '有人邀请你加入房间时，会出现在这里' };
    default:
      return { title: '暂无通知', sub: '有人 @你 或申请加入时，会出现在这里' };
  }
});

// Per-room unread chips: the badge carries the account-wide total, these name
// the busiest rooms so a jump needs no scrolling through the list. Only unread
// rows are aggregated, so the strip disappears once everything is read.
interface RoomSummary {
  roomId: number;
  roomName: string;
  count: number;
}

// Unread totals per filter chip, mirroring the server's `types` buckets.
interface NotificationTypeCounts {
  mention: number;
  join: number;
  invite: number;
}

const summary = ref<RoomSummary[]>([]);
// Chip numbers ride along with the room strip's payload, so the two can never
// disagree; both are cleared together when the panel opens or closes.
const summaryUnread = ref(0);
const summaryTypes = ref<NotificationTypeCounts>({ mention: 0, join: 0, invite: 0 });
// Opening the panel and every unread change can race; only the newest summary
// may replace the chips, the same token discipline as the list itself.
let summaryRequestId = 0;

async function loadSummary() {
  const requestId = ++summaryRequestId;
  try {
    const { data } = await http.get<{
      unread: number;
      rooms: RoomSummary[];
      types: NotificationTypeCounts;
    }>('/notifications/summary');
    if (requestId !== summaryRequestId) {
      return;
    }
    summary.value = data.rooms;
    summaryUnread.value = data.unread;
    summaryTypes.value = data.types;
  } catch {
    // Deliberately silent: the list and the badge stay authoritative, and the
    // next open (or unread change) retries. Never blocks the list load.
  }
}

/** Unread rows behind one chip; `all` mirrors the account-wide total. */
function filterCount(filter: NotificationFilter): number {
  return filter === 'all' ? summaryUnread.value : summaryTypes.value[filter];
}

// Counts are rendered only above zero: an empty tab stays a plain label.
const filterChips = computed(() =>
  filterOptions.map((option) => ({ ...option, count: filterCount(option.value) })),
);

function openSummaryRoom(room: RoomSummary) {
  close();
  // Same drawer hand-off as a row click: the sidebar closes on mobile.
  emit('navigate');
  void router.push(`/rooms/${room.roomId}`);
}

// The badge moves when a row is read, deleted or a mention arrives. While the
// panel is open the chips must follow; while closed nothing is rendered and
// opening refetches, so no background request is needed.
watch(
  () => chat.notificationsUnread,
  () => {
    if (props.modelValue) {
      void loadSummary();
    }
  },
);

// Chip switches outrun the network; only the newest request may clear the
// spinner (the store drops the stale response itself).
let filterRequestId = 0;

async function selectFilter(next: NotificationFilter) {
  if (next === chat.notificationsFilter) {
    return;
  }
  // A different tab shows a different set; ticking rows from the old one
  // would leave the toolbar counting rows that are no longer on screen.
  clearSelection();
  const requestId = ++filterRequestId;
  loading.value = true;
  if (searchActive.value) {
    // The rows on screen belong to the old chip: drop them with the switch so
    // the new chip never displays them, even for one frame.
    searchLoading.value = true;
    searchItems.value = [];
    searchTotal.value = 0;
    searchOffset = 0;
  }
  try {
    // A failed switch leaves the previous filter and list in place.
    await chat.loadNotifications(next);
  } finally {
    if (requestId === filterRequestId) {
      loading.value = false;
    }
  }
  // The query belongs to the panel, not to one chip: a switch re-runs it
  // against the chip that actually took effect (a failed switch reverts).
  if (searchActive.value && requestId === filterRequestId && props.modelValue) {
    await loadSearchPage(true);
  }
}

/**
 * Drops ids from the search page chain. `total` and the raw server offset move
 * with it, so a removal never skips the row that slid into the freed slot.
 */
function dropSearchRows(ids: Set<number>) {
  if (!searchActive.value || ids.size === 0) {
    return;
  }
  const before = searchItems.value.length;
  searchItems.value = searchItems.value.filter((item) => !ids.has(item.id));
  const removed = before - searchItems.value.length;
  searchTotal.value = Math.max(0, searchTotal.value - removed);
  searchOffset = Math.max(0, searchOffset - removed);
}

/**
 * Fetches one search page. `reset` starts a new query: the old rows and total
 * disappear immediately so a stale page can never answer the new one. The
 * filter chip is always part of the request, matching the server's type+q
 * combination. Failures are silent like the store's list: the panel is
 * auxiliary and the next keystroke retries.
 */
async function loadSearchPage(reset: boolean) {
  if (reset) {
    searchLoading.value = true;
    searchLoadingMore.value = false;
    searchItems.value = [];
    searchTotal.value = 0;
    searchOffset = 0;
  } else {
    // A page append means rows are already on screen; the full-list spinner
    // belongs to a reset, not here.
    searchLoading.value = false;
    searchLoadingMore.value = true;
  }
  const requestId = ++searchRequestId;
  const from = reset ? 0 : searchOffset;
  try {
    const { data } = await http.get<{
      items: NotificationItem[];
      total: number;
      unread: number;
    }>('/notifications', {
      params: {
        limit: SEARCH_LIMIT,
        offset: from,
        filter: chat.notificationsFilter,
        q: searchQuery.value,
      },
    });
    if (requestId !== searchRequestId) {
      return;
    }
    searchOffset = from + data.items.length;
    searchTotal.value = data.total;
    if (reset) {
      searchItems.value = data.items;
    } else {
      // Rows inserted at the head shift the window; ids are the identity, so a
      // duplicate never renders twice and never breaks the row key.
      const seen = new Set(searchItems.value.map((item) => item.id));
      searchItems.value = [
        ...searchItems.value,
        ...data.items.filter((item) => !seen.has(item.id)),
      ];
    }
  } catch {
    if (requestId !== searchRequestId) {
      return;
    }
    if (reset) {
      searchItems.value = [];
      searchTotal.value = 0;
      searchOffset = 0;
    }
  } finally {
    if (requestId === searchRequestId) {
      searchLoading.value = false;
      searchLoadingMore.value = false;
    }
  }
}

/** Clears the query and its page chain without issuing a request. */
function resetSearch() {
  if (searchTimer !== null) {
    clearTimeout(searchTimer);
    searchTimer = null;
  }
  searchRequestId += 1;
  searchInput.value = '';
  searchQuery.value = '';
  searchItems.value = [];
  searchTotal.value = 0;
  searchLoading.value = false;
  searchLoadingMore.value = false;
  searchOffset = 0;
}

// 300 ms after the last keystroke, swap the list for this query's first page.
// A blank box restores the chip's normal list; whitespace around a real query
// is not part of what the user is looking for.
watch(searchInput, () => {
  if (searchTimer !== null) {
    clearTimeout(searchTimer);
  }
  searchTimer = setTimeout(() => {
    searchTimer = null;
    if (!props.modelValue) {
      return;
    }
    const next = searchInput.value.trim();
    if (next === searchQuery.value) {
      return;
    }
    clearSelection();
    if (next === '') {
      searchQuery.value = '';
      searchRequestId += 1;
      searchItems.value = [];
      searchTotal.value = 0;
      searchLoading.value = false;
      searchLoadingMore.value = false;
      searchOffset = 0;
      // Clearing restores the chip's list, refreshed: rows may have arrived
      // while the query was hiding them.
      void chat.loadNotifications(chat.notificationsFilter);
      return;
    }
    searchQuery.value = next;
    void loadSearchPage(true);
  }, 300);
});

let listening = false;

function close() {
  if (props.modelValue) {
    emit('update:modelValue', false);
  }
}

function onPointerDown(event: PointerEvent) {
  const target = event.target;
  if (!(target instanceof Node)) {
    return;
  }
  if (panel.value?.contains(target)) {
    return;
  }
  // Confirm dialogs are teleported outside the panel; clicking their buttons
  // must not dismiss the list the dialog is acting on.
  if (target instanceof Element && target.closest('.el-overlay, .el-message-box')) {
    return;
  }
  // The bell toggles the panel itself; closing on its pointerdown would make
  // the following click reopen it, so the trigger is never "outside".
  if (target instanceof Element && target.closest('[data-testid="notifications-bell"]')) {
    return;
  }
  close();
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.stopPropagation();
    close();
  }
}

function attach() {
  if (listening) {
    return;
  }
  listening = true;
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('keydown', onKeydown);
}

function detach() {
  if (!listening) {
    return;
  }
  listening = false;
  document.removeEventListener('pointerdown', onPointerDown, true);
  document.removeEventListener('keydown', onKeydown);
}

watch(
  () => props.modelValue,
  async (open) => {
    // Closing drops the ticked rows, and opening refetches the list, so a
    // selection never survives either side of a panel session.
    clearSelection();
    if (!open) {
      detach();
      // The query is a panel-session tool; a reopen starts from the chip's
      // full list, and the next open refetches anyway.
      resetSearch();
      return;
    }
    attach();
    // Chips belong to this panel session: drop the previous strip and refetch
    // alongside the list, so neither request waits for the other.
    summary.value = [];
    summaryUnread.value = 0;
    summaryTypes.value = { mention: 0, join: 0, invite: 0 };
    void loadSummary();
    const requestId = ++filterRequestId;
    loading.value = true;
    try {
      // Opening the bell refreshes the tail: mentions that arrived while the
      // panel was closed are already in the socket list, this fills the rest.
      // The current chip decides which slice is refetched.
      await chat.loadNotifications(chat.notificationsFilter);
    } finally {
      if (requestId === filterRequestId) {
        loading.value = false;
      }
    }
    await nextTick();
    panel.value?.focus();
  },
);

onBeforeUnmount(detach);

function isJoinOutcome(item: NotificationItem): boolean {
  return item.type === 'join_approved' || item.type === 'join_rejected';
}

// What the sender did, in one line. Room invites keep their full sentence in
// `content` (rendered as the preview), so the line only names the action.
function actionLabel(item: NotificationItem): string {
  switch (item.type) {
    case 'join_request':
      return '请求加入';
    case 'room_invite':
      return '邀请你加入房间';
    default:
      return '提到了你';
  }
}

// Join outcomes carry their whole sentence in `content`; the other types get a
// sender line and (for mentions) a message preview underneath.
function showsPreview(item: NotificationItem): boolean {
  return item.type !== 'join_request' && !isJoinOutcome(item);
}

function openItem(item: NotificationItem) {
  close();
  // The sidebar hosts this panel inside the mobile drawer; let it close the
  // drawer the same way a room click does.
  emit('navigate');
  if (!item.readAt) {
    // Navigation is the intent; a read-ack failure must not block the jump.
    // The store updates its own rows, while a search row is a separate object,
    // so the ack also marks the row this panel is actually showing.
    void chat
      .markNotificationsRead([item.id])
      .then(() => {
        item.readAt = new Date().toISOString();
      })
      .catch(() => undefined);
  }
  // Join notifications have no message to anchor to; open the room itself.
  void router.push(
    item.messageSeq != null
      ? `/rooms/${item.roomId}?seq=${item.messageSeq}`
      : `/rooms/${item.roomId}`,
  );
}

async function markAll() {
  if (chat.notificationsUnread === 0 || marking.value) {
    return;
  }
  marking.value = true;
  try {
    await chat.markNotificationsRead();
    // The account-wide call also covered every search row on screen.
    const readAt = new Date().toISOString();
    for (const entry of searchItems.value) {
      if (!entry.readAt) {
        entry.readAt = readAt;
      }
    }
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    marking.value = false;
  }
}

async function removeItem(item: NotificationItem) {
  if (busy.value) {
    return;
  }
  busy.value = true;
  try {
    await chat.deleteNotification(item.id);
    selected.value.delete(item.id);
    dropSearchRows(new Set([item.id]));
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    busy.value = false;
  }
}

// Deletes every ticked row in one request; the toast reports what the server
// really removed, which can be smaller than the selection when rows vanished
// elsewhere (another tab, a cleared read history).
async function deleteSelected() {
  const ids = selectedIds.value;
  if (ids.length === 0 || busy.value) {
    return;
  }
  busy.value = true;
  try {
    const result = await chat.deleteNotifications(ids);
    dropSearchRows(new Set(ids));
    clearSelection();
    ElMessage.success(`已删除 ${result.deleted} 条通知`);
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    busy.value = false;
  }
}

// Marks every ticked row in one request. Read rows in the selection ride along
// harmlessly; the toast reports what the server really updated. A failure keeps
// the selection so a retry needs no re-ticking.
async function markSelectedRead() {
  const ids = selectedIds.value;
  if (ids.length === 0 || selectedUnreadCount.value === 0 || busy.value) {
    return;
  }
  busy.value = true;
  try {
    const result = await chat.markNotificationsRead(ids);
    // Search rows are panel-local objects; the store only updated its own.
    const idSet = new Set(ids);
    const readAt = new Date().toISOString();
    for (const entry of searchItems.value) {
      if (!entry.readAt && idSet.has(entry.id)) {
        entry.readAt = readAt;
      }
    }
    clearSelection();
    ElMessage.success(`已标记 ${result.updated} 条已读`);
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    busy.value = false;
  }
}

async function clearRead() {
  if (busy.value || readCount.value === 0) {
    return;
  }
  try {
    await ElMessageBox.confirm(
      `将删除 ${readCount.value} 条已读通知，未读通知会保留。`,
      '清空已读通知',
      { confirmButtonText: '清空', cancelButtonText: '取消', type: 'warning' },
    );
  } catch {
    return;
  }
  busy.value = true;
  try {
    const result = await chat.clearReadNotifications();
    // Read rows can be ticked too; they are gone now, so the toolbar must not
    // keep counting them.
    clearSelection();
    // The call removed read rows account-wide, which can include matches that
    // were never loaded; refetching is the only way to keep the total honest.
    if (searchActive.value) {
      void loadSearchPage(true);
    }
    ElMessage.success(`已清空 ${result.deleted} 条已读通知`);
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    busy.value = false;
  }
}

// The download mirrors what the panel is looking at: the active chip plus the
// text in the search box, so the file and the list cannot describe different
// sets. The server caps the file at 5000 rows and names it notifications.csv.
async function exportCsv() {
  if (exporting.value) {
    return;
  }
  exporting.value = true;
  try {
    const { data, headers } = await http.get<Blob>('/notifications/export', {
      params: {
        filter: chat.notificationsFilter,
        q: searchInput.value.trim() || undefined,
      },
      responseType: 'blob',
    });
    saveBlob(data, 'notifications.csv');
    if (headers['x-notifications-truncated'] === 'true') {
      ElMessage.warning(
        '导出达到 5000 行上限，仅包含最新通知；请缩小筛选或搜索范围后再导出',
      );
    } else {
      ElMessage.success('已导出通知');
    }
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    exporting.value = false;
  }
}

// Hands a response blob to the browser. The object URL is revoked once the
// click has been dispatched so a download never leaks it.
function saveBlob(data: Blob, filename: string): void {
  const objectUrl = URL.createObjectURL(data);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
}

// The list only holds the pages fetched so far, while `total` is the server's
// count for the active chip and query: they disagree exactly when there is
// more to fetch. An empty list is excluded because a chip switch empties it
// while the old total is still set — "加载更多" under a spinner would be a lie.
const hasMore = computed(() => items.value.length > 0 && items.value.length < listTotal.value);

async function loadMore() {
  if (searchActive.value) {
    if (searchLoadingMore.value) {
      return;
    }
    // Search pages carry the query and the chip; a failure keeps the rows
    // already loaded, so the button simply offers another try.
    await loadSearchPage(false);
    return;
  }
  if (chat.notificationsLoadingMore) {
    return;
  }
  // The store drops a failed page and keeps the rows already loaded, so there
  // is nothing to roll back: the button stays and simply offers another try.
  await chat.loadMoreNotifications();
}

// The row is a div so the delete button can live inside it; Enter/Space must
// still open the notification, but only when the row itself has focus.
function onRowKeydown(event: KeyboardEvent, item: NotificationItem) {
  if (event.target !== event.currentTarget) {
    return;
  }
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    openItem(item);
  }
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="modelValue"
      ref="panel"
      class="notif-panel"
      data-testid="notification-panel"
      role="dialog"
      aria-label="通知"
      tabindex="-1"
    >
      <header class="notif-head-bar">
        <span class="notif-title">
          <Icon name="bell" :size="15" />
          通知
        </span>
        <span class="notif-unread">{{ unreadText }}</span>
        <button
          type="button"
          class="notif-read-all"
          data-testid="notification-read-all"
          :disabled="chat.notificationsUnread === 0 || marking"
          @click="markAll"
        >
          全部已读
        </button>
        <button
          v-if="readCount > 0"
          type="button"
          class="notif-clear-read"
          data-testid="notification-clear-read"
          :disabled="busy"
          @click="clearRead"
        >
          清空已读
        </button>
      </header>

      <div class="notif-search-row">
        <input
          v-model="searchInput"
          class="notif-search-input"
          data-testid="notif-search"
          type="search"
          maxlength="100"
          placeholder="搜索通知"
          aria-label="搜索通知"
          autocomplete="off"
        />
        <button
          type="button"
          class="notif-export"
          data-testid="notifications-export"
          :disabled="exporting"
          title="导出当前筛选与搜索结果"
          @click="exportCsv"
        >
          {{ exporting ? '导出中…' : '导出 CSV' }}
        </button>
      </div>

      <div
        v-if="summary.length > 0"
        class="notif-summary"
        role="group"
        aria-label="按房间未读"
      >
        <button
          v-for="room in summary"
          :key="room.roomId"
          type="button"
          class="notif-summary-chip"
          data-testid="notif-summary"
          :data-room-id="room.roomId"
          :title="`#${room.roomName}：${room.count} 条未读`"
          @click="openSummaryRoom(room)"
        >
          <span class="notif-summary-room">#{{ room.roomName }}</span>
          <span class="notif-summary-count">{{ room.count }}</span>
        </button>
      </div>

      <div class="notif-filters" role="group" aria-label="筛选通知">
        <button
          v-for="option in filterChips"
          :key="option.value"
          type="button"
          class="notif-filter"
          :class="{ active: chat.notificationsFilter === option.value }"
          :data-testid="`notif-filter-${option.value}`"
          :aria-pressed="chat.notificationsFilter === option.value"
          @click="selectFilter(option.value)"
        >
          <span>{{ option.label }}</span>
          <span
            v-if="option.count > 0"
            class="notif-filter-count"
            data-testid="notif-filter-count"
            :aria-label="`${option.count} 条未读`"
          >
            {{ option.count }}
          </span>
        </button>
      </div>

      <div v-if="items.length > 0" class="notif-bulk" role="group" aria-label="批量操作">
        <label class="notif-check">
          <input
            type="checkbox"
            class="notif-checkbox"
            data-testid="notification-select-all"
            :checked="allSelected"
            :indeterminate="someSelected"
            @change="toggleSelectAll"
          />
          <span>全选</span>
        </label>
        <span class="notif-selected" data-testid="notification-selected-count">
          已选 {{ selectedCount }} 条
        </span>
        <button
          type="button"
          class="notif-bulk-read"
          data-testid="notification-bulk-read"
          :disabled="selectedUnreadCount === 0 || busy"
          @click.stop="markSelectedRead"
        >
          标记已读
        </button>
        <button
          type="button"
          class="notif-bulk-delete"
          data-testid="notification-bulk-delete"
          :disabled="selectedCount === 0 || busy"
          @click.stop="deleteSelected"
        >
          删除已选 {{ selectedCount }} 条
        </button>
      </div>

      <div class="notif-list">
        <div v-if="listLoading && items.length === 0" class="notif-empty">
          加载中…
        </div>
        <div
          v-else-if="items.length === 0"
          class="notif-empty"
          data-testid="notification-empty"
        >
          <Icon name="bell" :size="22" />
          <span>{{ emptyText.title }}</span>
          <span class="notif-empty-sub">{{ emptyText.sub }}</span>
        </div>
        <div
          v-for="item in items"
          :key="item.id"
          class="notif-item"
          :class="{ unread: !item.readAt }"
          data-testid="notification-item"
          role="button"
          tabindex="0"
          @click="openItem(item)"
          @keydown="onRowKeydown($event, item)"
        >
          <span class="notif-select-wrap" @click.stop @keydown.stop>
            <input
              type="checkbox"
              class="notif-checkbox"
              data-testid="notification-select"
              :checked="selected.has(item.id)"
              :aria-label="`选择通知：${item.roomName}`"
              @change="toggleSelect(item, $event)"
            />
          </span>
          <span class="notif-dot" :class="{ on: !item.readAt }" aria-hidden="true"></span>
          <span class="notif-main">
            <span class="notif-meta">
              <span class="notif-room">#{{ item.roomName }}</span>
              <span class="notif-time">{{ formatRelative(item.createdAt) }}</span>
            </span>
            <span class="notif-line">
              <template v-if="isJoinOutcome(item)">
                {{ item.content || '加入申请状态已更新' }}
              </template>
              <template v-else>
                <span class="notif-actor">{{ item.actorName || '有人' }}</span>
                {{ actionLabel(item) }}
              </template>
            </span>
            <span v-if="showsPreview(item)" class="notif-content">
              {{ item.content || '（空消息）' }}
            </span>
          </span>
          <button
            type="button"
            class="notif-delete"
            data-testid="notification-delete"
            aria-label="删除通知"
            title="删除通知"
            :disabled="busy"
            @click.stop="removeItem(item)"
            @keydown.stop
          >
            <Icon name="close" :size="12" />
          </button>
        </div>
        <button
          v-if="hasMore"
          type="button"
          class="notif-more"
          data-testid="notification-load-more"
          :disabled="loadingMore"
          @click="loadMore"
        >
          {{ loadingMore ? '加载中…' : '加载更多' }}
        </button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* Above Element Plus drawers (2000+) so the bell also works from the mobile
   sidebar drawer, below nothing else that matters. */
.notif-panel {
  position: fixed;
  z-index: 2400;
  top: 60px;
  left: 12px;
  display: flex;
  flex-direction: column;
  width: min(380px, calc(100vw - 24px));
  max-height: min(560px, calc(100vh - 80px));
  background: var(--paper-2);
  background: var(--glass-pop);
  -webkit-backdrop-filter: blur(20px) saturate(1.5);
  backdrop-filter: blur(20px) saturate(1.5);
  border: 1px solid var(--line-strong);
  border-radius: var(--r-lg);
  box-shadow: inset 0 1px 0 rgba(236, 233, 226, 0.12), var(--glass-shadow);
  outline: none;
  overflow: hidden;
}

.notif-head-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  padding: 10px 12px;
  border-bottom: 1px solid var(--line);
}

.notif-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-sub);
  font-weight: 700;
  color: var(--text);
}

.notif-unread {
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  color: var(--muted);
  white-space: nowrap;
}

.notif-read-all {
  margin-left: auto;
  padding: 4px 8px;
  border: none;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--ink);
  font: inherit;
  font-size: var(--fs-sub);
  font-weight: 600;
  cursor: pointer;
  transition: background 0.12s ease-out, opacity 0.12s ease-out;
}

.notif-read-all:hover:not(:disabled) {
  background: var(--paper-3);
}

.notif-read-all:disabled {
  opacity: 0.45;
  cursor: default;
}

/* Secondary to 全部已读: clearing history is destructive, so it stays quieter
   and only appears once there is something read to clear. */
.notif-clear-read {
  flex: none;
  padding: 4px 8px;
  border: none;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-size: var(--fs-sub);
  font-weight: 600;
  cursor: pointer;
  transition: background 0.12s ease-out, color 0.12s ease-out, opacity 0.12s ease-out;
}

.notif-clear-read:hover:not(:disabled) {
  background: var(--paper-3);
  color: var(--danger);
}

.notif-clear-read:disabled {
  opacity: 0.45;
  cursor: default;
}

/* Search sits directly under the title bar and narrows whichever chip is
   active; it never replaces or resets that chip. The export button shares the
   row so the file always names the query next to it. */
.notif-search-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  padding: 8px 12px;
  border-bottom: 1px solid var(--line);
}

.notif-search-input {
  flex: 1;
  min-width: 0;
  padding: 7px 10px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--paper, transparent);
  color: var(--text);
  font: inherit;
  font-size: var(--fs-sub);
  outline: none;
  transition: border-color 0.12s ease-out, background 0.12s ease-out;
}

.notif-search-input::placeholder {
  color: var(--faint);
}

.notif-search-input:focus {
  border-color: var(--ink);
  background: var(--paper-2);
}

/* Quieter than the primary actions: exporting is a read, not a mutation, and
   it stays available while rows are being deleted. */
.notif-export {
  flex: none;
  padding: 6px 8px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--ink);
  font: inherit;
  font-size: var(--fs-sub);
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  transition: background 0.12s ease-out, border-color 0.12s ease-out, opacity 0.12s ease-out;
}

.notif-export:hover:not(:disabled) {
  background: var(--paper-3);
  border-color: var(--line-strong);
}

.notif-export:disabled {
  opacity: 0.45;
  cursor: default;
}

/* Unread per-room chips: a ranked shortcut above the filters. Like the filter
   row it scrolls sideways instead of wrapping, so ten rooms cannot push the
   list out of the panel. */
.notif-summary {
  display: flex;
  gap: 6px;
  flex: none;
  padding: 8px 12px;
  border-bottom: 1px solid var(--line);
  overflow-x: auto;
  overscroll-behavior-x: contain;
  scrollbar-width: none;
}

.notif-summary::-webkit-scrollbar {
  display: none;
}

.notif-summary-chip {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 6px 0 10px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--paper-2);
  color: var(--text);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  transition: background 0.12s ease-out, border-color 0.12s ease-out;
}

.notif-summary-chip:hover {
  background: var(--paper-3);
  border-color: var(--line-strong);
}

.notif-summary-room {
  max-width: 130px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.notif-summary-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--lime);
  color: var(--ink);
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  font-weight: 700;
}

.notif-filters {
  display: flex;
  gap: 6px;
  flex: none;
  padding: 8px 12px;
  border-bottom: 1px solid var(--line);
  /* Four chips fit a 380px panel; a narrow phone drawer scrolls them instead
     of wrapping, so the list never gets pushed down. */
  overflow-x: auto;
  overscroll-behavior-x: contain;
  scrollbar-width: none;
}

.notif-filters::-webkit-scrollbar {
  display: none;
}

/* Batch toolbar: one quiet line above the list, only while rows exist. Both
   actions stay muted until the selection makes them meaningful: read needs an
   unread row, delete needs any row. */
.notif-bulk {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--line);
}

.notif-check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-sub);
  color: var(--muted);
  cursor: pointer;
  user-select: none;
}

.notif-checkbox {
  width: 14px;
  height: 14px;
  margin: 0;
  accent-color: var(--lime);
  cursor: pointer;
}

.notif-selected {
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  color: var(--muted);
  white-space: nowrap;
}

.notif-bulk-read {
  margin-left: auto;
  padding: 4px 8px;
  border: none;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--ink);
  font: inherit;
  font-size: var(--fs-sub);
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  transition: background 0.12s ease-out, opacity 0.12s ease-out;
}

.notif-bulk-read:hover:not(:disabled) {
  background: var(--paper-3);
}

.notif-bulk-read:disabled {
  opacity: 0.45;
  cursor: default;
}

.notif-bulk-delete {
  padding: 4px 8px;
  border: none;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-size: var(--fs-sub);
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  transition: background 0.12s ease-out, color 0.12s ease-out, opacity 0.12s ease-out;
}

.notif-bulk-delete:hover:not(:disabled) {
  background: var(--danger-soft);
  color: var(--danger);
}

.notif-bulk-delete:disabled {
  opacity: 0.45;
  cursor: default;
}

/* The checkbox lives inside the clickable row, so it aligns with the dot
   rather than the row's padding box. */
.notif-select-wrap {
  display: inline-flex;
  flex: none;
  align-items: center;
  margin-top: 3px;
}

.notif-filter {
  position: relative;
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 26px;
  padding: 0 10px;
  border: none;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  transition: background 0.12s ease-out, color 0.12s ease-out;
}

/* The unread number sits inside the chip as a small pill; it is only rendered
   when the server reports unread rows for that bucket. */
.notif-filter-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: rgba(236, 233, 226, 0.1);
  color: var(--text);
  font-size: 11px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 1;
}

.notif-filter.active .notif-filter-count {
  background: var(--lime);
}

.notif-filter:hover {
  background: var(--paper-3);
  color: var(--text);
}

.notif-filter.active {
  background: var(--accent-soft);
  color: var(--lime);
}

/* The underline keeps the selection legible where the lime tint is faint. */
.notif-filter.active::after {
  position: absolute;
  left: 10px;
  right: 10px;
  bottom: 2px;
  height: 2px;
  border-radius: 1px;
  background: var(--lime);
  content: '';
}

/* Touch: chips and rows grow to a finger-sized target; the desktop panel is
   untouched because the breakpoint matches the rest of the app's mobile cut. */
@media (max-width: 860px) {
  .notif-search-input {
    padding: 9px 10px;
  }

  .notif-filter {
    height: 36px;
    padding: 0 12px;
    font-size: 13px;
  }

  .notif-summary-chip {
    height: 36px;
    font-size: 13px;
  }

  .notif-item {
    padding: 11px 10px;
  }

  .notif-checkbox {
    width: 16px;
    height: 16px;
  }

  .notif-bulk-read,
  .notif-bulk-delete {
    padding: 8px 10px;
  }

  .notif-delete {
    width: 30px;
    height: 30px;
    margin-top: 0;
  }
}

.notif-list {
  /* The panel caps its own height; the list takes what the header and the
     chip row leave, so the extra row cannot clip the last notification. */
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 4px;
}

.notif-item {
  display: flex;
  gap: 8px;
  width: 100%;
  padding: 9px 8px;
  border: none;
  border-radius: var(--r-md);
  background: transparent;
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background 0.12s ease-out;
}

.notif-item:hover {
  background: var(--paper-3);
}

.notif-item.unread {
  background: rgba(217, 178, 106, 0.12);
}

.notif-item.unread:hover {
  background: rgba(217, 178, 106, 0.2);
}

/* The row is a div (a button cannot nest the delete button), so it carries its
   own keyboard affordance. */
.notif-item:focus-visible {
  outline: 2px solid var(--lime);
  outline-offset: -2px;
}

.notif-delete {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  margin-top: 1px;
  padding: 0;
  border: none;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  transition: background 0.12s ease-out, color 0.12s ease-out, opacity 0.12s ease-out;
}

.notif-delete:hover:not(:disabled) {
  background: var(--danger-soft);
  color: var(--danger);
}

.notif-delete:disabled {
  opacity: 0.45;
  cursor: default;
}

.notif-dot {
  flex: none;
  width: 7px;
  height: 7px;
  margin-top: 6px;
  border-radius: 50%;
  background: transparent;
}

.notif-dot.on {
  background: var(--lime);
  box-shadow: inset 0 0 0 1px var(--ink);
}

.notif-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}

.notif-meta {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.notif-room {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--muted);
}

.notif-time {
  flex: none;
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  color: var(--muted);
}

.notif-line {
  font-size: var(--fs-sub);
  color: var(--text);
}

.notif-actor {
  font-weight: 700;
}

.notif-content {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  font-size: var(--fs-sub);
  line-height: 1.45;
  color: var(--muted);
  overflow-wrap: anywhere;
}

.notif-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 28px 16px;
  color: var(--muted);
  font-size: var(--fs-sub);
  text-align: center;
}

.notif-empty-sub {
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  color: var(--muted);
}

/* Quiet, full-width footer: paging is optional, so it never competes with the
   rows above it for attention. */
.notif-more {
  display: block;
  width: calc(100% - 8px);
  margin: 4px;
  padding: 8px 10px;
  border: 1px dashed var(--line-strong);
  border-radius: var(--r-md);
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-size: var(--fs-sub);
  font-weight: 600;
  cursor: pointer;
  transition: background 0.12s ease-out, color 0.12s ease-out, opacity 0.12s ease-out;
}

.notif-more:hover:not(:disabled) {
  background: var(--paper-3);
  color: var(--text);
}

.notif-more:disabled {
  opacity: 0.55;
  cursor: default;
}

@media (max-width: 860px) {
  .notif-more {
    padding: 11px 10px;
  }
}
</style>
