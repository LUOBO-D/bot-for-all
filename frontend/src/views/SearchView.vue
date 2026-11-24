<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import http, { errorMessage } from '../api/http';
import Icon from '../components/Icon.vue';
import UserAvatar from '../components/UserAvatar.vue';
import { useChatStore } from '../stores/chat';
import type { GlobalMessage, RoomSummary } from '../types';
import { formatDate, formatTime, plainPreview } from '../utils/format';

interface SearchResponse {
  messages: GlobalMessage[];
  total: number;
  limit: number;
  offset: number;
}

interface SnippetPart {
  text: string;
  hit: boolean;
}

const PAGE_SIZE = 20;
const DEBOUNCE_MS = 300;
const KEYWORD_MAX = 100;
const SENDER_MIN = 3;
const SENDER_MAX = 32;

const router = useRouter();
const chat = useChatStore();

const keyword = ref('');
const roomId = ref<number | ''>('');
const sender = ref('');
const fromDate = ref('');
const toDate = ref('');

const messages = ref<GlobalMessage[]>([]);
const total = ref(0);
const loading = ref(false);
const loadingMore = ref(false);
const error = ref('');
const formError = ref('');
const searched = ref(false);
// The query the visible results belong to; typing alone must not relabel them.
const appliedQuery = ref('');

const keywordInput = ref<HTMLInputElement | null>(null);

// Every request carries a sequence number: a slow response from an older
// filter combination must never overwrite the newest result set.
let requestId = 0;
let debounceTimer: number | undefined;

const mineRooms = computed<RoomSummary[]>(() => chat.rooms.mine);
const hasMore = computed(() => messages.value.length < total.value);
const remaining = computed(() => Math.max(total.value - messages.value.length, 0));
const showInitialHint = computed(
  () =>
    !searched.value &&
    !loading.value &&
    !error.value &&
    !formError.value &&
    messages.value.length === 0,
);
const showEmpty = computed(
  () =>
    searched.value &&
    !loading.value &&
    !error.value &&
    messages.value.length === 0,
);

onMounted(() => {
  keywordInput.value?.focus();
  // The page is reachable by direct URL: seed the room filter when the store
  // has not loaded the room list yet.
  if (chat.rooms.mine.length === 0) {
    void chat.loadRooms().catch(() => undefined);
  }
});

onUnmounted(() => {
  window.clearTimeout(debounceTimer);
  // A response landing after navigation must not touch this view's state.
  requestId += 1;
});

function validationError(): string {
  const text = keyword.value.trim();
  if (!text) {
    return '请输入关键词';
  }
  if (text.length > KEYWORD_MAX) {
    return `关键词最多 ${KEYWORD_MAX} 个字符`;
  }
  const name = sender.value.trim();
  if (name && (name.length < SENDER_MIN || name.length > SENDER_MAX)) {
    return `发送者用户名需为 ${SENDER_MIN}-${SENDER_MAX} 个字符`;
  }
  if (fromDate.value && toDate.value && fromDate.value > toDate.value) {
    return '开始日期不能晚于结束日期';
  }
  return '';
}

// Day boundaries are inclusive in the UI: `after` is exclusive server-side,
// so it gets one millisecond before local midnight; `before` is exclusive too,
// so the end date is sent as the following midnight.
function isoBoundary(day: string, edge: 'start' | 'end'): string {
  const [year, month, date] = day.split('-').map(Number);
  if (!year || !month || !date) {
    return '';
  }
  const boundary =
    edge === 'start'
      ? new Date(year, month - 1, date, 0, 0, 0, 0)
      : new Date(year, month - 1, date + 1, 0, 0, 0, 0);
  if (Number.isNaN(boundary.getTime())) {
    return '';
  }
  if (edge === 'start') {
    boundary.setTime(boundary.getTime() - 1);
  }
  return boundary.toISOString();
}

