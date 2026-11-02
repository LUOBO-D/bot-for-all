<script setup lang="ts">
import axios from 'axios';
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import http, { errorMessage } from '../api/http';
import { useChatStore } from '../stores/chat';
import { formatRelative } from '../utils/format';
import { captureVideoPoster } from '../utils/video-poster';
import Icon from './Icon.vue';

const PAGE_SIZE = 20;
// Mirrors the server's per-call cap (`bulk-delete` accepts 1-50 seqs). The
// selection is capped here so the toolbar never promises more than one sweep.
const MAX_BULK = 50;

type MediaFilter = 'image' | 'video' | 'file' | 'audio' | 'all';

const FILTERS: { value: MediaFilter; label: string }[] = [
  { value: 'image', label: '图片' },
  { value: 'video', label: '视频' },
  { value: 'file', label: '文件' },
  { value: 'audio', label: '音频' },
  { value: 'all', label: '全部' },
];

// Mirrors one row of `GET /rooms/:id/attachments`. `messageSeq` is always a
// real seq: the endpoint only lists attachments bound to a live message.
interface MediaItem {
  id: number;
  filename: string;
  mime: string;
  size: number;
  messageSeq: number;
  senderName: string;
  createdAt: string;
  url: string;
}

interface MediaPage {
  attachments: MediaItem[];
  total: number;
}

interface LoadedBlob {
  url: string;
  blob: Blob;
}

const props = defineProps<{
  modelValue: boolean;
  roomId: number;
  canModerate?: boolean;
}>();
const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  // The seqs that were sent to the server; ChatView drops any composer
  // reply/edit target among them.
  deleted: [seqs: number[]];
}>();

const router = useRouter();
const chat = useChatStore();
const panel = ref<HTMLElement | null>(null);
// The unfiltered library is the honest default: it mirrors the endpoint's own
// default and never hides a file the viewer just sent.
const filter = ref<MediaFilter>('all');
// Sender and day filters narrow the same WHERE the type chip does; '' means
// "no constraint" for each of them.
const senderId = ref<number | ''>('');
const dateFrom = ref('');
const dateTo = ref('');
// The input is debounced (300 ms) before it narrows the list: one request per
// pause, not one per keystroke. `searchQ` is the query the server last saw, so
// clearing the box restores the unfiltered library once the debounce settles.
const searchText = ref('');
const searchQ = ref('');
let searchTimer: number | null = null;
const items = ref<MediaItem[]>([]);
const total = ref(0);
const offset = ref(0);
const loading = ref(false);
const loadingMore = ref(false);
const error = ref('');
// A short page means the server had nothing more to give, even if `total`
// still looks higher (a row can be withdrawn between two page requests).
const exhausted = ref(false);

// Object URLs outlive neither their row nor the dialog: each entry is created
// after its blob response lands and revoked when the id leaves the list (new
// filter / reload), on a decode failure, when the dialog closes, and as a
// backstop when the component unmounts. `generation` invalidates requests that
// were in flight across such a teardown so their blob never becomes an
// unrevokable URL.
const blobs = reactive(new Map<number, LoadedBlob>());
const videoPosters = reactive(new Map<number, string>());
const blobLoading = reactive(new Set<number>());
const blobFailed = reactive(new Set<number>());
let generation = 0;
let listToken = 0;
let disposed = false;
let restoreFocus: HTMLElement | null = null;

const hasMore = computed(() => !exhausted.value && items.value.length < total.value);
// An inverted range would be rejected by the server with 400; catching it here
// keeps the dialog quiet (no request, no flash of a stale page).
const rangeError = computed(() => {
  if (!dateFrom.value || !dateTo.value) {
    return '';
  }
  return dateFrom.value > dateTo.value ? '开始日期不能晚于结束日期' : '';
});
const countText = computed(() => {
  if (loading.value) {
    return '加载中…';
  }
  if (rangeError.value) {
    return '日期范围无效';
  }
  return total.value > 0 ? `共 ${total.value} 项` : '暂无媒体';
});
const emptyText = computed(() => {
  if (searchQ.value) {
    return '没有匹配的媒体文件';
  }
  switch (filter.value) {
    case 'image':
      return '还没有图片';
    case 'file':
      return '还没有文件';
    case 'video':
      return '还没有视频';
    case 'audio':
      return '还没有音频';
    default:
      return '还没有媒体文件';
  }
});

function isImage(item: MediaItem): boolean {
  return item.mime.startsWith('image/');
}

function isAudio(item: MediaItem): boolean {
  return item.mime.startsWith('audio/');
}

function isVideo(item: MediaItem): boolean {
  return item.mime.startsWith('video/');
}

