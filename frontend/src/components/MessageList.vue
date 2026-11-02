<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import type { Message } from '../types';
import { formatDate } from '../utils/format';
import Icon from './Icon.vue';
import MessageItem from './MessageItem.vue';

const props = defineProps<{
  messages: Message[];
  hasMore?: boolean;
  loadingOlder?: boolean;
  unreadMarker?: number;
  highlightSeq?: number;
  canModerate?: boolean;
  selectable?: boolean;
  selectedSeqs?: Set<number>;
  loadOlder: () => Promise<number>;
}>();
const emit = defineEmits<{
  reply: [message: Message];
  edit: [message: Message];
  delete: [message: Message];
  react: [message: Message, emoji: string];
  pin: [message: Message, pinned: boolean];
  forward: [message: Message];
  select: [message: Message];
  history: [message: Message];
  report: [message: Message];
  vote: [message: Message, optionIds: number[], done: (ok: boolean) => void];
  close: [message: Message, done: (ok: boolean) => void];
}>();

/** Only the newest slice of loaded messages is mounted; older slices unfold on demand. */
const WINDOW_SIZE = 200;
/** Context kept above a jump/unread target when the window has to slide back to it. */
const REVEAL_CONTEXT = 20;
const TOP_TRIGGER = 120;
const FOLLOW_DISTANCE = 180;
const JUMP_DISTANCE = 320;

const container = ref<HTMLElement | null>(null);
const showJump = ref(false);
const hasUnreadDivider = computed(() => rows.value.some((row) => row.type === 'divider'));
const startIndex = ref(Math.max(0, props.messages.length - WINDOW_SIZE));
let prepending = false;
let loadingOlderLocal = false;
let revealing = false;
let resetting = false;
let trackedMessages: Message[] = props.messages;
let tailSeq = props.messages[props.messages.length - 1]?.seq ?? 0;

/** Histories past this many loaded messages get offscreen-rendering savings. */
const DENSE_THRESHOLD = 200;

const visibleMessages = computed(() => props.messages.slice(startIndex.value));
/** Long histories skip layout/paint for offscreen rows; short lists keep normal rendering. */
const dense = computed(() => props.messages.length > DENSE_THRESHOLD);
const hiddenCount = computed(() => Math.min(startIndex.value, props.messages.length));

interface Row {
  type: 'date' | 'message' | 'divider';
  key: string;
  label?: string;
  message?: Message;
  compact?: boolean;
}

const rows = computed<Row[]>(() => {
  const result: Row[] = [];
  const visible = visibleMessages.value;
  // The divider is only ours to draw when the marker message sits inside the
  // slice; otherwise it lives above the window and must not be redrawn here.
  const before = startIndex.value > 0 ? props.messages[startIndex.value - 1] : undefined;
  const marker =
    props.unreadMarker && !(before && before.seq >= props.unreadMarker) ? props.unreadMarker : 0;
  let lastDate = '';
  let previous: Message | undefined;
  let dividerInserted = false;
  for (const message of visible) {
    const date = new Date(message.createdAt);
    const dateKey = date.toDateString();
    if (dateKey !== lastDate) {
      result.push({
        type: 'date',
        key: `date-${dateKey}`,
        label: formatDate(message.createdAt),
      });
      lastDate = dateKey;
      previous = undefined;
    }
    if (!dividerInserted && marker && message.seq >= marker) {
      result.push({ type: 'divider', key: 'unread-divider', label: '未读消息' });
      dividerInserted = true;
    }
    const compact = Boolean(
      previous &&
        previous.senderId === message.senderId &&
        date.getTime() - new Date(previous.createdAt).getTime() < 5 * 60 * 1000,
    );
    result.push({
      type: 'message',
      key: `msg-${message.seq}`,
      message,
      compact,
    });
    previous = message;
  }
  return result;
});

function scrollToBottom() {
  const element = container.value;
  if (element) {
    element.scrollTop = element.scrollHeight;
    showJump.value = false;
  }
}

