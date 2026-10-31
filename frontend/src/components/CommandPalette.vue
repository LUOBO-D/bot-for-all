<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useChatStore } from '../stores/chat';
import type { RoomSummary } from '../types';
import Icon from './Icon.vue';

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();

const router = useRouter();
const chat = useChatStore();
const query = ref('');
const active = ref(0);
const input = ref<HTMLInputElement | null>(null);

interface Item {
  id: string;
  type: 'room' | 'action';
  label: string;
  hint: string;
  room?: RoomSummary;
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
    { id: 'top', type: 'action', label: '回到消息顶部', hint: '当前房间' },
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
    ...actions.filter((action) => !keyword || action.label.toLowerCase().includes(keyword)),
  ];
});

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      query.value = '';
      active.value = 0;
      nextTick(() => input.value?.focus());
    }
  },
);

watch(query, () => {
  active.value = 0;
});

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
  if (item.type === 'room' && item.room) {
    close();
    void router.push(`/rooms/${item.room.id}`);
    return;
  }
  if (item.id === 'rooms') {
    close();
    void router.push('/rooms');
    return;
  }
  if (item.id === 'top') {
    close();
    document.querySelector('.message-list')?.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  if (item.id === 'copy') {
    close();
    void navigator.clipboard.writeText(window.location.href);
  }
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    close();
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
    <div class="cmdk" role="dialog" aria-modal="true" aria-label="命令面板" @keydown="onKeydown">
      <div class="cmdk-input">
        <Icon name="search" :size="17" />
        <input
          ref="input"
          v-model="query"
          placeholder="搜索房间或命令…"
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
          @mouseenter="active = index"
          @click="select(item)"
        >
          <Icon :name="item.type === 'room' ? 'hash' : 'chat'" :size="16" />
          <span class="cmdk-label">{{ item.label }}</span>
          <span class="cmdk-hint">{{ item.hint }}</span>
        </button>
        <div v-if="items.length === 0" class="cmdk-empty">没有匹配的房间或命令</div>
      </div>
      <div class="cmdk-footer">↑↓ 选择 · Enter 打开 · Esc 关闭</div>
    </div>
  </div>
</template>