function buildParams(offset: number): Record<string, string | number> {
  const params: Record<string, string | number> = {
    q: keyword.value.trim(),
    limit: PAGE_SIZE,
  };
  if (offset > 0) {
    params.offset = offset;
  }
  if (typeof roomId.value === 'number') {
    params.roomId = roomId.value;
  }
  const name = sender.value.trim();
  if (name) {
    params.sender = name;
  }
  const after = fromDate.value ? isoBoundary(fromDate.value, 'start') : '';
  if (after) {
    params.after = after;
  }
  const before = toDate.value ? isoBoundary(toDate.value, 'end') : '';
  if (before) {
    params.before = before;
  }
  return params;
}

function clearResults() {
  requestId += 1;
  messages.value = [];
  total.value = 0;
  searched.value = false;
  error.value = '';
  formError.value = '';
  appliedQuery.value = '';
  loading.value = false;
  loadingMore.value = false;
}

async function runSearch(append: boolean) {
  window.clearTimeout(debounceTimer);
  const problem = validationError();
  if (problem) {
    // Field-level problems belong to the form; wiping the current results
    // would punish a typo in one filter.
    formError.value = problem;
    return;
  }
  formError.value = '';

  const offset = append ? messages.value.length : 0;
  const query = keyword.value.trim();
  const id = ++requestId;
  if (append) {
    loadingMore.value = true;
  } else {
    loading.value = true;
  }
  error.value = '';

  try {
    const { data } = await http.get<SearchResponse>('/search/messages', {
      params: buildParams(offset),
    });
    if (id !== requestId) {
      return;
    }
    if (append) {
      const seen = new Set(messages.value.map((message) => `${message.roomId}-${message.seq}`));
      const fresh = data.messages.filter(
        (message) => !seen.has(`${message.roomId}-${message.seq}`),
      );
      messages.value = [...messages.value, ...fresh];
      // Nothing new means the window moved past the tail; stop offering more.
      total.value = fresh.length === 0 ? messages.value.length : data.total;
    } else {
      messages.value = data.messages;
      total.value = data.total;
      appliedQuery.value = query;
    }
    searched.value = true;
  } catch (caught) {
    if (id !== requestId) {
      return;
    }
    error.value = errorMessage(caught);
    if (!append) {
      messages.value = [];
      total.value = 0;
    }
  } finally {
    if (id === requestId) {
      loading.value = false;
      loadingMore.value = false;
    }
  }
}

function loadMore() {
  if (loading.value || loadingMore.value || !hasMore.value) {
    return;
  }
  void runSearch(true);
}

function reset() {
  window.clearTimeout(debounceTimer);
  keyword.value = '';
  roomId.value = '';
  sender.value = '';
  fromDate.value = '';
  toDate.value = '';
  clearResults();
  keywordInput.value?.focus();
}

// Filters narrow a required keyword, so an empty keyword means "no query yet"
// rather than "search everything". Auto-search only fires for a valid form.
watch([keyword, roomId, sender, fromDate, toDate], () => {
  window.clearTimeout(debounceTimer);
  // Any in-flight response now describes a filter set the user already left.
  requestId += 1;
  loading.value = false;
  loadingMore.value = false;
  if (!keyword.value.trim()) {
    clearResults();
    return;
  }
  if (validationError()) {
    return;
  }
  formError.value = '';
  debounceTimer = window.setTimeout(() => {
    void runSearch(false);
  }, DEBOUNCE_MS);
});

function openMessage(message: GlobalMessage) {
  void router.push(`/rooms/${message.roomId}?seq=${message.seq}`);
}