// Built from the route instead of `item.url`: the axios instance already owns
// the `/api` prefix, so the DTO's absolute path would duplicate it.
function endpoint(item: MediaItem): string {
  return `/rooms/${props.roomId}/attachments/${item.id}`;
}

async function fetchBlob(item: MediaItem): Promise<Blob> {
  const { data } = await http.get<Blob>(endpoint(item), { responseType: 'blob' });
  return data;
}

function release(id: number) {
  const entry = blobs.get(id);
  if (entry) {
    URL.revokeObjectURL(entry.url);
    blobs.delete(id);
  }
  videoPosters.delete(id);
}

function capturePoster(item: MediaItem, event: Event) {
  if (videoPosters.has(item.id)) {
    return;
  }
  const video = event.target;
  if (!(video instanceof HTMLVideoElement)) {
    return;
  }
  const poster = captureVideoPoster(video);
  if (poster) {
    videoPosters.set(item.id, poster);
  }
}

function releaseAll() {
  for (const id of [...blobs.keys()]) {
    release(id);
  }
}

async function loadBlob(item: MediaItem) {
  if (
    disposed ||
    !props.modelValue ||
    blobs.has(item.id) ||
    blobLoading.has(item.id)
  ) {
    return;
  }
  const token = generation;
  blobLoading.add(item.id);
  try {
    const blob = await fetchBlob(item);
    // The dialog may have closed or switched filters while the request was in
    // flight; creating a URL then would leave it with no owner to revoke.
    if (disposed || token !== generation) {
      return;
    }
    blobs.set(item.id, { url: URL.createObjectURL(blob), blob });
    blobFailed.delete(item.id);
  } catch {
    if (!disposed && token === generation) {
      blobFailed.add(item.id);
    }
  } finally {
    blobLoading.delete(item.id);
  }
}

function markBroken(id: number) {
  // Downloaded fine but the browser cannot decode it (corrupt/unsupported):
  // drop the URL and fall back to the placeholder instead of a broken icon.
  release(id);
  blobFailed.add(id);
}

// The list and the archive must narrow identically: both send the same type,
// name, sender and day filters, so the zip always matches what the grid shows.
function filterParams(): Record<string, string | number> {
  const params: Record<string, string | number> = { type: filter.value };
  if (searchQ.value) {
    params.q = searchQ.value;
  }
  if (senderId.value !== '') {
    params.senderId = senderId.value;
  }
  if (dateFrom.value) {
    params.from = dateFrom.value;
  }
  if (dateTo.value) {
    params.to = dateTo.value;
  }
  return params;
}

async function load(reset: boolean) {
  const token = ++listToken;
  const from = reset ? 0 : offset.value;
  if (reset) {
    loading.value = true;
    error.value = '';
  } else {
    loadingMore.value = true;
  }
  try {
    const params: Record<string, string | number> = {
      ...filterParams(),
      limit: PAGE_SIZE,
      offset: from,
    };
    const { data } = await http.get<MediaPage>(`/rooms/${props.roomId}/attachments`, {
      params,
    });
    if (token !== listToken) {
      return;
    }
    if (reset) {
      items.value = data.attachments;
    } else {
      // Offset paging against a live room: a new upload shifts every row one
      // place, so the next page can repeat an id already on screen. Skipping
      // duplicates keeps the keys unique and the rendered count honest.
      const seen = new Set(items.value.map((item) => item.id));
      items.value = [
        ...items.value,
        ...data.attachments.filter((item) => !seen.has(item.id)),
      ];
    }
    total.value = data.total;
    offset.value = from + data.attachments.length;
    exhausted.value = data.attachments.length < PAGE_SIZE;
  } catch (requestError) {
    if (token !== listToken) {
      return;
    }
    const message = errorMessage(requestError);
    if (reset) {
      items.value = [];
      total.value = 0;
      offset.value = 0;
      error.value = message;
    } else {
      ElMessage.error(message);
    }
  } finally {
    if (token === listToken) {
      loading.value = false;
      loadingMore.value = false;
    }
  }
}

function resetList() {
  generation += 1;
  releaseAll();
  clearSelection();
  blobLoading.clear();
  blobFailed.clear();
  items.value = [];
  total.value = 0;
  offset.value = 0;
  error.value = '';
  exhausted.value = false;
  loading.value = false;
  loadingMore.value = false;
}

// Every filter change restarts at the newest page: offset paging over a
// different WHERE would mix rows from two result sets. An inverted date range
// is refused locally, so no 400 round-trip is ever sent.
function applyFilters() {
  listToken += 1;
  resetList();
  if (rangeError.value) {
    return;
  }
  void load(true);
}

