<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import http, { errorMessage } from '../api/http';
import type { ScheduledMessage } from '../types';
import Icon from './Icon.vue';

/** Mirrors the route's `content` limit. */
const CONTENT_MAX = 4000;
/** The server rejects a time less than a second ahead of its clock. */
const MIN_LEAD_MS = 1000;
/** Anything further out than this is rejected as well. */
const MAX_LEAD_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_LEAD_MS = 5 * 60 * 1000;

const props = defineProps<{
  modelValue: boolean;
  roomId: number;
  initialContent?: string;
  /** Ack handed over by the composer: `true` clears the draft it sent us. */
  done?: (ok: boolean) => void;
}>();
const emit = defineEmits<{
  'update:modelValue': [value: boolean];
}>();

const field = ref<HTMLTextAreaElement | null>(null);
const content = ref('');
const sendAt = ref('');
const minSendAt = ref('');
const error = ref('');
const submitting = ref(false);
const items = ref<ScheduledMessage[]>([]);
const listLoading = ref(false);
const listError = ref('');
const cancellingId = ref<number | null>(null);
// Non-null while the form edits an existing queue row instead of creating one.
const editingId = ref<number | null>(null);
// The row's exact ISO time; `datetime-local` drops seconds, so an untouched
// field must send this value back instead of the minute-truncated one.
const originalSendAt = ref<string | null>(null);
// A room switch or a second open must never let an older list response win.
let listRequestId = 0;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

// `datetime-local` speaks local wall-clock time, so both directions go
// through the browser's zone: the picker shows local, the API gets UTC ISO.
function toLocalInput(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

function nextMinute(): string {
  return toLocalInput(new Date(Date.now() + 60_000));
}

function defaultSendAt(): string {
  const date = new Date(Date.now() + DEFAULT_LEAD_MS);
  date.setSeconds(0, 0);
  return toLocalInput(date);
}

function formatSendAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

const trimmed = computed(() => content.value.trim());
const canSubmit = computed(
  () => !submitting.value && trimmed.value.length > 0 && sendAt.value.length > 0,
);

function refreshMin() {
  const original = originalSendAt.value;
  minSendAt.value = original ? toLocalInput(new Date(original)) : nextMinute();
}

/** Untouched edit keeps the row's seconds; a changed field uses its minute value. */
function effectiveSendAt(): Date {
  const original = originalSendAt.value;
  if (original && sendAt.value === toLocalInput(new Date(original))) {
    return new Date(original);
  }
  return new Date(sendAt.value);
}

function validate(): string {
  if (!trimmed.value) {
    return '请输入要定时发送的内容';
  }
  if (trimmed.value.length > CONTENT_MAX) {
    return `内容不能超过 ${CONTENT_MAX} 个字符`;
  }
  const when = effectiveSendAt();
  if (!sendAt.value || Number.isNaN(when.getTime())) {
    return '请选择发送时间';
  }
  const lead = when.getTime() - Date.now();
  if (lead < MIN_LEAD_MS) {
    return '发送时间需要晚于当前时间';
  }
  if (lead > MAX_LEAD_MS) {
    return '发送时间不能超过 30 天';
  }
  return '';
}

function close() {
  if (submitting.value) {
    return;
  }
  emit('update:modelValue', false);
}

/** Leaves edit mode and restores the composer snapshot the dialog opened with. */
function resetForm() {
  editingId.value = null;
  originalSendAt.value = null;
  content.value = props.initialContent ?? '';
  sendAt.value = defaultSendAt();
  error.value = '';
  refreshMin();
}

function cancelEdit() {
  if (submitting.value) {
    return;
  }
  resetForm();
  void nextTick(() => field.value?.focus());
}

function startEdit(item: ScheduledMessage) {
  if (submitting.value || cancellingId.value !== null) {
    return;
  }
  editingId.value = item.id;
  originalSendAt.value = item.sendAt;
  content.value = item.content;
  sendAt.value = toLocalInput(new Date(item.sendAt));
  error.value = '';
  refreshMin();
  void nextTick(() => field.value?.focus());
}

function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape') {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  close();
}

async function loadList() {
  const requestId = (listRequestId += 1);
  listLoading.value = true;
  listError.value = '';
  try {
    const { data } = await http.get<{ messages: ScheduledMessage[] }>(
      `/rooms/${props.roomId}/messages/scheduled`,
    );
    if (requestId !== listRequestId) {
      return;
    }
    items.value = Array.isArray(data.messages) ? data.messages : [];
  } catch (requestError) {
    if (requestId !== listRequestId) {
      return;
    }
    listError.value = errorMessage(requestError);
  } finally {
    if (requestId === listRequestId) {
      listLoading.value = false;
    }
  }
}