function backToRooms() {
  void router.push('/rooms');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function snippetParts(content: string): SnippetPart[] {
  const text = plainPreview(content) || '（无文本内容）';
  const needle = appliedQuery.value;
  if (!needle) {
    return [{ text, hit: false }];
  }
  const parts = text.split(new RegExp(`(${escapeRegExp(needle)})`, 'gi'));
  return parts
    .map((part, index) => ({ text: part, hit: index % 2 === 1 }))
    .filter((part) => part.text !== '');
}

function resultTime(value: string): string {
  return `${formatDate(value)} ${formatTime(value)}`;
}
</script>

<template>
  <div class="search-page">
    <header class="search-topbar">
      <button class="icon-btn back-btn" type="button" title="返回房间" @click="backToRooms">
        <Icon name="reply" :size="17" />
        <span class="back-label">房间</span>
      </button>
      <div class="search-title">
        <h1>全局搜索</h1>
        <p>在所有已加入的房间中查找消息</p>
      </div>
      <span class="spacer"></span>
      <span v-if="searched && !error" class="count-chip">
        {{ total }} 条结果
      </span>
    </header>

    <main class="search-body">
      <div class="search-inner">
        <form class="search-filters" role="search" @submit.prevent="runSearch(false)">
          <label class="field field-keyword">
            <span>关键词</span>
            <input
              ref="keywordInput"
              v-model="keyword"
              type="search"
              name="q"
              :maxlength="KEYWORD_MAX"
              placeholder="搜索消息内容，必填"
              autocomplete="off"
              aria-label="搜索关键词"
            />
          </label>
          <label class="field">
            <span>房间</span>
            <select v-model="roomId" aria-label="按房间筛选">
              <option value="">全部房间</option>
              <option v-for="room in mineRooms" :key="room.id" :value="room.id">
                {{ room.name }}
              </option>
            </select>
          </label>
          <label class="field">
            <span>发送者</span>
            <input
              v-model="sender"
              type="text"
              name="sender"
              :maxlength="SENDER_MAX"
              placeholder="用户名，精确匹配"
              autocomplete="off"
              aria-label="发送者用户名"
            />
          </label>
          <label class="field field-date">
            <span>开始日期</span>
            <input
              v-model="fromDate"
              type="date"
              name="from"
              :max="toDate || undefined"
              aria-label="开始日期"
            />
          </label>
          <label class="field field-date">
            <span>结束日期</span>
            <input
              v-model="toDate"
              type="date"
              name="to"
              :min="fromDate || undefined"
              aria-label="结束日期"
            />
          </label>
          <div class="field-actions">
            <button class="btn primary" type="submit" :disabled="loading || loadingMore">
              <Icon name="search" :size="15" />
              {{ loading ? '搜索中…' : '搜索' }}
            </button>
            <button class="btn ghost" type="button" @click="reset">重置</button>
            <span class="form-note">筛选条件用于缩小关键词搜索范围</span>
          </div>
          <p v-if="formError" class="form-error" role="alert">{{ formError }}</p>
        </form>

        <section class="search-results" :aria-busy="loading">
          <div class="results-head">
            <h2>结果</h2>
            <span v-if="searched && !loading" class="results-count">{{ total }} 条</span>
            <span v-else-if="loading" class="results-count">搜索中…</span>
            <span class="spacer"></span>
            <span v-if="appliedQuery" class="results-keyword">“{{ appliedQuery }}”</span>
          </div>

          <div v-if="loading && messages.length === 0" class="skeleton-list" aria-hidden="true">
            <div v-for="index in 4" :key="index" class="skeleton"></div>
          </div>

          <div v-else-if="error && messages.length === 0" class="state-panel error-panel" role="alert">
            <strong>搜索失败</strong>
            <p>{{ error }}</p>
            <button class="btn ghost small" type="button" @click="runSearch(false)">重试</button>
          </div>

          <div v-else-if="messages.length" class="result-list">
            <button
              v-for="message in messages"
              :key="`${message.roomId}-${message.seq}`"
              class="result"
              type="button"
              :title="`在 ${message.roomName} 中查看这条消息`"
              @click="openMessage(message)"
            >
              <UserAvatar
                class="result-avatar"
                :avatar="message.senderAvatar"
                :id="message.senderId"
                :name="message.senderName"
              />
              <span class="result-main">
                <span class="result-meta">
                  <span class="result-room">
                    <Icon name="hash" :size="12" />
                    {{ message.roomName }}
                  </span>
                  <span class="result-sender">{{ message.senderName }}</span>
                  <time class="result-time" :datetime="message.createdAt">
                    {{ resultTime(message.createdAt) }}
                  </time>
                </span>
                <span class="result-snippet">
                  <template
                    v-for="(part, index) in snippetParts(message.content)"
                    :key="index"
                  >
                    <span v-if="part.hit" class="hit">{{ part.text }}</span>
                    <template v-else>{{ part.text }}</template>
                  </template>
                </span>
              </span>
              <Icon class="result-go" name="forward" :size="15" />
            </button>

            <p v-if="error" class="append-error" role="alert">{{ error }}</p>

            <div v-if="hasMore" class="load-more">
              <button
                class="btn ghost"
                type="button"
                :disabled="loadingMore"
                @click="loadMore"
              >
                {{ loadingMore ? '加载中…' : `加载更多（还有 ${remaining} 条）` }}
              </button>
            </div>
            <p v-else class="list-end">已显示全部 {{ total }} 条结果</p>
          </div>

          <div v-else-if="showEmpty" class="state-panel">
            <strong>没有找到匹配的消息</strong>
            <p>试试缩短关键词，或放宽房间、发送者、日期筛选。</p>
          </div>

          <div v-else-if="showInitialHint" class="state-panel">
            <Icon class="state-icon" name="search" :size="22" />
            <strong>输入关键词开始搜索</strong>
            <p>搜索范围是已加入的全部房间；可选按房间、发送者与日期缩小结果。</p>
          </div>
        </section>
      </div>
    </main>
  </div>
</template>

<style scoped>
.search-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--paper);
}

