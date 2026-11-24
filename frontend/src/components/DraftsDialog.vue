<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import http, { errorMessage } from '../api/http';
import { formatRelative, plainPreview } from '../utils/format';
import Icon from './Icon.vue';

// Mirrors `GET /me/drafts`: every room the viewer still belongs to and has a
// non-empty draft in, newest first. The endpoint already caps the list at 50.
interface DraftItem {
  roomId: number;
  roomName: string;
  content: string;
  updatedAt: string;
}

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();

const router = useRouter();
const panel = ref<HTMLElement | null>(null);
const items = ref<DraftItem[]>([]);
const loading = ref(false);
const error = ref('');
const deleting = ref<number | null>(null);
let requestId = 0;
let restoreFocus: HTMLElement | null = null;

const countText = computed(() =>
  items.value.length > 0 ? `共 ${items.value.length} 条草稿` : '暂无草稿',
);

function summaryOf(draft: DraftItem): string {
  return plainPreview(draft.content).slice(0, 120) || '（空白草稿）';
}

async function load() {
  const id = ++requestId;
  loading.value = true;
  error.value = '';
  try {
    const { data } = await http.get<{ drafts: DraftItem[] }>('/me/drafts');
    if (id !== requestId) {
      return;
    }
    items.value = data.drafts;
  } catch (requestError) {
    if (id !== requestId) {
      return;
    }
    const message = errorMessage(requestError);
    error.value = message;
    items.value = [];
    ElMessage.error(message);
  } finally {
    if (id === requestId) {
      loading.value = false;
    }
  }
}

function close() {
  if (props.modelValue) {
    emit('update:modelValue', false);
  }
}

function openDraft(draft: DraftItem) {
  close();
  // Composer requests the room's server draft on entry, so landing in the
  // room is all that is needed to restore the text.
  void router.push(`/rooms/${draft.roomId}`);
}