// Typing settles for 300 ms before the query changes. Assigning `searchQ`
// restarts pagination through the filter watcher below; an unchanged term
// (trailing whitespace only, a repeated value) issues no new request.
watch(searchText, (value) => {
  if (searchTimer !== null) {
    window.clearTimeout(searchTimer);
  }
  searchTimer = window.setTimeout(() => {
    searchTimer = null;
    searchQ.value = value.trim();
  }, 300);
});

watch([filter, senderId, dateFrom, dateTo, searchQ], () => {
  if (!props.modelValue) {
    return;
  }
  applyFilters();
});

// Losing the role mid-dialog must also drop the selection UI's state.
watch(
  () => props.canModerate,
  (allowed) => {
    if (!allowed) {
      clearSelection();
    }
  },
);

function close() {
  if (props.modelValue) {
    emit('update:modelValue', false);
  }
}

function openMessage(item: MediaItem) {
  close();
  void router.push(`/rooms/${props.roomId}?seq=${item.messageSeq}`);
}

// Enter/Space on the row itself jumps; the download control inside keeps its
// own activation, so the bubbled keydown must not also open the message.
function onRowKeydown(event: KeyboardEvent, item: MediaItem) {
  if (event.target !== event.currentTarget) {
    return;
  }
  if (event.key !== 'Enter' && event.key !== ' ') {
    return;
  }
  event.preventDefault();
  openMessage(item);
}

