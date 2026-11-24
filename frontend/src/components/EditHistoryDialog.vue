<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Icon from './Icon.vue';

/** One stored revision: the text this message held before an edit landed. */
interface EditHistoryItem {
  oldContent: string;
  editedBy: number;
  editorName: string;
  editedAt: string;
}

const props = defineProps<{
  modelValue: boolean;
  senderName?: string;
  current: string;
  edits: EditHistoryItem[];
  loading?: boolean;
  error?: string;
}>();
const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  retry: [];
}>();

const panel = ref<HTMLElement | null>(null);

function close() {
  emit('update:modelValue', false);
}

function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape') {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  close();
}

// Focus may still be on the message row right after opening; Esc must close
// the dialog regardless of which element currently owns focus.
function onDocumentKeydown(event: KeyboardEvent) {
  if (!props.modelValue || event.key !== 'Escape') {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  close();
}

onMounted(() => document.addEventListener('keydown', onDocumentKeydown));
onBeforeUnmount(() => document.removeEventListener('keydown', onDocumentKeydown));

// Exact stamps: an edit trail is read across days, so the relative wording the
// transcript uses would lose the ordering it is meant to show.
function stamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString([], {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

watch(
  () => props.modelValue,
  async (open) => {
    if (!open) {
      return;
    }
    await nextTick();
    panel.value?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
  },
);
</script>

<template>
  <div v-if="modelValue" class="history-overlay" @click.self="close">
    <div
      ref="panel"
      class="history-panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="edit-history-title"
      data-testid="edit-history"
      tabindex="-1"
      @keydown="onKeydown"
    >
      <header class="history-head">
        <div class="history-head-text">
          <h2 id="edit-history-title">编辑历史</h2>
          <p v-if="senderName">{{ senderName }} 的消息 · 按时间先后排列</p>
          <p v-else>按时间先后排列</p>
        </div>
        <button
          class="history-close"
          type="button"
          aria-label="关闭编辑历史"
          data-autofocus
          @click="close"
        >
          <Icon name="close" :size="16" />
        </button>
      </header>

      <div class="history-body">
        <div v-if="loading" class="history-note">加载编辑历史…</div>
        <div v-else-if="error" class="history-error">
          <span>{{ error }}</span>
          <button class="btn ghost small" type="button" @click="emit('retry')">
            重试
          </button>
        </div>
        <template v-else>
          <section class="history-section">
            <h3 class="history-label">当前内容</h3>
            <p class="history-current">{{ current }}</p>
          </section>

          <section class="history-section">
            <h3 class="history-label">历史版本 · {{ edits.length }}</h3>
            <p v-if="!edits.length" class="history-note">没有历史版本</p>
            <ol v-else class="history-list">
              <li
                v-for="(edit, index) in edits"
                :key="`${edit.editedAt}-${index}`"
                class="history-item"
                data-testid="edit-history-item"
              >
                <div class="history-item-head">
                  <span class="history-item-editor">{{ edit.editorName }}</span>
                  <span class="history-item-time">{{ stamp(edit.editedAt) }}</span>
                </div>
                <p class="history-item-text">{{ edit.oldContent }}</p>
              </li>
            </ol>
          </section>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.history-overlay {
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

.history-panel {
  width: min(480px, 100%);
  max-height: min(620px, calc(100vh - 48px));
  display: flex;
  flex-direction: column;
  padding: 18px 18px 20px;
  background: var(--glass-pop, rgba(16, 21, 42, 0.92));
  -webkit-backdrop-filter: blur(24px) saturate(1.5);
  backdrop-filter: blur(24px) saturate(1.5);
  border: 1px solid var(--line-strong);
  border-radius: var(--r-lg, 8px);
  box-shadow:
    inset 0 1px 0 rgba(236, 233, 226, 0.12),
    var(--shadow-dialog, 0 24px 64px rgba(0, 0, 0, 0.5));
  outline: none;
}

.history-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.history-head-text h2 {
  margin: 0;
  color: var(--text);
  font-size: var(--fs-h);
  font-weight: 600;
  line-height: 1.3;
}

.history-head-text p {
  margin: 4px 0 0;
  color: var(--faint);
  font-size: var(--fs-sub);
}

.history-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}

.history-close:hover {
  background: var(--paper-3);
  color: var(--text);
}

.history-close:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: 2px;
}

.history-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin-top: 14px;
  min-height: 0;
  overflow-y: auto;
}

.history-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.history-label {
  margin: 0;
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.history-current {
  margin: 0;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-left: 2px solid var(--rust);
  border-radius: 0 var(--r-sm) var(--r-sm) 0;
  background: var(--paper-2);
  color: var(--text);
  font-size: var(--fs-body);
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.history-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.history-item {
  padding: 9px 11px;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: var(--paper-2);
}

.history-item-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 5px;
}

.history-item-editor {
  overflow: hidden;
  color: var(--text);
  font-size: var(--fs-sub);
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history-item-time {
  flex: none;
  color: var(--faint);
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  letter-spacing: 0.02em;
}

.history-item-text {
  margin: 0;
  color: var(--muted);
  font-size: var(--fs-sub);
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.history-note {
  padding: 18px 8px;
  color: var(--faint);
  font-size: var(--fs-sub);
  text-align: center;
}

.history-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 18px 8px;
  color: var(--rust-ink);
  font-size: var(--fs-sub);
  text-align: center;
}
</style>
