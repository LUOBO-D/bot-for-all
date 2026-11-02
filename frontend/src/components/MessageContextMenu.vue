<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import Icon from './Icon.vue';

interface MenuItem {
  id: string;
  label: string;
  icon?: string;
  danger?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
}

const props = defineProps<{
  open: boolean;
  x: number;
  y: number;
  items: MenuItem[];
}>();

const emit = defineEmits<{
  select: [id: string];
  close: [];
}>();

const EDGE = 8;
const menu = ref<HTMLElement | null>(null);
const pos = ref({ left: 0, top: 0 });
const placed = ref(false);
const activeIndex = ref(-1);
let returnFocus: HTMLElement | null = null;
let listening = false;

const enabledIndexes = computed(() =>
  props.items.reduce<number[]>((indexes, item, index) => {
    if (!item.disabled) {
      indexes.push(index);
    }
    return indexes;
  }, []),
);

function itemNodes(): HTMLElement[] {
  return Array.from(menu.value?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
}

function focusAt(index: number) {
  if (index < 0) {
    return;
  }
  activeIndex.value = index;
  itemNodes()[index]?.focus();
}

// Cursor-anchored: flip left/up when the menu would leave the viewport, then clamp.
function place() {
  const element = menu.value;
  if (!element) {
    return;
  }
  const { width, height } = element.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  let left = props.x;
  let top = props.y;
  if (left + width > viewportWidth - EDGE) {
    left = props.x - width;
  }
  if (top + height > viewportHeight - EDGE) {
    top = props.y - height;
  }
  left = Math.min(Math.max(EDGE, left), Math.max(EDGE, viewportWidth - width - EDGE));
  top = Math.min(Math.max(EDGE, top), Math.max(EDGE, viewportHeight - height - EDGE));
  pos.value = { left, top };
}

function detach() {
  if (!listening) {
    return;
  }
  listening = false;
  window.removeEventListener('resize', dismiss);
  window.removeEventListener('scroll', dismiss, true);
  document.removeEventListener('pointerdown', onPointerDown, true);
}

function dismiss() {
  emit('close');
}

function dismissWithFocus() {
  emit('close');
  if (returnFocus?.isConnected) {
    returnFocus.focus();
  }
}

function onPointerDown(event: PointerEvent) {
  if (menu.value?.contains(event.target as Node)) {
    return;
  }
  dismiss();
}

function step(direction: number) {
  const indexes = enabledIndexes.value;
  if (!indexes.length) {
    return;
  }
  const current = indexes.indexOf(activeIndex.value);
  const next = current < 0 ? 0 : (current + direction + indexes.length) % indexes.length;
  focusAt(indexes[next]);
}

function hoverItem(index: number) {
  if (!props.items[index]?.disabled) {
    activeIndex.value = index;
  }
}

function choose(index: number) {
  const item = props.items[index];
  if (!item || item.disabled) {
    return;
  }
  emit('select', item.id);
  emit('close');
}

function onKeydown(event: KeyboardEvent) {
  const indexes = enabledIndexes.value;
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault();
      step(1);
      break;
    case 'ArrowUp':
      event.preventDefault();
      step(-1);
      break;
    case 'Home':
      event.preventDefault();
      if (indexes.length) {
        focusAt(indexes[0]);
      }
      break;
    case 'End':
      event.preventDefault();
      if (indexes.length) {
        focusAt(indexes[indexes.length - 1]);
      }
      break;
    case 'Enter':
    case ' ':
      event.preventDefault();
      choose(activeIndex.value);
      break;
    case 'Escape':
      event.preventDefault();
      dismissWithFocus();
      break;
    case 'Tab':
      dismiss();
      break;
  }
}

watch(
  () => props.open,
  async (open) => {
    if (!open) {
      detach();
      placed.value = false;
      activeIndex.value = -1;
      return;
    }
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    placed.value = false;
    activeIndex.value = -1;
    await nextTick();
    place();
    placed.value = true;
    await nextTick();
    const first = enabledIndexes.value[0] ?? -1;
    if (first >= 0) {
      focusAt(first);
    } else {
      menu.value?.focus();
    }
    if (!listening) {
      listening = true;
      window.addEventListener('resize', dismiss);
      window.addEventListener('scroll', dismiss, true);
      document.addEventListener('pointerdown', onPointerDown, true);
    }
  },
);

onBeforeUnmount(detach);

// Re-anchor when the caller opens the menu again at a new point without
// a close in between (right-clicking the same row twice).
watch([() => props.x, () => props.y], () => {
  if (props.open && placed.value) {
    place();
  }
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      ref="menu"
      class="ctx-menu"
      :class="{ placed }"
      :style="{ left: `${pos.left}px`, top: `${pos.top}px` }"
      role="menu"
      aria-label="消息操作"
      tabindex="-1"
      @keydown="onKeydown"
      @contextmenu.prevent
    >
      <template v-for="(item, index) in items" :key="item.id">
        <div v-if="item.separatorBefore" class="ctx-sep" role="separator"></div>
        <button
          class="ctx-item"
          :class="{ danger: item.danger, active: activeIndex === index }"
          type="button"
          role="menuitem"
          :data-testid="item.id"
          :aria-disabled="item.disabled ? 'true' : undefined"
          :disabled="item.disabled"
          @mouseenter="hoverItem(index)"
          @click="choose(index)"
        >
          <Icon v-if="item.icon" :name="item.icon" :size="14" />
          <span class="ctx-label">{{ item.label }}</span>
        </button>
      </template>
    </div>
  </Teleport>
</template>

<style scoped>
/* Above message rows (<=20) and the chat topbar (6); below Element Plus
   overlays/popups, which start at 2000. */
.ctx-menu {
  position: fixed;
  z-index: 1500;
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 168px;
  max-width: 240px;
  padding: 5px;
  background: var(--paper-2);
  background: var(--glass-pop);
  -webkit-backdrop-filter: blur(20px) saturate(1.5);
  backdrop-filter: blur(20px) saturate(1.5);
  border: 1px solid var(--line-strong);
  border-radius: var(--r-md);
  box-shadow: inset 0 1px 0 var(--glass-hi), var(--glass-shadow);
  outline: none;
}

/* Position is measured on the first frame, then revealed. */
.ctx-menu:not(.placed) {
  visibility: hidden;
}

.ctx-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 9px;
  border: none;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: var(--fs-sub);
  line-height: 1.2;
  text-align: left;
  cursor: pointer;
}

.ctx-item:focus-visible {
  outline: none;
}

.ctx-item.active,
.ctx-item:focus-visible {
  background: var(--paper-3);
}

.ctx-item.danger {
  color: var(--danger);
}

.ctx-item.danger.active,
.ctx-item.danger:focus-visible {
  background: var(--danger-soft);
}

.ctx-item[aria-disabled='true'] {
  color: var(--faint);
  cursor: default;
  opacity: 0.55;
}

.ctx-sep {
  height: 1px;
  margin: 4px 6px;
  background: var(--line);
}

.ctx-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
</style>
