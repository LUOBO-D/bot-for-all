<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import http from '../api/http';
import { useChatStore } from '../stores/chat';
import type { GlobalMessage, RoomSummary } from '../types';
import Icon from './Icon.vue';

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  shortcuts: [];
  saved: [];
  drafts: [];
}>();

const router = useRouter();
const chat = useChatStore();
const query = ref('');
const active = ref(0);
const input = ref<HTMLInputElement | null>(null);
const panel = ref<HTMLElement | null>(null);

interface Item {
  id: string;
  type: 'room' | 'message' | 'action';
  label: string;
  hint: string;
  room?: RoomSummary;
  message?: GlobalMessage;
}

const messageResults = ref<GlobalMessage[]>([]);
let searchTimer: number | undefined;
let searchRequestId = 0;

const MIN_SEARCH_LENGTH = 2;
const MESSAGE_LABEL_MAX = 80;

function messageLabel(content: string): string {
  const single = content.replace(/\s+/g, ' ').trim();
  if (!single) {
    return '(无文本内容)';
  }
  return single.length > MESSAGE_LABEL_MAX
    ? `${single.slice(0, MESSAGE_LABEL_MAX)}…`
    : single;
}

const rooms = computed<RoomSummary[]>(() => {
  const seen = new Set<number>();
  const list: RoomSummary[] = [];
  for (const room of [...chat.rooms.mine, ...chat.rooms.public]) {
    if (seen.has(room.id)) {
      continue;
    }
    seen.add(room.id);
    list.push(room);
  }
  const keyword = query.value.trim().toLowerCase();
  return (keyword
    ? list.filter(
        (room) =>
          room.name.toLowerCase().includes(keyword) ||
          room.topic.toLowerCase().includes(keyword),
      )
    : list
  ).slice(0, 8);
});

const messages = computed<Item[]>(() =>
  messageResults.value.map((message) => ({
    id: `message-${message.roomId}-${message.seq}`,
    type: 'message',
    label: messageLabel(message.content),
    hint: `${message.roomName} · ${message.senderName}`,
    message,
  })),
);

const items = computed<Item[]>(() => {
  const list: Item[] = rooms.value.map((room) => ({
    id: `room-${room.id}`,
    type: 'room',
    label: room.name,
    hint: room.topic || (room.joined ? '已加入' : '公开房间'),
    room,
  }));
  const keyword = query.value.trim().toLowerCase();
  const actions: Item[] = [
    { id: 'rooms', type: 'action', label: '打开房间列表', hint: '/rooms' },
    { id: 'saved-messages', type: 'action', label: '已保存消息', hint: '保存的消息' },
    { id: 'drafts', type: 'action', label: '草稿箱', hint: '跨房间草稿' },
    { id: 'top', type: 'action', label: '回到消息顶部', hint: '当前房间' },
    { id: 'shortcuts', type: 'action', label: '键盘快捷键', hint: '?' },
    { id: 'global-search', type: 'action', label: '全局搜索', hint: '/search' },
  ];
  if (chat.currentRoomId != null) {
    actions.push({
      id: 'copy',
      type: 'action',
      label: '复制当前房间链接',
      hint: window.location.href,
    });
  }
  return [
    ...list,
    ...messages.value,
    ...actions.filter((action) => !keyword || action.label.toLowerCase().includes(keyword)),
  ];
});

watch(
  () => props.modelValue,
  (open) => {
    window.clearTimeout(searchTimer);
    if (!open) {
      searchRequestId += 1;
      messageResults.value = [];
      return;
    }
    query.value = '';
    active.value = 0;
    messageResults.value = [];
    searchRequestId += 1;
    nextTick(() => input.value?.focus());
  },
);

