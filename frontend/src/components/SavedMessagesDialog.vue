<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import http, { errorMessage } from '../api/http';
import type { SavedMessage } from '../types';
import { formatRelative, plainPreview } from '../utils/format';
import Icon from './Icon.vue';

const PAGE_SIZE = 20;

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();

// Mirrors `GET /me/saved`; `offset` is the number of rows already taken from
// the server, which can differ from the rendered count after a removal.
interface SavedPage {
  items: SavedMessage[];
  total: number;
  limit: number;
  offset: number;
}

const router = useRouter();
const panel = ref<HTMLElement | null>(null);
const items = ref<SavedMessage[]>([]);
const total = ref(0);
const offset = ref(0);
const loading = ref(false);
const loadingMore = ref(false);
const error = ref('');
const removing = ref<string | null>(null);
const searchInput = ref('');
const query = ref('');
let requestId = 0;
let searchTimer: ReturnType<typeof setTimeout> | null = null;
let restoreFocus: HTMLElement | null = null;

const hasMore = computed(() => items.value.length < total.value);
const countText = computed(() => (total.value > 0 ? `共 ${total.value} 条` : '暂无记录'));

function keyOf(item: SavedMessage): string {
  return `${item.message.roomId}-${item.message.seq}`;
}

function summaryOf(item: SavedMessage): string {
  if (item.message.deleted) {
    return '消息已撤回';
  }
  return plainPreview(item.message.content).slice(0, 120) || '（空消息）';
}