async function submit() {
  if (submitting.value) {
    return;
  }
  const problem = validate();
  error.value = problem;
  if (problem) {
    return;
  }
  const when = effectiveSendAt();
  const editing = editingId.value;
  submitting.value = true;
  try {
    if (editing !== null) {
      const { data } = await http.patch<{ scheduled: ScheduledMessage }>(
        `/rooms/${props.roomId}/messages/scheduled/${editing}`,
        { content: trimmed.value, sendAt: when.toISOString() },
      );
      ElMessage.success(
        `已更新定时消息，将于 ${formatSendAt(data.scheduled?.sendAt ?? when.toISOString())} 发送`,
      );
      // Editing never touches the composer draft: only a create hands it back.
      resetForm();
      await loadList();
      await nextTick();
      field.value?.focus();
      return;
    }
    const { data } = await http.post<{ scheduled: ScheduledMessage }>(
      `/rooms/${props.roomId}/messages/schedule`,
      { content: trimmed.value, sendAt: when.toISOString() },
    );
    ElMessage.success(
      `已安排在 ${formatSendAt(data.scheduled?.sendAt ?? when.toISOString())} 发送`,
    );
    // The queue row exists now, so the composer may drop the draft it gave us.
    props.done?.(true);
    content.value = '';
    sendAt.value = defaultSendAt();
    refreshMin();
    await loadList();
    await nextTick();
    field.value?.focus();
  } catch (requestError) {
    const message = errorMessage(requestError);
    error.value = message;
    if (editing === null) {
      props.done?.(false);
    }
    ElMessage.error(message);
  } finally {
    submitting.value = false;
  }
}

async function cancel(item: ScheduledMessage) {
  if (cancellingId.value !== null) {
    return;
  }
  cancellingId.value = item.id;
  try {
    await http.delete(`/rooms/${props.roomId}/messages/scheduled/${item.id}`);
    ElMessage.success('已取消定时消息');
  } catch (requestError) {
    // `NOT_PENDING` means the worker already sent it, so the list is stale
    // either way; report the reason and refresh below.
    ElMessage.error(errorMessage(requestError));
  } finally {
    cancellingId.value = null;
    if (editingId.value === item.id) {
      resetForm();
    }
    await loadList();
  }
}

// Every open starts from the composer's current text and a fresh window;
// a closed dialog drops the in-flight list so a late response cannot leak
// into the next room's panel.
watch(
  () => props.modelValue,
  async (open) => {
    if (!open) {
      submitting.value = false;
      cancellingId.value = null;
      editingId.value = null;
      listRequestId += 1;
      return;
    }
    resetForm();
    await nextTick();
    field.value?.focus();
    void loadList();
  },
  { immediate: true },
);

// Switching rooms while the panel is open must not leave an edit pointing at
// the previous room's queue row.
watch(
  () => props.roomId,
  () => {
    if (!props.modelValue) {
      return;
    }
    resetForm();
    void loadList();
  },
);
</script>

<template>
  <div v-if="modelValue" class="schedule-overlay" @click.self="close">
    <div
      class="schedule-panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="schedule-title"
      data-testid="schedule-dialog"
      tabindex="-1"
      @keydown="onKeydown"
    >
      <header class="schedule-head">
        <div class="schedule-head-text">
          <h2 id="schedule-title">定时发送</h2>
          <p>到点后以你的身份发出，可随时取消。</p>
        </div>
        <button
          class="schedule-close"
          type="button"
          aria-label="关闭定时发送"
          :disabled="submitting"
          @click="close"
        >
          <Icon name="close" :size="16" />
        </button>
      </header>

      <label class="field schedule-field">
        <span>消息内容</span>
        <textarea
          ref="field"
          v-model="content"
          data-testid="schedule-content"
          rows="4"
          :maxlength="CONTENT_MAX"
          placeholder="要定时发送的消息…"
          @keydown.ctrl.enter.prevent="submit"
          @keydown.meta.enter.prevent="submit"
        ></textarea>
      </label>
      <div class="schedule-count mono">{{ content.length }} / {{ CONTENT_MAX }}</div>

      <label class="field schedule-time-field">
        <span>发送时间</span>
        <input
          v-model="sendAt"
          data-testid="schedule-time"
          type="datetime-local"
          :min="minSendAt"
          @focus="refreshMin"
        />
      </label>

      <p v-if="error" class="schedule-error" data-testid="schedule-error">{{ error }}</p>

      <footer class="schedule-actions">
        <button
          v-if="editingId !== null"
          class="btn ghost"
          type="button"
          data-testid="schedule-edit-cancel"
          :disabled="submitting"
          @click="cancelEdit"
        >
          取消编辑
        </button>
        <button class="btn ghost" type="button" :disabled="submitting" @click="close">
          取消
        </button>
        <button
          class="btn primary"
          type="button"
          data-testid="schedule-submit"
          :disabled="!canSubmit"
          :aria-busy="submitting"
          @click="submit"
        >
          {{ submitting ? (editingId !== null ? '保存中…' : '发布中…') : editingId !== null ? '保存修改' : '定时发送' }}
        </button>
      </footer>

      <section class="schedule-list" aria-label="待发送消息">
        <header class="schedule-list-head">
          <span>待发送</span>
          <span v-if="items.length" class="mono">{{ items.length }}</span>
        </header>
        <div v-if="listLoading && !items.length" class="schedule-empty">加载中…</div>
        <div v-else-if="listError" class="schedule-empty schedule-list-error">
          {{ listError }}
          <button class="schedule-retry" type="button" @click="loadList">重试</button>
        </div>
        <div v-else-if="!items.length" class="schedule-empty">还没有待发送的消息</div>
        <ul v-else class="schedule-items">
          <li
            v-for="item in items"
            :key="item.id"
            class="schedule-item"
            data-testid="scheduled-item"
          >
            <div class="schedule-item-main">
              <span class="schedule-item-time">{{ formatSendAt(item.sendAt) }}</span>
              <span class="schedule-item-text">{{ item.content }}</span>
            </div>
            <div class="schedule-item-actions">
              <button
                class="schedule-edit"
                type="button"
                data-testid="scheduled-edit"
                :disabled="submitting || cancellingId !== null"
                @click="startEdit(item)"
              >
                编辑
              </button>
              <button
                class="schedule-cancel"
                type="button"
                data-testid="scheduled-cancel"
                :disabled="cancellingId !== null"
                :aria-busy="cancellingId === item.id"
                @click="cancel(item)"
              >
                {{ cancellingId === item.id ? '取消中…' : '取消' }}
              </button>
            </div>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>