/* Frosted topbar: the only fixed-layer glass surface on this page. */
.search-topbar {
  position: relative;
  z-index: 6;
  display: flex;
  align-items: center;
  gap: 10px;
  flex: none;
  height: 56px;
  padding: 0 18px 0 12px;
  background: var(--paper);
  background: var(--glass-bar);
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-sat));
  backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-sat));
  border-bottom: 1px solid var(--line);
  box-shadow: inset 0 1px 0 var(--glass-hi), 0 8px 24px rgba(0, 0, 0, 0.25);
}

.back-btn {
  width: auto;
  gap: 5px;
  padding: 0 10px;
  font-size: 13px;
  font-weight: 600;
}

.back-btn .back-label {
  line-height: 1;
}

.search-title {
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-width: 0;
  gap: 1px;
}

.search-title h1 {
  margin: 0;
  font-size: var(--fs-h);
  font-weight: 700;
  letter-spacing: -0.01em;
  line-height: 1.15;
}

.search-title p {
  margin: 0;
  font-size: var(--fs-sub);
  color: var(--muted);
  line-height: 1.2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.count-chip {
  flex: none;
  padding: 3px 9px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--paper-2);
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  letter-spacing: 0.04em;
  white-space: nowrap;
}

.search-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 22px 22px 56px;
}

.search-inner {
  display: flex;
  flex-direction: column;
  gap: 18px;
  max-width: 940px;
  margin: 0 auto;
}

/* Filter sheet: one static frosted surface, never on scrolling rows. */
.search-filters {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  background: var(--paper-2);
  background: var(--glass-bar-strong);
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-sat));
  backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-sat));
  box-shadow: inset 0 1px 0 var(--glass-hi), var(--glass-shadow);
}

.search-filters .field {
  margin-bottom: 0;
  min-width: 0;
}

.field-keyword {
  grid-column: span 2;
}

.field-date {
  grid-column: span 2;
}