function scrollToUnread() {
  const divider = container.value?.querySelector('[data-testid="unread-divider"]');
  if (divider instanceof HTMLElement) {
    divider.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

function distanceFromBottom(): number {
  const element = container.value;
  if (!element) {
    return 0;
  }
  return element.scrollHeight - element.scrollTop - element.clientHeight;
}

function maybeScroll() {
  if (prepending || revealing) {
    return;
  }
  if (!container.value) {
    return;
  }
  const distance = distanceFromBottom();
  showJump.value = distance > JUMP_DISTANCE;
  if (distance < FOLLOW_DISTANCE) {
    scrollToBottom();
  }
}

/**
 * Slides the window start back to `nextStart` and restores the reader's place:
 * `bottom` keeps the newest message pinned, `position` compensates for the
 * height added above the viewport so the visible content does not move.
 */
async function revealWindow(nextStart: number, anchor: 'bottom' | 'position'): Promise<void> {
  const target = Math.max(0, Math.min(nextStart, startIndex.value));
  if (target === startIndex.value) {
    return;
  }
  const element = container.value;
  if (!element) {
    startIndex.value = target;
    return;
  }
  const previousHeight = element.scrollHeight;
  const previousTop = element.scrollTop;
  revealing = true;
  startIndex.value = target;
  try {
    await nextTick();
    element.scrollTop =
      anchor === 'bottom'
        ? element.scrollHeight
        : previousTop + (element.scrollHeight - previousHeight);
    if (anchor === 'bottom') {
      showJump.value = false;
    }
  } finally {
    revealing = false;
  }
}

/** One page of already-loaded history, with the reading position held in place. */
function revealEarlier(): Promise<void> {
  return revealWindow(startIndex.value - WINDOW_SIZE, 'position');
}

async function onScroll() {
  const element = container.value;
  if (!element) {
    return;
  }
  const distance = distanceFromBottom();
  showJump.value = distance > JUMP_DISTANCE;
  if (element.scrollTop >= TOP_TRIGGER) {
    return;
  }
  // Unfold what is already loaded before asking the server for more.
  if (startIndex.value > 0) {
    if (!revealing) {
      await revealEarlier();
    }
    return;
  }
  if (props.hasMore && !props.loadingOlder && !loadingOlderLocal) {
    loadingOlderLocal = true;
    prepending = true;
    const previousHeight = element.scrollHeight;
    const previousTop = element.scrollTop;
    await props.loadOlder();
    await nextTick();
    element.scrollTop = previousTop + (element.scrollHeight - previousHeight);
    prepending = false;
    loadingOlderLocal = false;
  }
}

watch(
  () => rows.value.length,
  async () => {
    await nextTick();
    maybeScroll();
  },
);

watch(
  () => props.messages[props.messages.length - 1]?.content.length ?? 0,
  async () => {
    await nextTick();
    maybeScroll();
  },
);

// A new array means a different room (the store keeps one array per room):
// reset the window to the newest page and land on the latest message.
watch(
  () => props.messages,
  async (messages) => {
    trackedMessages = messages;
    tailSeq = messages[messages.length - 1]?.seq ?? 0;
    startIndex.value = Math.max(0, messages.length - WINDOW_SIZE);
    resetting = true;
    await nextTick();
    scrollToBottom();
    resetting = false;
  },
);

// Appends only slide the window when the reader is already at the bottom;
// otherwise the slice keeps its start so nothing above them is pushed away.
watch(
  () => props.messages.length,
  async (length, previousLength) => {
    if (length === previousLength) {
      return;
    }
    if (length < previousLength) {
      startIndex.value = Math.min(startIndex.value, length);
      return;
    }
    if (props.messages !== trackedMessages) {
      return; // room switch: the reference watcher owns the reset
    }
    const nextTail = props.messages[length - 1]?.seq ?? 0;
    const appended = nextTail !== tailSeq;
    tailSeq = nextTail;
    if (!appended || distanceFromBottom() >= FOLLOW_DISTANCE) {
      return; // history was inserted above, or the reader is up in the list
    }
    startIndex.value = Math.max(0, length - WINDOW_SIZE);
    await nextTick();
    scrollToBottom();
  },
);

// Jump targets (search/pin) must be mounted even when they predate the window.
// The caller awaits this so a jump never queries the DOM before the window has
// unfolded and the target row exists.
async function revealMessage(seq: number): Promise<boolean> {
  const index = props.messages.findIndex((message) => message.seq === seq);
  if (index < 0) {
    return false;
  }
  if (index < startIndex.value) {
    await revealWindow(index - REVEAL_CONTEXT, 'position');
  }
  await nextTick();
  const element = container.value?.querySelector<HTMLElement>(`[data-seq="${seq}"]`);
  if (!element) {
    return false;
  }
  element.scrollIntoView({ block: 'center' });
  return true;
}

defineExpose({ revealMessage });

// The unread divider lives on the marker message; keep it inside the window.
watch(
  () => props.unreadMarker,
  async (marker) => {
    if (!marker) {
      return;
    }
    const index = props.messages.findIndex((message) => message.seq >= marker);
    if (index < 0 || index >= startIndex.value) {
      return;
    }
    const atBottom = resetting || distanceFromBottom() < FOLLOW_DISTANCE;
    await revealWindow(index - REVEAL_CONTEXT, atBottom ? 'bottom' : 'position');
  },
);

// The selection toolbar changes the list's height; keep a reader who was at
// the bottom pinned to it instead of clipping the newest row.
watch(
  () => props.selectable,
  async () => {
    await nextTick();
    maybeScroll();
  },
);

onMounted(scrollToBottom);
</script>

<template>
  <div
    ref="container"
    class="message-list"
    :class="{
      'message-list--dense': dense,
      'message-list--jump': showJump,
    }"
    tabindex="0"
    role="log"
    aria-label="消息列表"
    @scroll.passive="onScroll"
  >
    <button
      v-if="hiddenCount > 0"
      type="button"
      data-testid="reveal-earlier"
      class="reveal-earlier"
      @click="revealEarlier"
    >
      显示更早的已加载消息（{{ hiddenCount }}）
    </button>
    <div v-if="hasMore" class="history-hint">
      {{ loadingOlder ? '加载更早的消息…' : '向上滚动加载更早的消息' }}
    </div>
    <template v-for="row in rows" :key="row.key">
      <div v-if="row.type === 'date'" class="date-sep"><span class="date-pill">{{ row.label }}</span></div>
      <div v-else-if="row.type === 'divider'" class="unread-divider" data-testid="unread-divider">
        <span class="unread-label">{{ row.label }}</span>
      </div>
      <MessageItem
        v-else-if="row.message"
        :message="row.message"
        :compact="row.compact"
        :highlight="row.message.seq === highlightSeq"
        :can-moderate="canModerate"
        :selectable="selectable"
        :selected="Boolean(selectedSeqs?.has(row.message.seq))"
        @reply="emit('reply', $event)"
        @forward="emit('forward', $event)"
        @edit="emit('edit', $event)"
        @delete="emit('delete', $event)"
        @react="(message, emoji) => emit('react', message, emoji)"
        @pin="(message, pinned) => emit('pin', message, pinned)"
        @select="emit('select', $event)"
        @history="emit('history', $event)"
        @report="emit('report', $event)"
        @vote="(message, optionIds, done) => emit('vote', message, optionIds, done)"
        @close="(message, done) => emit('close', message, done)"
      />
    </template>
    <div v-if="!messages.length" class="message-empty">
      <div class="message-empty-icon">
        <Icon name="chat" :size="26" />
      </div>
      <div>还没有消息</div>
      <span>发一条消息，或 @机器人 试试</span>
    </div>
    <button
      v-if="showJump && hasUnreadDivider"
      class="jump-unread"
      type="button"
      data-testid="jump-unread"
      @click="scrollToUnread"
    >
      <span aria-hidden="true">↑</span>
      未读消息
    </button>
    <button v-if="showJump" class="jump-bottom" @click="scrollToBottom">
      <Icon name="arrowDown" :size="15" />
      回到底部
    </button>
  </div>
</template>

<style scoped>
/* While the jump pill floats, reserve room below the final row: the sticky
   pill otherwise sits over the newest message at the bottom of the scroll. */
.message-list.message-list--jump {
  padding-bottom: calc(54px + env(safe-area-inset-bottom));
  scroll-padding-bottom: calc(54px + env(safe-area-inset-bottom));
}

/* Long histories: offscreen rows cost nothing to lay out or paint. The
   intrinsic size stands in for each row so scroll height stays stable. */
.message-list--dense .msg {
  content-visibility: auto;
  contain-intrinsic-size: auto 84px;
}

/* Window affordance: reads as a quiet seam, not as message content. */
.reveal-earlier {
  display: block;
  width: max-content;
  margin: 0 auto 10px;
  padding: 5px 12px;
  border: 1px dashed var(--line-strong);
  border-radius: var(--r-md);
  background: transparent;
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  letter-spacing: 0.06em;
  cursor: pointer;
  transition: color 0.15s ease, border-color 0.15s ease;
}

.reveal-earlier:hover {
  color: var(--text);
  border-color: var(--ink);
  border-style: solid;
}

.reveal-earlier:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: 2px;
}

/* Sits just above the global "回到底部" pill while the unread divider is
   outside the viewport. */
.jump-unread {
  position: sticky;
  bottom: calc(52px + env(safe-area-inset-bottom));
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 6px;
  width: max-content;
  margin: 8px auto 0;
  padding: 6px 12px;
  border: 1px solid var(--lime);
  border-radius: var(--r-md);
  background: var(--lime);
  color: var(--ink);
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  letter-spacing: 0.04em;
  cursor: pointer;
}

.jump-unread:hover {
  background: var(--lime-hover);
}

.jump-unread:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: 2px;
}
</style>