watch(query, (value) => {
  active.value = 0;
  window.clearTimeout(searchTimer);
  const keyword = value.trim();
  if (keyword.length < MIN_SEARCH_LENGTH) {
    searchRequestId += 1;
    messageResults.value = [];
    return;
  }
  searchTimer = window.setTimeout(async () => {
    const requestId = (searchRequestId += 1);
    try {
      const { data } = await http.get<{ messages: GlobalMessage[] }>('/search/messages', {
        params: { q: keyword, limit: 20 },
      });
      if (requestId !== searchRequestId) {
        return;
      }
      messageResults.value = data.messages;
    } catch {
      // Global search failures stay silent: rooms and actions remain usable.
      if (requestId === searchRequestId) {
        messageResults.value = [];
      }
    }
  }, 250);
});

onUnmounted(() => window.clearTimeout(searchTimer));

function close() {
  emit('update:modelValue', false);
}

function move(delta: number) {
  if (items.value.length === 0) {
    return;
  }
  active.value = (active.value + delta + items.value.length) % items.value.length;
}

function select(item: Item | undefined) {
  if (!item) {
    return;
  }
  if (item.type === 'message' && item.message) {
    close();
    void router.push(`/rooms/${item.message.roomId}?seq=${item.message.seq}`);
    return;
  }
  if (item.type === 'room' && item.room) {
    close();
    void router.push(`/rooms/${item.room.id}`);
    return;
  }
  if (item.id === 'global-search') {
    close();
    void router.push('/search');
    return;
  }
  if (item.id === 'rooms') {
    close();
    void router.push('/rooms');
    return;
  }
  if (item.id === 'saved-messages') {
    close();
    emit('saved');
    return;
  }
  if (item.id === 'drafts') {
    close();
    emit('drafts');
    return;
  }
  if (item.id === 'top') {
    close();
    document.querySelector('.message-list')?.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  if (item.id === 'shortcuts') {
    close();
    emit('shortcuts');
    return;
  }
  if (item.id === 'copy') {
    close();
    void navigator.clipboard.writeText(window.location.href);
  }
}

// Minimal focus trap: while the palette is modal, Tab must not escape into
// the page behind the overlay.
function trapFocus(event: KeyboardEvent) {
  const root = panel.value;
  if (!root) {
    return;
  }
  const focusable = Array.from(
    root.querySelectorAll<HTMLElement>(
      'input, button, [href], [tabindex]:not([tabindex="-1"])',
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
    close();
    return;
  }
  if (event.key === 'Tab') {
    trapFocus(event);
    return;
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    move(1);
    return;
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault();
    move(-1);
    return;
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    select(items.value[active.value]);
  }
}
</script>

<template>
  <div v-if="modelValue" class="cmdk-overlay" @click.self="close">
    <div
      ref="panel"
      class="cmdk"
      role="dialog"
      aria-modal="true"
      aria-label="命令面板"
      @keydown="onKeydown"
    >
      <div class="cmdk-input">
        <Icon name="search" :size="17" />
        <input
          ref="input"
          v-model="query"
          aria-label="搜索房间、消息或命令"
          placeholder="搜索房间、消息或命令…"
          autocomplete="off"
        />
        <kbd>Esc</kbd>
      </div>
      <div class="cmdk-list" role="listbox" aria-label="命令结果">
        <button
          v-for="(item, index) in items"
          :key="item.id"
          class="cmdk-item"
          role="option"
          :aria-selected="index === active"
          :class="{ active: index === active }"
          :data-testid="item.type === 'message' ? 'cmdk-message' : undefined"
          @mouseenter="active = index"
          @click="select(item)"
        >
          <Icon
            :name="
              item.type === 'room'
                ? 'hash'
                : item.type === 'message' || item.id === 'global-search'
                  ? 'search'
                  : 'chat'
            "
            :size="16"
          />
          <span class="cmdk-label">{{ item.label }}</span>
          <span class="cmdk-hint">{{ item.hint }}</span>
        </button>
        <div v-if="items.length === 0" class="cmdk-empty">没有匹配的房间、消息或命令</div>
      </div>
      <div class="cmdk-footer">↑↓ 选择 · Enter 打开 · Esc 关闭</div>
    </div>
  </div>
</template>

<style scoped>
/* Message labels are single-line snippets; keep them from pushing the hint. */
.cmdk-label {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
</style>
