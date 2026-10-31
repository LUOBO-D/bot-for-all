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
  loadOlder: () => Promise<number>;
}>();
const emit = defineEmits<{
  reply: [message: Message];
  edit: [message: Message];
  delete: [message: Message];
  react: [message: Message, emoji: string];
  pin: [message: Message, pinned: boolean];
}>();

const container = ref<HTMLElement | null>(null);
const showJump = ref(false);
let prepending = false;
let loadingOlderLocal = false;

interface Row {
  type: 'date' | 'message' | 'divider';
  key: string;
  label?: string;
  message?: Message;
  compact?: boolean;
}

const rows = computed<Row[]>(() => {
  const result: Row[] = [];
  let lastDate = '';
  let previous: Message | undefined;
  let dividerInserted = false;
  for (const message of props.messages) {
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
    if (!dividerInserted && props.unreadMarker && message.seq >= props.unreadMarker) {
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

function maybeScroll() {
  if (prepending) {
    return;
  }
  const element = container.value;
  if (!element) {
    return;
  }
  const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
  showJump.value = distance > 320;
  if (distance < 180) {
    scrollToBottom();
  }
}

async function onScroll() {
  const element = container.value;
  if (!element) {
    return;
  }
  const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
  showJump.value = distance > 320;
  if (
    element.scrollTop < 120 &&
    props.hasMore &&
    !props.loadingOlder &&
    !loadingOlderLocal
  ) {
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

watch(
  () => props.messages,
  async () => {
    await nextTick();
    scrollToBottom();
  },
);

onMounted(scrollToBottom);
</script>

<template>
  <div ref="container" class="message-list" @scroll.passive="onScroll">
    <div v-if="hasMore" class="history-hint">
      {{ loadingOlder ? '加载更早的消息…' : '向上滚动加载更早的消息' }}
    </div>
    <template v-for="row in rows" :key="row.key">
      <div v-if="row.type === 'date'" class="date-sep">{{ row.label }}</div>
      <div v-else-if="row.type === 'divider'" class="unread-divider">
        <span class="unread-label">{{ row.label }}</span>
      </div>
      <MessageItem
        v-else-if="row.message"
        :message="row.message"
        :compact="row.compact"
        :highlight="row.message.seq === highlightSeq"
        :can-moderate="canModerate"
        @reply="emit('reply', $event)"
        @edit="emit('edit', $event)"
        @delete="emit('delete', $event)"
        @react="(message, emoji) => emit('react', message, emoji)"
        @pin="(message, pinned) => emit('pin', message, pinned)"
      />
    </template>
    <div v-if="!messages.length" class="message-empty">
      <div class="message-empty-icon">
        <Icon name="chat" :size="26" />
      </div>
      <div>还没有消息</div>
      <span>发一条消息，或 @机器人 试试</span>
    </div>
    <button v-if="showJump" class="jump-bottom" @click="scrollToBottom">
      <Icon name="arrowDown" :size="15" />
      回到底部
    </button>
  </div>
</template>