async function remove(draft: DraftItem) {
  if (deleting.value !== null) {
    return;
  }
  deleting.value = draft.roomId;
  try {
    // Same contract as the composer: an empty string deletes the row.
    await http.put(`/rooms/${draft.roomId}/draft`, { content: '' });
    items.value = items.value.filter((entry) => entry.roomId !== draft.roomId);
    ElMessage.success('已删除草稿');
  } catch (requestError) {
    ElMessage.error(errorMessage(requestError));
  } finally {
    deleting.value = null;
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

// Every open refetches: a draft may have been written or cleared since the
// last look, and stale rows must never linger.
watch(
  () => props.modelValue,
  async (open) => {
    if (!open) {
      requestId += 1;
      loading.value = false;
      if (restoreFocus?.isConnected) {
        restoreFocus.focus();
      }
      return;
    }
    restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    items.value = [];
    error.value = '';
    // Show the loading state from the first frame; `load` runs after the
    // panel is focused and would otherwise flash the empty state.
    loading.value = true;
    await nextTick();
    if (!props.modelValue) {
      return;
    }
    panel.value?.focus();
    void load();
  },
);
</script>

<template>
  <Teleport to="body">
    <div v-if="modelValue" class="drafts-overlay" @click.self="close">
      <div
        ref="panel"
        class="drafts-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="drafts-title"
        data-testid="drafts-dialog"
        tabindex="-1"
        @keydown="onKeydown"
      >
        <header class="drafts-head">
          <div class="drafts-head-text">
            <h2 id="drafts-title">草稿箱</h2>
            <p class="drafts-count">{{ countText }}</p>
          </div>
          <button
            class="drafts-close"
            type="button"
            aria-label="关闭草稿箱"
            @click="close"
          >
            <Icon name="close" :size="16" />
          </button>
        </header>

        <div class="drafts-body">
          <div v-if="loading" class="drafts-state">加载中…</div>
          <div v-else-if="error" class="drafts-state drafts-error">
            <span>{{ error }}</span>
            <button class="btn ghost small" type="button" @click="load">重试</button>
          </div>
          <div
            v-else-if="items.length === 0"
            class="drafts-state"
            data-testid="draft-empty"
          >
            <Icon name="edit" :size="22" />
            <span>暂无草稿</span>
            <span class="drafts-state-sub">
              在房间里输入但还没发送的内容会出现在这里
            </span>
          </div>
          <ul v-else class="drafts-list">
            <li v-for="draft in items" :key="draft.roomId" class="drafts-row">
              <div
                class="drafts-item"
                role="button"
                tabindex="0"
                data-testid="draft-item"
                @click="openDraft(draft)"
                @keydown.enter.prevent="openDraft(draft)"
                @keydown.space.prevent="openDraft(draft)"
              >
                <span class="drafts-meta">
                  <span class="drafts-room">#{{ draft.roomName }}</span>
                  <span class="drafts-time">{{ formatRelative(draft.updatedAt) }}</span>
                </span>
                <span class="drafts-summary">{{ summaryOf(draft) }}</span>
              </div>
              <button
                class="drafts-delete"
                type="button"
                data-testid="draft-delete"
                :disabled="deleting === draft.roomId"
                :aria-label="`删除草稿：${draft.roomName}`"
                title="删除草稿"
                @click.stop="remove(draft)"
              >
                <Icon name="trash" :size="14" />
              </button>
            </li>
          </ul>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.drafts-overlay {
  position: fixed;
  inset: 0;
  z-index: 3000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px 16px;
  background: rgba(4, 6, 18, 0.55);
  -webkit-backdrop-filter: blur(6px) saturate(1.2);
  backdrop-filter: blur(6px) saturate(1.2);
}

/* Glass sheet: the list scrolls under a fixed head, so the sheet never grows
   past the viewport on a phone. */
.drafts-panel {
  display: flex;
  flex-direction: column;
  width: min(560px, 100%);
  max-height: min(640px, calc(100vh - 48px));
  background: var(--glass-pop, rgba(16, 21, 42, 0.92));
  -webkit-backdrop-filter: blur(24px) saturate(1.5);
  backdrop-filter: blur(24px) saturate(1.5);
  border: 1px solid var(--line-strong);
  border-radius: var(--r-lg, 8px);
  box-shadow:
    inset 0 1px 0 var(--glass-hi, rgba(236, 233, 226, 0.1)),
    var(--shadow-dialog, 0 24px 64px rgba(0, 0, 0, 0.5));
  outline: none;
  overflow: hidden;
}

.drafts-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex: none;
  padding: 16px 18px 12px;
  border-bottom: 1px solid var(--line);
}

.drafts-head-text h2 {
  margin: 0;
  color: var(--text);
  font-size: var(--fs-h);
  font-weight: 600;
  line-height: 1.3;
}

.drafts-count {
  margin: 3px 0 0;
  color: var(--faint);
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  letter-spacing: 0.04em;
}

.drafts-close {
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

.drafts-close:hover {
  background: var(--paper-3);
  color: var(--text);
}

.drafts-close:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: 2px;
}

.drafts-body {
  min-height: 0;
  padding: 8px 10px 10px;
  overflow-y: auto;
}

.drafts-state {
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

.drafts-state-sub {
  max-width: 300px;
  color: var(--faint);
  line-height: 1.5;
}

.drafts-error {
  color: var(--danger);
}

.drafts-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.drafts-row {
  display: flex;
  align-items: stretch;
  gap: 2px;
  border-radius: var(--r-md);
}

.drafts-row:hover {
  background: var(--paper-3);
}

.drafts-item {
  display: flex;
  flex-direction: column;
  gap: 3px;
  flex: 1;
  min-width: 0;
  padding: 9px 10px;
  border-radius: var(--r-md);
  cursor: pointer;
}

.drafts-item:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: -2px;
}

.drafts-meta {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  letter-spacing: 0.02em;
}

.drafts-room {
  min-width: 0;
  overflow: hidden;
  color: var(--rust);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.drafts-time {
  flex: none;
  margin-left: auto;
  color: var(--faint);
  white-space: nowrap;
}

.drafts-summary {
  display: -webkit-box;
  overflow: hidden;
  color: var(--text);
  font-size: var(--fs-sub);
  line-height: 1.5;
  overflow-wrap: anywhere;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.drafts-delete {
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

.drafts-row:hover .drafts-delete,
.drafts-delete:focus-visible {
  opacity: 1;
}

.drafts-delete:hover:not(:disabled) {
  color: var(--danger);
}

.drafts-delete:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: -2px;
}

.drafts-delete:disabled {
  cursor: default;
  opacity: 0.4;
}

@media (hover: none) {
  /* Touch has no hover: the delete control stays visible. */
  .drafts-delete {
    opacity: 1;
  }
}

@media (max-width: 480px) {
  .drafts-overlay {
    padding: 12px;
  }

  .drafts-panel {
    max-height: calc(100vh - 24px);
  }

  .drafts-head {
    padding: 14px 14px 10px;
  }
}
</style>