async function load(reset: boolean) {
  const id = ++requestId;
  const from = reset ? 0 : offset.value;
  if (reset) {
    loading.value = true;
    error.value = '';
  } else {
    loadingMore.value = true;
  }
  try {
    const { data } = await http.get<SavedPage>('/me/saved', {
      params: {
        limit: PAGE_SIZE,
        offset: from,
        ...(query.value === '' ? {} : { q: query.value }),
      },
    });
    if (id !== requestId) {
      return;
    }
    items.value = reset ? data.items : [...items.value, ...data.items];
    total.value = data.total;
    offset.value = from + data.items.length;
  } catch (requestError) {
    if (id !== requestId) {
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
    if (id === requestId) {
      loading.value = false;
      loadingMore.value = false;
    }
  }
}

function close() {
  if (props.modelValue) {
    emit('update:modelValue', false);
  }
}

function openItem(item: SavedMessage) {
  close();
  void router.push(`/rooms/${item.message.roomId}?seq=${item.message.seq}`);
}

async function remove(item: SavedMessage) {
  const key = keyOf(item);
  if (removing.value !== null) {
    return;
  }
  removing.value = key;
  try {
    await http.delete(`/rooms/${item.message.roomId}/messages/${item.message.seq}/save`);
    items.value = items.value.filter((entry) => keyOf(entry) !== key);
    total.value = Math.max(0, total.value - 1);
    offset.value = Math.max(0, offset.value - 1);
    ElMessage.success('已取消保存');
  } catch (requestError) {
    ElMessage.error(errorMessage(requestError));
  } finally {
    removing.value = null;
  }
}

// While the dialog is modal, Tab must not walk into the page behind it.
function trapFocus(event: KeyboardEvent) {
  const root = panel.value;
  if (!root) {
    return;
  }
  const focusable = Array.from(
    root.querySelectorAll<HTMLElement>(
      'button, [href], input, [tabindex]:not([tabindex="-1"])',
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

// 300 ms after the last keystroke, drop the current page and refetch with the
// trimmed query. Clearing the input sets q to '', restoring the full list.
watch(searchInput, () => {
  if (searchTimer !== null) {
    clearTimeout(searchTimer);
  }
  searchTimer = setTimeout(() => {
    searchTimer = null;
    const next = searchInput.value.trim();
    if (next === query.value) {
      return;
    }
    query.value = next;
    offset.value = 0;
    void load(true);
  }, 300);
});

// Every open starts from the newest page: a bookmark added (or removed) since
// the last look must be reflected, and stale rows must never linger.
watch(
  () => props.modelValue,
  async (open) => {
    if (!open) {
      requestId += 1;
      loading.value = false;
      loadingMore.value = false;
      if (searchTimer !== null) {
        clearTimeout(searchTimer);
        searchTimer = null;
      }
      if (restoreFocus?.isConnected) {
        restoreFocus.focus();
      }
      return;
    }
    restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    items.value = [];
    total.value = 0;
    offset.value = 0;
    error.value = '';
    searchInput.value = '';
    query.value = '';
    await nextTick();
    panel.value?.focus();
    void load(true);
  },
);
</script>

<template>
  <Teleport to="body">
    <div v-if="modelValue" class="saved-overlay" @click.self="close">
      <div
        ref="panel"
        class="saved-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="saved-title"
        data-testid="saved-dialog"
        tabindex="-1"
        @keydown="onKeydown"
      >
        <header class="saved-head">
          <div class="saved-head-text">
            <h2 id="saved-title">已保存消息</h2>
            <p class="saved-count">{{ countText }}</p>
          </div>
          <button
            class="saved-close"
            type="button"
            aria-label="关闭已保存消息"
            @click="close"
          >
            <Icon name="close" :size="16" />
          </button>
        </header>

        <div class="saved-body">
          <div class="saved-search-row">
            <input
              v-model="searchInput"
              class="saved-search-input"
              type="search"
              data-testid="saved-search"
              aria-label="搜索收藏内容"
              placeholder="搜索收藏内容"
              autocomplete="off"
            />
          </div>
          <div v-if="loading" class="saved-state">加载中…</div>
          <div v-else-if="error" class="saved-state saved-error">
            <span>{{ error }}</span>
            <button class="btn ghost small" type="button" @click="load(true)">重试</button>
          </div>
          <div v-else-if="items.length === 0" class="saved-state" data-testid="saved-empty">
            <Icon name="chat" :size="22" />
            <span>{{ query === '' ? '暂无收藏' : '没有匹配的收藏' }}</span>
            <span v-if="query === ''" class="saved-state-sub">
              在消息菜单里选择「保存消息」，之后可以在这里找到
            </span>
            <span v-else class="saved-state-sub">试试其它关键词，或清空搜索</span>
          </div>
          <template v-else>
            <ul class="saved-list">
              <li v-for="item in items" :key="keyOf(item)" class="saved-row" data-testid="saved-row">
                <div
                  class="saved-item"
                  role="button"
                  tabindex="0"
                  data-testid="saved-item"
                  @click="openItem(item)"
                  @keydown.enter.prevent="openItem(item)"
                  @keydown.space.prevent="openItem(item)"
                >
                  <span class="saved-meta">
                    <span class="saved-room">#{{ item.roomName }}</span>
                    <span class="saved-sender">{{ item.message.senderName }}</span>
                    <span class="saved-time">{{ formatRelative(item.savedAt) }}</span>
                  </span>
                  <span class="saved-summary" :class="{ withdrawn: item.message.deleted }">
                    {{ summaryOf(item) }}
                  </span>
                </div>
                <button
                  class="saved-remove"
                  type="button"
                  data-testid="saved-remove"
                  :disabled="removing === keyOf(item)"
                  :aria-label="`移除保存：${summaryOf(item)}`"
                  title="移除保存"
                  @click.stop="remove(item)"
                >
                  <Icon name="trash" :size="14" />
                </button>
              </li>
            </ul>
            <button
              v-if="hasMore"
              class="saved-more btn ghost small"
              type="button"
              data-testid="saved-load-more"
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
.saved-overlay {
  position: fixed;
  inset: 0;
  z-index: 3000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px 16px;
  background: rgba(21, 23, 15, 0.38);
  -webkit-backdrop-filter: blur(6px) saturate(1.2);
  backdrop-filter: blur(6px) saturate(1.2);
}

/* Glass sheet: the list scrolls under a fixed head, so the sheet never grows
   past the viewport on a phone. */
.saved-panel {
  display: flex;
  flex-direction: column;
  width: min(560px, 100%);
  max-height: min(640px, calc(100vh - 48px));
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

.saved-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex: none;
  padding: 16px 18px 12px;
  border-bottom: 1px solid var(--line);
}

.saved-head-text h2 {
  margin: 0;
  color: var(--text);
  font-size: var(--fs-h);
  font-weight: 600;
  line-height: 1.3;
}

.saved-count {
  margin: 3px 0 0;
  color: var(--faint);
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  letter-spacing: 0.04em;
}

.saved-close {
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

.saved-close:hover {
  background: var(--paper-3);
  color: var(--text);
}

.saved-close:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: 2px;
}

.saved-body {
  min-height: 0;
  padding: 8px 10px 10px;
  overflow-y: auto;
}

.saved-search-row {
  padding: 2px 4px 8px;
}

.saved-search-input {
  width: 100%;
  padding: 7px 10px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--paper, transparent);
  color: var(--text);
  font: inherit;
  font-size: var(--fs-sub);
  outline: none;
}

.saved-search-input::placeholder {
  color: var(--faint);
}

.saved-search-input:focus {
  border-color: var(--ink);
}

.saved-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 180px;
  padding: 24px 18px;
  color: var(--muted);
  font-size: var(--fs-sub);
  text-align: center;
}

.saved-state-sub {
  max-width: 300px;
  color: var(--faint);
  line-height: 1.5;
}

.saved-error {
  color: var(--danger);
}

.saved-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.saved-row {
  display: flex;
  align-items: stretch;
  gap: 2px;
  border-radius: var(--r-md);
}

.saved-row:hover {
  background: var(--paper-3);
}

.saved-item {
  display: flex;
  flex-direction: column;
  gap: 3px;
  flex: 1;
  min-width: 0;
  padding: 9px 10px;
  border-radius: var(--r-md);
  cursor: pointer;
}

.saved-item:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: -2px;
}

.saved-meta {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  letter-spacing: 0.02em;
}

.saved-room {
  flex: none;
  max-width: 40%;
  overflow: hidden;
  color: var(--rust);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.saved-sender {
  min-width: 0;
  overflow: hidden;
  color: var(--muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.saved-time {
  flex: none;
  margin-left: auto;
  color: var(--faint);
  white-space: nowrap;
}

.saved-summary {
  display: -webkit-box;
  overflow: hidden;
  color: var(--text);
  font-size: var(--fs-sub);
  line-height: 1.5;
  overflow-wrap: anywhere;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.saved-summary.withdrawn {
  color: var(--faint);
  font-style: italic;
}

.saved-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  flex: none;
  align-self: stretch;
  border: 0;
  border-radius: var(--r-md);
  background: transparent;
  color: var(--faint);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.12s ease-out, color 0.12s ease-out;
}

.saved-row:hover .saved-remove,
.saved-remove:focus-visible {
  opacity: 1;
}

.saved-remove:hover:not(:disabled) {
  color: var(--danger);
}

.saved-remove:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: -2px;
}

.saved-remove:disabled {
  cursor: default;
  opacity: 0.4;
}

.saved-more {
  display: block;
  margin: 10px auto 2px;
}

@media (hover: none) {
  /* Touch has no hover: the remove control stays visible. */
  .saved-remove {
    opacity: 1;
  }
}

@media (max-width: 480px) {
  .saved-overlay {
    padding: 12px;
  }

  .saved-panel {
    max-height: calc(100vh - 24px);
  }

  .saved-head {
    padding: 14px 14px 10px;
  }
}
</style>