function formatSize(size: number): string {
  if (!Number.isFinite(size) || size <= 0) {
    return '';
  }
  if (size < 1024) {
    return `${size} B`;
  }
  const units = ['KB', 'MB', 'GB'];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function metaText(item: MediaItem): string {
  return `${item.senderName} · ${formatRelative(item.createdAt)}`;
}

function subText(item: MediaItem): string {
  const size = formatSize(item.size);
  return size ? `${metaText(item)} · ${size}` : metaText(item);
}

async function save(item: MediaItem) {
  try {
    // Reuse the already-downloaded blob when the media is on screen; the
    // transient URL for the anchor click is revoked on the next macrotask so
    // the browser has time to start the save.
    const cached = blobs.get(item.id);
    const blob = cached ? cached.blob : await fetchBlob(item);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = item.filename || `attachment-${item.id}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (requestError) {
    ElMessage.error(errorMessage(requestError));
  }
}

// "Download all" asks the server for one zip of exactly what the filters
// match; it is only offered once the list has settled on a non-empty page.
const archiveBusy = ref(false);

/**
 * Errors from the archive arrive as JSON, but `responseType: 'blob'` wraps the
 * body in a Blob, so `errorMessage` would only see the status code. Reading the
 * body back keeps the server's explanation ("more than 100 files", "too
 * large") in the toast.
 */
async function archiveErrorText(error: unknown): Promise<string> {
  if (axios.isAxiosError(error) && error.response?.data instanceof Blob) {
    try {
      const payload: unknown = JSON.parse(await error.response.data.text());
      if (typeof payload === 'object' && payload !== null && 'error' in payload) {
        const apiError = payload.error;
        if (
          typeof apiError === 'object' &&
          apiError !== null &&
          'message' in apiError &&
          typeof apiError.message === 'string'
        ) {
          return apiError.message;
        }
      }
    } catch {
      // Not the API's JSON (proxy page, empty body): use the generic message.
    }
  }
  return errorMessage(error);
}

async function downloadArchive() {
  if (archiveBusy.value || loading.value || items.value.length === 0 || rangeError.value) {
    return;
  }
  archiveBusy.value = true;
  let objectUrl: string | null = null;
  try {
    const { data, headers } = await http.get<Blob>(
      `/rooms/${props.roomId}/attachments/archive`,
      { params: filterParams(), responseType: 'blob' },
    );
    objectUrl = URL.createObjectURL(data);
    // The server names the file; the local fallback only matters behind a
    // proxy that drops Content-Disposition.
    const disposition = headers['content-disposition'];
    const named =
      typeof disposition === 'string' ? /filename="([^"]+)"/.exec(disposition) : null;
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = named?.[1] ?? `room-${props.roomId}-media.zip`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } catch (requestError) {
    ElMessage.error(await archiveErrorText(requestError));
  } finally {
    // Same grace period as the single-file save: the browser needs the URL
    // alive while it starts writing the download.
    if (objectUrl) {
      const url = objectUrl;
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    archiveBusy.value = false;
  }
}

// Moderator selection. The unit is a message, not an attachment: several
// files can share one seq, and deleting either withdraws the same row.
const selectedSeqs = ref<Set<number>>(new Set());
const bulkDeleting = ref(false);
const selectedCount = computed(() => selectedSeqs.value.size);
// First-seen order, deduped by messageSeq, so select-all mirrors the grid.
const selectableSeqs = computed(() => {
  const seqs: number[] = [];
  const seen = new Set<number>();
  for (const item of items.value) {
    if (!seen.has(item.messageSeq)) {
      seen.add(item.messageSeq);
      seqs.push(item.messageSeq);
    }
  }
  return seqs;
});
const allSelected = computed(
  () =>
    selectableSeqs.value.length > 0 &&
    selectableSeqs.value.every((seq) => selectedSeqs.value.has(seq)),
);

function isSelected(item: MediaItem): boolean {
  return selectedSeqs.value.has(item.messageSeq);
}

function clearSelection() {
  selectedSeqs.value = new Set();
}

// The native checkbox owns its transient state; this handler mirrors it into
// the Set and reverts the DOM when the 50-message cap refuses the pick.
function onPickChange(item: MediaItem, event: Event) {
  const input = event.target as HTMLInputElement;
  const seq = item.messageSeq;
  if (input.checked) {
    if (!selectedSeqs.value.has(seq) && selectedSeqs.value.size >= MAX_BULK) {
      ElMessage.warning(`一次最多选择 ${MAX_BULK} 条消息`);
      input.checked = false;
      return;
    }
    selectedSeqs.value = new Set(selectedSeqs.value).add(seq);
    return;
  }
  const next = new Set(selectedSeqs.value);
  next.delete(seq);
  selectedSeqs.value = next;
}

function onSelectAllChange(event: Event) {
  const input = event.target as HTMLInputElement;
  if (!input.checked) {
    clearSelection();
    return;
  }
  selectedSeqs.value = new Set(selectableSeqs.value.slice(0, MAX_BULK));
  if (selectableSeqs.value.length > MAX_BULK) {
    ElMessage.warning(`一次最多选择 ${MAX_BULK} 条消息，已选中前 ${MAX_BULK} 条`);
    input.checked = false;
    input.indeterminate = true;
  }
}

async function handleBulkDelete() {
  if (bulkDeleting.value) {
    return;
  }
  const seqs = [...selectedSeqs.value].slice(0, MAX_BULK);
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
    const result = await chat.bulkDeleteMessages(props.roomId, seqs);
    ElMessage.success(`已删除 ${result.deleted} 条消息`);
    clearSelection();
    // Re-read the active filter so withdrawn rows (and their counts) leave the
    // grid; the dialog may have been closed while the request was in flight.
    if (props.modelValue && !rangeError.value) {
      void load(true);
    }
    emit('deleted', seqs);
  } catch (error) {
    // A failed sweep leaves the selection intact so the moderator can retry.
    ElMessage.error(errorMessage(error));
  } finally {
    bulkDeleting.value = false;
  }
}

// Ids, not object identity: a page append keeps existing rows (and their blob
// URLs) untouched, while a filter switch or reload drops the rest.
watch(
  () => items.value.map((item) => item.id).join(','),
  () => {
    const ids = new Set(items.value.map((item) => item.id));
    for (const id of [...blobs.keys()]) {
      if (!ids.has(id)) {
        release(id);
      }
    }
    for (const id of [...blobFailed]) {
      if (!ids.has(id)) {
        blobFailed.delete(id);
      }
    }
    for (const item of items.value) {
      if (isImage(item) || isAudio(item) || isVideo(item)) {
        void loadBlob(item);
      }
    }
  },
);

// While the dialog is modal, Tab must not walk into the page behind it.
function trapFocus(event: KeyboardEvent) {
  const root = panel.value;
  if (!root) {
    return;
  }
  const focusable = Array.from(
    root.querySelectorAll<HTMLElement>(
      'button, [href], audio, video, input, select, [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => !element.hasAttribute('disabled'));
  if (focusable.length === 0) {
    event.preventDefault();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const current = document.activeElement;
  const inside = current instanceof Node && root.contains(current);
  if (event.shiftKey) {
    if (!inside || current === first) {
      event.preventDefault();
      last.focus();
    }
    return;
  }
  if (!inside || current === last) {
    event.preventDefault();
    first.focus();
  }
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    close();
    return;
  }
  if (event.key === 'Tab') {
    trapFocus(event);
  }
}

// Every open starts from the newest page; the chosen filter survives so a
// second look at the room lands where the viewer left off.
watch(
  () => props.modelValue,
  async (open) => {
    if (!open) {
      listToken += 1;
      resetList();
      if (restoreFocus?.isConnected) {
        restoreFocus.focus();
      }
      return;
    }
    restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    resetList();
    await nextTick();
    panel.value?.focus();
    // A range left inverted from the previous visit stays a local error.
    if (!rangeError.value) {
      void load(true);
    }
  },
);

onBeforeUnmount(() => {
  disposed = true;
  generation += 1;
  if (searchTimer !== null) {
    window.clearTimeout(searchTimer);
    searchTimer = null;
  }
  releaseAll();
});
</script>

<template>
  <Teleport to="body">
    <div v-if="modelValue" class="media-overlay" @click.self="close">
      <div
        ref="panel"
        class="media-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="media-title"
        data-testid="media-gallery"
        tabindex="-1"
        @keydown="onKeydown"
      >
        <header class="media-head">
          <div class="media-head-text">
            <h2 id="media-title">媒体库</h2>
            <p class="media-count" data-testid="media-count">{{ countText }}</p>
          </div>
          <div class="media-head-actions">
            <button
              class="btn ghost small"
              type="button"
              data-testid="media-download-all"
              :disabled="archiveBusy || loading || items.length === 0 || !!rangeError"
              :aria-busy="archiveBusy"
              @click="downloadArchive"
            >
              <Icon name="arrowDown" :size="14" />
              <span>{{ archiveBusy ? '打包中…' : '下载筛选结果' }}</span>
            </button>
            <button
              class="media-close"
              type="button"
              data-testid="media-close"
              aria-label="关闭媒体库"
              @click="close"
            >
              <Icon name="close" :size="16" />
            </button>
          </div>
        </header>

        <div class="media-filters" role="group" aria-label="媒体类型">
          <button
            v-for="chip in FILTERS"
            :key="chip.value"
            class="media-chip"
            :class="{ active: filter === chip.value }"
            type="button"
            :aria-pressed="filter === chip.value"
            :data-testid="`media-filter-${chip.value}`"
            @click="filter = chip.value"
          >
            {{ chip.label }}
          </button>
        </div>

        <div class="media-scope" role="group" aria-label="媒体筛选">
          <label class="media-field media-search">
            <span>搜索</span>
            <input
              v-model="searchText"
              type="search"
              data-testid="media-search"
              maxlength="100"
              placeholder="文件名"
              aria-label="按文件名搜索"
            />
          </label>
          <label class="media-field">
            <span>发送者</span>
            <select
              v-model="senderId"
              data-testid="media-sender"
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
          <label class="media-field">
            <span>开始</span>
            <input
              v-model="dateFrom"
              type="date"
              data-testid="media-from"
              :max="dateTo || undefined"
              aria-label="开始日期"
            />
          </label>
          <label class="media-field">
            <span>结束</span>
            <input
              v-model="dateTo"
              type="date"
              data-testid="media-to"
              :min="dateFrom || undefined"
              aria-label="结束日期"
            />
          </label>
        </div>

        <div
          v-if="canModerate && items.length > 0"
          class="media-bulk"
          data-testid="media-bulk-bar"
        >
          <label class="media-bulk-all">
            <input
              type="checkbox"
              data-testid="media-select-all"
              :checked="allSelected"
              :indeterminate="selectedCount > 0 && !allSelected"
              @change="onSelectAllChange"
            />
            <span>全选</span>
          </label>
          <span class="media-bulk-count" data-testid="media-selected-count">
            已选 {{ selectedCount }} 条
          </span>
          <span class="media-bulk-spacer"></span>
          <button
            class="btn danger small"
            type="button"
            data-testid="media-bulk-delete"
            :disabled="bulkDeleting || selectedCount === 0"
            :aria-busy="bulkDeleting"
            @click="handleBulkDelete"
          >
            {{ bulkDeleting ? '删除中…' : '删除选中消息' }}
          </button>
        </div>

        <div class="media-body">
          <div v-if="loading" class="media-state" data-testid="media-loading">加载中…</div>
          <div v-else-if="error" class="media-state media-error" role="alert">
            <span>{{ error }}</span>
            <button class="btn ghost small" type="button" @click="load(true)">重试</button>
          </div>
          <div
            v-else-if="rangeError"
            class="media-state media-error"
            role="alert"
            data-testid="media-range-error"
          >
            <span>{{ rangeError }}</span>
          </div>
          <div v-else-if="items.length === 0" class="media-state" data-testid="media-empty">
            <Icon name="copy" :size="22" />
            <span>{{ emptyText }}</span>
            <span class="media-state-sub">
              聊天里发送的图片、视频、音频和文件会汇总到这里
            </span>
          </div>
          <template v-else>
            <div class="media-grid">
              <template v-for="item in items" :key="item.id">
                <div
                  v-if="isImage(item)"
                  class="media-tile"
                  role="button"
                  tabindex="0"
                  data-testid="media-item"
                  :title="`${item.filename} · ${metaText(item)}`"
                  @click="openMessage(item)"
                  @keydown="onRowKeydown($event, item)"
                >
                  <label
                    v-if="canModerate"
                    class="media-pick"
                    title="选择这条消息"
                    @click.stop
                  >
                    <input
                      type="checkbox"
                      data-testid="media-select"
                      :checked="isSelected(item)"
                      :aria-label="`选择 ${item.filename} 所在的消息`"
                      @change="onPickChange(item, $event)"
                    />
                  </label>
                  <div class="media-thumb">
                    <img
                      v-if="blobs.get(item.id)"
                      :src="blobs.get(item.id)?.url"
                      :alt="item.filename"
                      class="media-image"
                      data-testid="media-item-image"
                      loading="lazy"
                      decoding="async"
                      @error="markBroken(item.id)"
                    />
                    <div
                      v-else
                      class="media-thumb-state"
                      :class="{ failed: blobFailed.has(item.id) }"
                    >
                      <Icon name="copy" :size="14" />
                      <span>{{ blobFailed.has(item.id) ? '图片加载失败' : '图片加载中…' }}</span>
                    </div>
                  </div>
                  <div class="media-tile-caption">
                    <span class="media-name">{{ item.filename }}</span>
                    <span class="media-sub">{{ metaText(item) }}</span>
                  </div>
                </div>

                <div
                  v-else-if="isAudio(item)"
                  class="media-row media-row-audio"
                  data-testid="media-item-audio"
                >
                  <label
                    v-if="canModerate"
                    class="media-pick inline"
                    title="选择这条消息"
                    @click.stop
                  >
                    <input
                      type="checkbox"
                      data-testid="media-select"
                      :checked="isSelected(item)"
                      :aria-label="`选择 ${item.filename} 所在的消息`"
                      @change="onPickChange(item, $event)"
                    />
                  </label>
                  <audio
                    v-if="blobs.get(item.id)"
                    :src="blobs.get(item.id)?.url"
                    class="media-audio"
                    controls
                    preload="metadata"
                    data-testid="media-audio"
                    @error="markBroken(item.id)"
                  ></audio>
                  <div
                    v-else
                    class="media-row-state"
                    :class="{ failed: blobFailed.has(item.id) }"
                  >
                    <Icon name="copy" :size="14" />
                    <span>{{ blobFailed.has(item.id) ? '音频加载失败' : '音频加载中…' }}</span>
                  </div>
                  <div class="media-row-copy">
                    <span class="media-name" :title="item.filename">{{ item.filename }}</span>
                    <span class="media-sub">{{ subText(item) }}</span>
                  </div>
                  <button
                    class="media-download"
                    type="button"
                    data-testid="media-download"
                    :aria-label="`下载 ${item.filename}`"
                    @click.stop="save(item)"
                  >
                    <Icon name="arrowDown" :size="14" />
                    <span>下载</span>
                  </button>
                </div>

                <div
                  v-else-if="isVideo(item)"
                  class="media-row media-row-video"
                  data-testid="media-item-video-row"
                >
                  <label
                    v-if="canModerate"
                    class="media-pick inline"
                    title="选择这条消息"
                    @click.stop
                  >
                    <input
                      type="checkbox"
                      data-testid="media-select"
                      :checked="isSelected(item)"
                      :aria-label="`选择 ${item.filename} 所在的消息`"
                      @change="onPickChange(item, $event)"
                    />
                  </label>
                  <video
                    v-if="blobs.get(item.id)"
                    :src="blobs.get(item.id)?.url"
                    :poster="videoPosters.get(item.id)"
                    class="media-video"
                    controls
                    preload="metadata"
                    data-testid="media-item-video"
                    @loadeddata="capturePoster(item, $event)"
                    @error="markBroken(item.id)"
                  ></video>
                  <div
                    v-else
                    class="media-row-state"
                    :class="{ failed: blobFailed.has(item.id) }"
                  >
                    <Icon name="copy" :size="14" />
                    <span>{{ blobFailed.has(item.id) ? '视频加载失败' : '视频加载中…' }}</span>
                  </div>
                  <div class="media-row-copy">
                    <span class="media-name" :title="item.filename">{{ item.filename }}</span>
                    <span class="media-sub">{{ subText(item) }}</span>
                  </div>
                  <button
                    class="media-download"
                    type="button"
                    data-testid="media-download"
                    :aria-label="`下载 ${item.filename}`"
                    @click.stop="save(item)"
                  >
                    <Icon name="arrowDown" :size="14" />
                    <span>下载</span>
                  </button>
                </div>

                <div
                  v-else
                  class="media-row media-row-file"
                  role="button"
                  tabindex="0"
                  data-testid="media-item-file"
                  @click="openMessage(item)"
                  @keydown="onRowKeydown($event, item)"
                >
                  <label
                    v-if="canModerate"
                    class="media-pick inline"
                    title="选择这条消息"
                    @click.stop
                  >
                    <input
                      type="checkbox"
                      data-testid="media-select"
                      :checked="isSelected(item)"
                      :aria-label="`选择 ${item.filename} 所在的消息`"
                      @change="onPickChange(item, $event)"
                    />
                  </label>
                  <span class="media-row-icon"><Icon name="copy" :size="16" /></span>
                  <div class="media-row-copy">
                    <span class="media-name" :title="item.filename">{{ item.filename }}</span>
                    <span class="media-sub">{{ subText(item) }}</span>
                  </div>
                  <button
                    class="media-download"
                    type="button"
                    data-testid="media-download"
                    :aria-label="`下载 ${item.filename}`"
                    @click.stop="save(item)"
                  >
                    <Icon name="arrowDown" :size="14" />
                    <span>下载</span>
                  </button>
                </div>
              </template>
            </div>
            <button
              v-if="hasMore"
              class="media-more btn ghost small"
              type="button"
              data-testid="media-load-more"
              :disabled="loadingMore"
              @click="load(false)"
            >
              {{ loadingMore ? '加载中…' : '加载更多' }}
            </button>
          </template>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.media-overlay {
  position: fixed;
  inset: 0;
  z-index: 1900;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px 16px;
  background: rgba(21, 23, 15, 0.38);
  -webkit-backdrop-filter: blur(6px) saturate(1.2);
  backdrop-filter: blur(6px) saturate(1.2);
}

/* Glass sheet: the grid scrolls under a fixed head and filter rail, so the
   panel never grows past the viewport on a phone. */
.media-panel {
  display: flex;
  flex-direction: column;
  width: min(640px, 100%);
  max-height: min(680px, calc(100vh - 48px));
  background: var(--glass-pop, rgba(251, 250, 245, 0.88));
  -webkit-backdrop-filter: blur(24px) saturate(1.5);
  backdrop-filter: blur(24px) saturate(1.5);
  border: 1px solid var(--line-strong);
  border-radius: var(--r-lg, 8px);
  box-shadow:
    inset 0 1px 0 var(--glass-hi, rgba(255, 255, 255, 0.6)),
    var(--shadow-dialog, 0 24px 64px rgba(21, 23, 15, 0.18));
  outline: none;
  overflow: hidden;
}

.media-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex: none;
  padding: 16px 18px 10px;
}

.media-head-text h2 {
  margin: 0;
  color: var(--text);
  font-size: var(--fs-h);
  font-weight: 600;
  line-height: 1.3;
}

.media-count {
  margin: 3px 0 0;
  color: var(--faint);
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  letter-spacing: 0.04em;
}

.media-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  flex: none;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}

.media-close:hover {
  background: var(--paper-3);
  color: var(--text);
}

.media-close:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: 2px;
}

.media-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  flex: none;
  padding: 0 18px 10px;
}

/* Sender and day filters share one row under the type chips; they wrap on a
   narrow panel instead of squeezing the date fields. */
.media-scope {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 14px;
  flex: none;
  padding: 0 18px 12px;
  border-bottom: 1px solid var(--line);
}

/* Moderator bulk bar: select-all + count on the left, the destructive action
   on the right. Hidden entirely for non-moderators. */
.media-bulk {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: none;
  padding: 0 18px 10px;
}

.media-bulk-all {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  letter-spacing: 0.04em;
  cursor: pointer;
}

.media-bulk-all input {
  margin: 0;
  accent-color: var(--rust);
  cursor: pointer;
}

.media-bulk-count {
  color: var(--faint);
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
}

.media-bulk-spacer {
  flex: 1;
}

.media-field {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  letter-spacing: 0.04em;
}

.media-field > span {
  flex: none;
}

/* The name filter is free text, so it gets a stable width while the sender
   select and date fields keep their intrinsic size. */
.media-search input {
  width: 160px;
}

.media-field select,
.media-field input {
  min-width: 0;
  padding: 3px 7px;
  border: 1px solid var(--line-strong);
  border-radius: var(--r-sm);
  background: var(--paper);
  color: var(--text);
  font-family: inherit;
  font-size: var(--fs-mono);
  outline: none;
}

.media-field select:focus,
.media-field input:focus {
  border-color: var(--ink);
  background: var(--paper-2);
}

.media-chip {
  padding: 4px 11px;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  background: transparent;
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  letter-spacing: 0.04em;
  cursor: pointer;
  transition: color 0.12s ease-out, background 0.12s ease-out, border-color 0.12s ease-out;
}

.media-chip:hover {
  border-color: var(--rust);
  color: var(--text);
}

.media-chip.active {
  border-color: var(--ink);
  background: var(--ink);
  color: var(--paper);
}

.media-chip:focus-visible {
  outline: 2px solid var(--rust);
  outline-offset: 2px;
}

.media-body {
  min-height: 0;
  padding: 12px 14px 14px;
  overflow-y: auto;
}

.media-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 200px;
  padding: 24px 18px;
  color: var(--muted);
  font-size: var(--fs-sub);
  text-align: center;
}

.media-state-sub {
  max-width: 300px;
  color: var(--faint);
  line-height: 1.5;
}

.media-error {
  color: var(--danger);
}

/* Images flow as tiles; rows (files, audio) span the full width so their
   filename and controls never squeeze into a thumbnail column. */
.media-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
  gap: 8px;
}

.media-tile {
  position: relative;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--paper-3);
  cursor: pointer;
  transition: border-color 0.12s ease-out;
}

.media-tile:hover {
  border-color: var(--rust);
}

.media-tile:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: 2px;
}

/* Selection control: floats over an image tile and sits inline in a file or
   audio row. The label stops its click so the row does not also open. */
.media-pick {
  position: absolute;
  top: 6px;
  left: 6px;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: 1px solid var(--line-strong);
  border-radius: 50%;
  background: var(--glass-pop, rgba(251, 250, 245, 0.88));
  cursor: pointer;
}

.media-pick input {
  width: 14px;
  height: 14px;
  margin: 0;
  accent-color: var(--rust);
  cursor: pointer;
}

.media-pick.inline {
  position: static;
  width: auto;
  height: auto;
  border: 0;
  background: transparent;
}

.media-thumb {
  display: flex;
  align-items: center;
  justify-content: center;
  aspect-ratio: 1 / 1;
  background: var(--paper);
}

.media-image {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.media-thumb-state,
.media-row-state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
}

.media-thumb-state {
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 72px;
}

.media-thumb-state.failed,
.media-row-state.failed {
  color: var(--rust);
}

.media-tile-caption {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  padding: 6px 8px;
  border-top: 1px solid var(--line);
}

.media-row {
  display: flex;
  grid-column: 1 / -1;
  align-items: center;
  gap: 9px;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-left: 2px solid var(--rust);
  border-radius: 0 var(--r-sm) var(--r-sm) 0;
  background: var(--paper-3);
}

.media-row-file {
  cursor: pointer;
  transition: border-color 0.12s ease-out;
}

.media-row-file:hover {
  border-color: var(--rust);
}

.media-row-file:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: 2px;
}

.media-row-audio {
  flex-wrap: wrap;
  align-items: center;
}

.media-row-video {
  flex-wrap: wrap;
  align-items: center;
}

.media-audio {
  display: block;
  width: 100%;
  height: 38px;
  background: var(--paper);
  border-radius: var(--r-sm);
}

.media-video {
  display: block;
  width: 100%;
  max-height: 200px;
  background: var(--paper);
  border-radius: var(--r-sm);
}

.media-row-state {
  width: 100%;
  min-height: 38px;
  border-radius: var(--r-sm);
  background: var(--paper);
}

.media-row-icon {
  display: flex;
  flex: none;
  color: var(--rust);
}

.media-row-copy {
  display: flex;
  flex-direction: column;
  gap: 1px;
  flex: 1;
  min-width: 0;
}

.media-name {
  overflow: hidden;
  color: var(--text);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.media-sub {
  overflow: hidden;
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.media-download {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: none;
  padding: 4px 8px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  cursor: pointer;
}

.media-download:hover {
  border-color: var(--rust);
  color: var(--rust);
}

.media-download:focus-visible {
  outline: 2px solid var(--rust);
  outline-offset: 1px;
}

.media-more {
  display: block;
  margin: 12px auto 2px;
}

/* Header actions: the archive download sits beside the close control, since
   it acts on the whole filtered set rather than on one row. */
.media-head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}

@media (max-width: 480px) {
  .media-overlay {
    padding: 12px;
  }

  .media-panel {
    max-height: calc(100vh - 24px);
  }

  .media-head {
    padding: 14px 14px 8px;
  }

  .media-filters {
    padding: 0 14px 10px;
  }

  .media-scope {
    padding: 0 14px 10px;
  }

  .media-bulk {
    padding: 0 14px 10px;
  }

  .media-grid {
    grid-template-columns: repeat(auto-fill, minmax(108px, 1fr));
  }
}
</style>