.field-actions {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.form-note {
  margin-left: auto;
  color: var(--faint);
  font-size: 12px;
}

.form-error {
  grid-column: 1 / -1;
  margin: 0;
  padding: 7px 10px;
  border: 1px solid var(--danger);
  border-radius: var(--r-md);
  background: var(--danger-soft);
  color: var(--danger);
  font-size: 12px;
}

.search-results {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.results-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.results-head h2 {
  margin: 0;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--muted);
}

.results-count {
  color: var(--faint);
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  letter-spacing: 0.06em;
}

.results-keyword {
  max-width: 45%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--muted);
  font-size: 12px;
}

.result-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.result {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  width: 100%;
  min-width: 0;
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: var(--paper-2);
  color: var(--text);
  text-align: left;
  transition: border-color 0.12s ease-out, background 0.12s ease-out,
    box-shadow 0.12s ease-out;
}

.result:hover {
  border-color: var(--line-strong);
  background: var(--paper-3);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.25);
}

.result-avatar {
  width: 30px;
  height: 30px;
  margin-top: 1px;
  font-size: 13px;
}

.result-main {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  min-width: 0;
}

.result-meta {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  font-size: 12px;
}

.result-room {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex: none;
  max-width: 40%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--text);
  font-weight: 600;
}

.result-sender {
  flex: none;
  max-width: 30%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--muted);
}

.result-time {
  margin-left: auto;
  flex: none;
  color: var(--faint);
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  letter-spacing: 0.02em;
}

.result-snippet {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  color: var(--muted);
  font-size: var(--fs-sub);
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.result-snippet .hit {
  padding: 0 1px;
  border-radius: 2px;
  background: var(--lime);
  color: var(--ink);
  font-weight: 600;
}

.result-go {
  flex: none;
  margin-top: 3px;
  color: var(--line-strong);
}

.result:hover .result-go {
  color: var(--ink);
}

.state-panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 40px 24px;
  border: 1px dashed var(--line-strong);
  border-radius: var(--r-lg);
  background: var(--paper-2);
  text-align: center;
}

.state-panel strong {
  font-size: var(--fs-body);
}

.state-panel p {
  margin: 0;
  max-width: 46ch;
  color: var(--muted);
  font-size: var(--fs-sub);
}

.state-icon {
  color: var(--line-strong);
}

.error-panel {
  border-style: solid;
  border-color: var(--danger);
  background: var(--danger-soft);
}

.error-panel strong,
.error-panel p {
  color: var(--danger);
}

.append-error {
  margin: 0;
  padding: 8px 10px;
  border: 1px solid var(--danger);
  border-radius: var(--r-md);
  background: var(--danger-soft);
  color: var(--danger);
  font-size: 12px;
}

.load-more {
  display: flex;
  justify-content: center;
  padding: 4px 0 0;
}

.list-end {
  margin: 0;
  padding: 10px 0 0;
  color: var(--faint);
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  letter-spacing: 0.06em;
  text-align: center;
}

.skeleton-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.skeleton {
  height: 66px;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: linear-gradient(90deg, var(--paper-3), var(--paper-2), var(--paper-3));
  background-size: 200% 100%;
  animation: shimmer 1.3s linear infinite;
}

@keyframes shimmer {
  from {
    background-position: 200% 0;
  }
  to {
    background-position: -200% 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .skeleton {
    animation: none;
  }
}

@media (max-width: 820px) {
  .search-filters {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .field-keyword {
    grid-column: 1 / -1;
  }

  .field-date {
    grid-column: span 1;
  }

  .form-note {
    margin-left: 0;
    flex-basis: 100%;
  }
}

@media (max-width: 560px) {
  .search-topbar {
    padding: 0 10px 0 6px;
  }

  .back-btn .back-label {
    display: none;
  }

  .search-title p {
    display: none;
  }

  .search-body {
    padding: 14px 10px 40px;
  }

  .search-filters {
    grid-template-columns: minmax(0, 1fr);
    padding: 12px;
  }

  .result-time {
    display: none;
  }

  .result-go {
    display: none;
  }
}
</style>
