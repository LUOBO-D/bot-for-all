<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { errorMessage } from '../api/http';
import { useChatStore } from '../stores/chat';
import Icon from './Icon.vue';

const QUESTION_MAX = 300;
const OPTION_MAX = 100;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 10;
const CLOSES_MINUTES_MAX = 10080;

const props = defineProps<{
  modelValue: boolean;
  roomId: number;
}>();
const emit = defineEmits<{
  'update:modelValue': [value: boolean];
}>();

const chat = useChatStore();
const question = ref('');
const options = ref<string[]>(['', '']);
const multiple = ref(false);
// Anonymous polls hide who picked what: the server strips `userIds` from the
// DTO, so only the viewer's own ballot is ever visible in the card.
const anonymous = ref(false);
// A number input bound with v-model.number cannot tell "" from 0, and 0 is
// outside the range; keeping the raw string lets "empty" mean "no deadline".
const closesText = ref('');
const submitting = ref(false);
const submitError = ref('');
const questionField = ref<HTMLInputElement | null>(null);
const panel = ref<HTMLElement | null>(null);

const trimmedQuestion = computed(() => question.value.trim());
const filledOptions = computed(() =>
  options.value.map((option) => option.trim()).filter((option) => option.length > 0),
);
const duplicateLabel = computed(() => {
  const seen = new Set<string>();
  for (const label of filledOptions.value) {
    const key = label.toLowerCase();
    if (seen.has(key)) {
      return label;
    }
    seen.add(key);
  }
  return '';
});
const closesMinutes = computed<number | null>(() => {
  const raw = closesText.value.trim();
  if (!raw) {
    return null;
  }
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= CLOSES_MINUTES_MAX
    ? value
    : null;
});
const closesInvalid = computed(
  () => closesText.value.trim().length > 0 && closesMinutes.value === null,
);
const validationMessage = computed(() => {
  if (trimmedQuestion.value.length === 0) {
    return '';
  }
  if (duplicateLabel.value) {
    return `选项「${duplicateLabel.value}」重复了`;
  }
  if (filledOptions.value.some((label) => label.length > OPTION_MAX)) {
    return `每个选项最多 ${OPTION_MAX} 字`;
  }
  if (closesInvalid.value) {
    return `截止时间需为 1–${CLOSES_MINUTES_MAX} 分钟`;
  }
  return '';
});
const canSubmit = computed(
  () =>
    !submitting.value &&
    props.roomId > 0 &&
    trimmedQuestion.value.length > 0 &&
    trimmedQuestion.value.length <= QUESTION_MAX &&
    filledOptions.value.length >= MIN_OPTIONS &&
    filledOptions.value.length <= MAX_OPTIONS &&
    !duplicateLabel.value &&
    !closesInvalid.value,
);

function resetForm() {
  question.value = '';
  options.value = ['', ''];
  multiple.value = false;
  anonymous.value = false;
  closesText.value = '';
  submitError.value = '';
}

function close() {
  if (submitting.value) {
    return;
  }
  emit('update:modelValue', false);
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    close();
    return;
  }
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    void submit();
  }
}

function addOption() {
  if (options.value.length >= MAX_OPTIONS) {
    return;
  }
  options.value = [...options.value, ''];
  void nextTick(() => {
    const inputs = panel.value?.querySelectorAll<HTMLInputElement>(
      '[data-testid^="poll-option-"]',
    );
    inputs?.[inputs.length - 1]?.focus();
  });
}

function removeOption(index: number) {
  if (options.value.length <= MIN_OPTIONS) {
    return;
  }
  options.value = options.value.filter((_, position) => position !== index);
}

async function submit() {
  if (!canSubmit.value) {
    return;
  }
  submitting.value = true;
  submitError.value = '';
  try {
    await chat.createPoll(props.roomId, {
      question: trimmedQuestion.value,
      options: filledOptions.value,
      multiple: multiple.value,
      anonymous: anonymous.value,
      ...(closesMinutes.value != null
        ? { closesInMinutes: closesMinutes.value }
        : {}),
    });
    ElMessage.success('投票已发起');
    emit('update:modelValue', false);
  } catch (error) {
    const text = errorMessage(error);
    submitError.value = text;
    ElMessage.error(text);
  } finally {
    submitting.value = false;
  }
}

// Every open starts blank: a reopened dialog must never submit the previous
// poll (or show its stale failure).
watch(
  () => props.modelValue,
  async (open) => {
    if (!open) {
      submitting.value = false;
      return;
    }
    resetForm();
    await nextTick();
    questionField.value?.focus();
  },
  { immediate: true },
);
</script>

