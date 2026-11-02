<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import Icon from './Icon.vue';

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();

interface ShortcutItem {
  label: string;
  combos: string[][];
}

interface ShortcutGroup {
  title: string;
  items: ShortcutItem[];
}

const panel = ref<HTMLElement | null>(null);
let restoreFocus: HTMLElement | null = null;

const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
const modKey = isMac ? '⌘' : 'Ctrl';

const groups: ShortcutGroup[] = [
  {
    title: '全局',
    items: [
      { label: '打开命令面板', combos: [[modKey, 'K']] },
      { label: '打开快捷键帮助', combos: [['?'], [modKey, '/']] },
      { label: '切换到上一个房间', combos: [['Alt', '↑']] },
      { label: '切换到下一个房间', combos: [['Alt', '↓']] },
      { label: '关闭弹窗 / 取消', combos: [['Esc']] },
    ],
  },
  {
    title: '消息',
    items: [{ label: '标记当前房间为已读', combos: [['Shift', 'Esc']] }],
  },
  {
    title: '输入框',
    items: [
      { label: '发送消息', combos: [['Enter']] },
      { label: '换行', combos: [['Shift', 'Enter']] },
      { label: '编辑上一条消息（输入框为空时）', combos: [['↑']] },
      { label: '取消回复 / 取消编辑', combos: [['Esc']] },
    ],
  },
];

function close() {
  emit('update:modelValue', false);
}

// While the help sheet is modal, Tab must not walk into the page behind it.
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

watch(
  () => props.modelValue,
  async (open) => {
    if (open) {
      restoreFocus =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      await nextTick();
      const target =
        panel.value?.querySelector<HTMLElement>('[data-autofocus]') ?? panel.value;
      target?.focus();
      return;
    }
    const previous = restoreFocus;
    restoreFocus = null;
    if (previous?.isConnected) {
      previous.focus();
    }
  },
);
</script>

<template>
  <div v-if="modelValue" class="shortcuts-overlay" @click.self="close">
    <div
      ref="panel"
      class="shortcuts-panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="shortcuts-title"
      tabindex="-1"
      @keydown="onKeydown"
    >
      <header class="shortcuts-head">
        <div>
          <h2 id="shortcuts-title">键盘快捷键</h2>
          <p>按 Esc 关闭</p>
        </div>
        <button
          class="shortcuts-close"
          type="button"
          aria-label="关闭快捷键帮助"
          data-autofocus
          @click="close"
        >
          <Icon name="close" :size="16" />
        </button>
      </header>

      <div class="shortcuts-groups">
        <section v-for="group in groups" :key="group.title" class="shortcuts-group">
          <h3>{{ group.title }}</h3>
          <dl class="shortcuts-list">
            <div v-for="item in group.items" :key="item.label" class="shortcuts-row">
              <dt>{{ item.label }}</dt>
              <dd>
                <template v-for="(combo, comboIndex) in item.combos" :key="comboIndex">
                  <span v-if="comboIndex > 0" class="shortcuts-or">/</span>
                  <span class="shortcuts-keys">
                    <kbd v-for="key in combo" :key="key">{{ key }}</kbd>
                  </span>
                </template>
              </dd>
            </div>
          </dl>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.shortcuts-overlay {
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

.shortcuts-panel {
  width: min(560px, 100%);
  max-height: min(640px, calc(100vh - 48px));
  overflow-y: auto;
  padding: 20px 22px 22px;
  background: var(--glass-pop, rgba(251, 250, 245, 0.88));
  -webkit-backdrop-filter: blur(24px) saturate(1.5);
  backdrop-filter: blur(24px) saturate(1.5);
  border: 1px solid var(--line-strong);
  border-radius: var(--r-lg, 8px);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.7),
    var(--shadow-dialog, 0 24px 64px rgba(21, 23, 15, 0.18));
  outline: none;
}

.shortcuts-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
}

.shortcuts-head h2 {
  margin: 0;
  color: var(--text);
  font-size: var(--fs-h);
  font-weight: 600;
  line-height: 1.3;
}

.shortcuts-head p {
  margin: 4px 0 0;
  color: var(--faint);
  font-size: var(--fs-sub);
}

.shortcuts-close {
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

.shortcuts-close:hover {
  background: var(--paper-3);
  color: var(--text);
}

.shortcuts-close:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: 2px;
}

.shortcuts-groups {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.shortcuts-group h3 {
  margin: 0 0 8px;
  color: var(--faint);
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  font-weight: 500;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.shortcuts-list {
  margin: 0;
}

.shortcuts-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 7px 0;
  border-bottom: 1px solid var(--line);
}

.shortcuts-row:last-child {
  border-bottom: none;
}

.shortcuts-row dt {
  color: var(--text);
  font-size: var(--fs-sub);
}

.shortcuts-row dd {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  margin: 0;
}

.shortcuts-keys {
  display: inline-flex;
  gap: 4px;
}

.shortcuts-or {
  color: var(--faint);
  font-size: var(--fs-mono);
}

.shortcuts-row kbd {
  min-width: 22px;
  padding: 2px 6px;
  border: 1px solid var(--line);
  border-bottom-color: var(--line-strong);
  border-radius: var(--r-sm);
  background: var(--paper-2);
  color: var(--text);
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  text-align: center;
}

@media (max-width: 520px) {
  .shortcuts-row {
    align-items: flex-start;
    flex-direction: column;
    gap: 6px;
  }
}
</style>