<style scoped>
.schedule-overlay {
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

.schedule-panel {
  width: min(460px, 100%);
  max-height: min(640px, calc(100vh - 48px));
  display: flex;
  flex-direction: column;
  padding: 18px 18px 20px;
  background: var(--glass-pop, rgba(251, 250, 245, 0.88));
  -webkit-backdrop-filter: blur(24px) saturate(1.5);
  backdrop-filter: blur(24px) saturate(1.5);
  border: 1px solid var(--line-strong);
  border-radius: var(--r-lg, 8px);
  box-shadow:
    inset 0 1px 0 var(--glass-hi, rgba(255, 255, 255, 0.6)),
    var(--shadow-dialog, 0 24px 64px rgba(21, 23, 15, 0.18));
  outline: none;
}

.schedule-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.schedule-head-text h2 {
  margin: 0;
  color: var(--text);
  font-size: var(--fs-h);
  font-weight: 600;
  line-height: 1.3;
}

.schedule-head-text p {
  margin: 4px 0 0;
  color: var(--faint);
  font-size: var(--fs-sub);
}

.schedule-close {
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

.schedule-close:hover:not(:disabled) {
  background: var(--paper-3);
  color: var(--text);
}

.schedule-close:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.schedule-close:focus-visible,
.schedule-cancel:focus-visible,
.schedule-edit:focus-visible,
.schedule-retry:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: 2px;
}

.schedule-field {
  margin: 14px 0 0;
}

.schedule-field textarea {
  min-height: 92px;
  resize: vertical;
}

.schedule-count {
  margin-top: 2px;
  color: var(--faint);
  text-align: right;
}

.schedule-time-field {
  margin: 10px 0 0;
}

.schedule-error {
  margin: 8px 0 0;
  color: var(--danger);
  font-size: var(--fs-sub);
  line-height: 1.5;
}

.schedule-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 14px;
}

.schedule-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-height: 0;
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid var(--line);
  overflow-y: auto;
}

.schedule-list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--faint);
  font-size: var(--fs-sub);
  font-weight: 600;
}

.schedule-empty {
  padding: 16px 8px;
  color: var(--faint);
  font-size: var(--fs-sub);
  text-align: center;
}

.schedule-list-error {
  color: var(--danger);
}

.schedule-retry {
  margin-left: 8px;
  border: none;
  background: transparent;
  color: var(--ink);
  font-size: var(--fs-sub);
  text-decoration: underline;
  cursor: pointer;
}

.schedule-items {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.schedule-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: var(--paper-2);
}

.schedule-item-main {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}

.schedule-item-time {
  color: var(--faint);
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  letter-spacing: 0.04em;
}

.schedule-item-text {
  display: -webkit-box;
  overflow: hidden;
  color: var(--text);
  font-size: var(--fs-sub);
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
}

.schedule-item-actions {
  display: flex;
  flex: none;
  gap: 4px;
}

.schedule-edit,
.schedule-cancel {
  flex: none;
  height: 26px;
  padding: 0 8px;
  border: 1px solid var(--line-strong);
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--muted);
  font-size: var(--fs-mono);
  cursor: pointer;
}

.schedule-edit:hover:not(:disabled) {
  border-color: var(--ink);
  color: var(--ink);
}

.schedule-cancel:hover:not(:disabled) {
  border-color: var(--danger);
  color: var(--danger);
}

.schedule-edit:disabled,
.schedule-cancel:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

@media (max-width: 480px) {
  .schedule-panel {
    padding: 16px;
  }
}
</style>