<template>
  <div v-if="modelValue" class="poll-overlay" @click.self="close">
    <div
      ref="panel"
      class="poll-panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="poll-dialog-title"
      data-testid="poll-dialog"
      tabindex="-1"
      @keydown="onKeydown"
    >
      <header class="poll-head">
        <div class="poll-head-text">
          <h2 id="poll-dialog-title">发起投票</h2>
          <p>问题和选项会作为一条消息发送到房间。</p>
        </div>
        <button
          class="poll-close"
          type="button"
          aria-label="关闭投票"
          :disabled="submitting"
          @click="close"
        >
          <Icon name="close" :size="16" />
        </button>
      </header>

      <div class="poll-body">
        <label class="field">
          <span>问题</span>
          <input
            ref="questionField"
            v-model="question"
            data-testid="poll-question"
            type="text"
            maxlength="300"
            placeholder="想问大家什么？"
            autocomplete="off"
          />
          <span class="poll-count mono">{{ question.length }} / {{ QUESTION_MAX }}</span>
        </label>

        <div class="poll-options-head">
          <span class="poll-label">选项</span>
          <span class="poll-hint mono">
            {{ filledOptions.length }} / {{ MAX_OPTIONS }} · 至少 {{ MIN_OPTIONS }} 项
          </span>
        </div>
        <div class="poll-option-rows">
          <div
            v-for="(option, index) in options"
            :key="index"
            class="poll-option-row"
          >
            <input
              v-model="options[index]"
              :data-testid="`poll-option-${index}`"
              type="text"
              maxlength="100"
              :placeholder="`选项 ${index + 1}`"
              :aria-label="`选项 ${index + 1}`"
              autocomplete="off"
            />
            <button
              v-if="options.length > MIN_OPTIONS"
              class="poll-option-remove"
              type="button"
              :aria-label="`删除选项 ${index + 1}`"
              @click="removeOption(index)"
            >
              <Icon name="close" :size="12" />
            </button>
          </div>
        </div>
        <button
          class="btn ghost small poll-add"
          type="button"
          data-testid="poll-add-option"
          :disabled="options.length >= MAX_OPTIONS || submitting"
          @click="addOption"
        >
          <Icon name="plus" :size="12" />
          添加选项
        </button>

        <div class="poll-settings">
          <label class="poll-check">
            <input v-model="multiple" type="checkbox" data-testid="poll-multiple" />
            <span>允许多选</span>
          </label>
          <label class="poll-check">
            <input v-model="anonymous" type="checkbox" data-testid="poll-anonymous" />
            <span>匿名投票</span>
          </label>
          <label class="field poll-deadline">
            <span>截止时间（分钟，可选）</span>
            <input
              v-model="closesText"
              data-testid="poll-closes"
              type="number"
              inputmode="numeric"
              min="1"
              :max="CLOSES_MINUTES_MAX"
              step="1"
              placeholder="不填则一直开放"
            />
          </label>
        </div>

        <p v-if="validationMessage" class="poll-error" data-testid="poll-error">
          {{ validationMessage }}
        </p>
        <p v-else-if="submitError" class="poll-error">{{ submitError }}</p>
      </div>

      <footer class="poll-actions">
        <span class="poll-keyhint mono">Ctrl / ⌘ + Enter 提交</span>
        <button class="btn ghost" type="button" :disabled="submitting" @click="close">
          取消
        </button>
        <button
          class="btn primary"
          type="button"
          data-testid="poll-submit"
          :disabled="!canSubmit"
          :aria-busy="submitting"
          @click="submit"
        >
          {{ submitting ? '发起中…' : '发起投票' }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.poll-overlay {
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

.poll-panel {
  display: flex;
  flex-direction: column;
  width: min(460px, 100%);
  max-height: min(640px, calc(100vh - 48px));
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

.poll-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.poll-head-text h2 {
  margin: 0;
  color: var(--text);
  font-size: var(--fs-h);
  font-weight: 600;
  line-height: 1.3;
}

.poll-head-text p {
  margin: 4px 0 0;
  color: var(--faint);
  font-size: var(--fs-sub);
}

.poll-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 28px;
  height: 28px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}

.poll-close:hover:not(:disabled) {
  background: var(--paper-3);
  color: var(--text);
}

.poll-close:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.poll-close:focus-visible,
.poll-option-remove:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: 2px;
}

.poll-body {
  min-height: 0;
  margin-top: 14px;
  overflow-y: auto;
}

.poll-body .field {
  margin-bottom: 4px;
}

.poll-count {
  display: block;
  margin-top: 3px;
  color: var(--faint);
  font-weight: 400;
  text-align: right;
}

.poll-options-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin: 10px 0 4px;
}

.poll-label {
  color: var(--text);
  font-size: 13px;
  font-weight: 600;
}

.poll-hint {
  color: var(--faint);
}

.poll-option-rows {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.poll-option-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.poll-option-row input {
  flex: 1;
  min-width: 0;
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--line-strong);
  border-radius: var(--r-md);
  background: var(--paper);
  color: var(--text);
  font-size: 13px;
  outline: none;
  transition: border-color 0.12s ease-out, background 0.12s ease-out;
}

.poll-option-row input:focus {
  border-color: var(--ink);
  background: var(--paper-2);
}

.poll-option-row input::placeholder {
  color: var(--faint);
}

.poll-option-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 24px;
  height: 24px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--faint);
  cursor: pointer;
}

.poll-option-remove:hover {
  border-color: var(--danger);
  color: var(--danger);
}

.poll-add {
  margin-top: 8px;
}

.poll-settings {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 12px;
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--line);
}

.poll-check {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding-bottom: 8px;
  color: var(--text);
  font-size: 13px;
  cursor: pointer;
}

.poll-check input {
  width: 15px;
  height: 15px;
  accent-color: var(--ink);
  cursor: pointer;
}

.poll-deadline {
  flex: 1;
  min-width: 160px;
  margin-bottom: 0;
}

.poll-error {
  margin: 10px 0 0;
  color: var(--danger);
  font-size: var(--fs-sub);
}

.poll-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
}

.poll-keyhint {
  flex: 1;
  color: var(--faint);
}

@media (max-width: 520px) {
  .poll-keyhint {
    display: none;
  }

  .poll-actions {
    justify-content: flex-end;
  }
}
</style>
