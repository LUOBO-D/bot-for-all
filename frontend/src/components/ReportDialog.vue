<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import http, { errorMessage } from '../api/http';
import type { Message } from '../types';
import { formatTime, plainPreview } from '../utils/format';
import Icon from './Icon.vue';

/** Mirrors `message_reports.reason` and the route's validation. */
const REASON_MAX = 500;

const props = defineProps<{
  modelValue: boolean;
  message: Message;
}>();
const emit = defineEmits<{
  'update:modelValue': [value: boolean];
}>();

const field = ref<HTMLTextAreaElement | null>(null);
const reason = ref('');
const error = ref('');
const submitting = ref(false);

const summary = computed(() => plainPreview(props.message.content).slice(0, 160));
const trimmed = computed(() => reason.value.trim());
const canSubmit = computed(
  () => !submitting.value && trimmed.value.length > 0 && trimmed.value.length <= REASON_MAX,
);

function close() {
  if (submitting.value) {
    return;
  }
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

async function submit() {
  if (!canSubmit.value) {
    return;
  }
  submitting.value = true;
  error.value = '';
  try {
    await http.post(
      `/rooms/${props.message.roomId}/messages/${props.message.seq}/report`,
      { reason: trimmed.value },
    );
    ElMessage.success('举报已提交，管理员会尽快处理');
    emit('update:modelValue', false);
  } catch (requestError) {
    const message = errorMessage(requestError);
    error.value = message;
    ElMessage.error(message);
  } finally {
    submitting.value = false;
  }
}

// Every open starts blank: a reopened dialog must never submit the previous
// message's reason (or show its stale failure).
watch(
  () => props.modelValue,
  async (open) => {
    if (!open) {
      submitting.value = false;
      return;
    }
    reason.value = '';
    error.value = '';
    await nextTick();
    field.value?.focus();
  },
  { immediate: true },
);
</script>

<template>
  <div v-if="modelValue" class="report-overlay" @click.self="close">
    <div
      class="report-panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="report-title"
      data-testid="report-dialog"
      tabindex="-1"
      @keydown="onKeydown"
    >
      <header class="report-head">
        <div class="report-head-text">
          <h2 id="report-title">举报消息</h2>
          <p>提交后会进入管理员审核队列，请说明具体原因。</p>
        </div>
        <button
          class="report-close"
          type="button"
          aria-label="关闭举报"
          :disabled="submitting"
          @click="close"
        >
          <Icon name="close" :size="16" />
        </button>
      </header>

      <div class="report-quote">
        <span class="report-quote-meta">
          {{ message.senderName }} · {{ formatTime(message.createdAt) }}
        </span>
        <span class="report-quote-text">{{ summary || '（空消息）' }}</span>
      </div>

      <label class="field report-field">
        <span>举报原因</span>
        <textarea
          ref="field"
          v-model="reason"
          data-testid="report-reason"
          rows="4"
          :maxlength="REASON_MAX"
          placeholder="例如：广告刷屏、辱骂攻击、违法或不当内容…"
          @keydown.ctrl.enter.prevent="submit"
          @keydown.meta.enter.prevent="submit"
        ></textarea>
      </label>
      <div class="report-count mono">{{ reason.length }} / {{ REASON_MAX }}</div>

      <p v-if="error" class="report-error" data-testid="report-error">{{ error }}</p>

      <footer class="report-actions">
        <button class="btn ghost" type="button" :disabled="submitting" @click="close">
          取消
        </button>
        <button
          class="btn primary"
          type="button"
          data-testid="report-submit"
          :disabled="!canSubmit"
          :aria-busy="submitting"
          @click="submit"
        >
          {{ submitting ? '提交中…' : '提交举报' }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.report-overlay {
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

.report-panel {
  width: min(440px, 100%);
  display: flex;
  flex-direction: column;
  padding: 18px 18px 20px;
  background: var(--glass-pop, rgba(16, 21, 42, 0.92));
  -webkit-backdrop-filter: blur(24px) saturate(1.5);
  backdrop-filter: blur(24px) saturate(1.5);
  border: 1px solid var(--line-strong);
  border-radius: var(--r-lg, 8px);
  box-shadow:
    inset 0 1px 0 var(--glass-hi, rgba(236, 233, 226, 0.1)),
    var(--shadow-dialog, 0 24px 64px rgba(0, 0, 0, 0.5));
  outline: none;
}

.report-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.report-head-text h2 {
  margin: 0;
  color: var(--text);
  font-size: var(--fs-h);
  font-weight: 600;
  line-height: 1.3;
}

.report-head-text p {
  margin: 4px 0 0;
  color: var(--faint);
  font-size: var(--fs-sub);
}

.report-close {
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

.report-close:hover:not(:disabled) {
  background: var(--paper-3);
  color: var(--text);
}

.report-close:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.report-close:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: 2px;
}

.report-quote {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin: 14px 0 12px;
  padding: 8px 10px;
  border-left: 2px solid var(--rust);
  border-radius: 0 var(--r-sm) var(--r-sm) 0;
  background: var(--paper-3);
}

.report-quote-meta {
  color: var(--faint);
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  letter-spacing: 0.04em;
}

.report-quote-text {
  display: -webkit-box;
  overflow: hidden;
  color: var(--muted);
  font-size: var(--fs-sub);
  line-height: 1.5;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.report-field {
  margin: 0;
}

.report-field textarea {
  min-height: 96px;
  resize: vertical;
}

.report-count {
  margin-top: 2px;
  color: var(--faint);
  text-align: right;
}

.report-error {
  margin: 8px 0 0;
  color: var(--danger);
  font-size: var(--fs-sub);
  line-height: 1.5;
}

.report-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 14px;
}

@media (max-width: 480px) {
  .report-panel {
    padding: 16px;
  }
}
</style>
