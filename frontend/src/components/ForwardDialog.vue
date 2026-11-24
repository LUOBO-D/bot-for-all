<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import http, { errorMessage } from '../api/http';
import { useChatStore } from '../stores/chat';
import type { RoomSummary } from '../types';
import { avatarClass, initialOf } from '../utils/format';
import Icon from './Icon.vue';

const props = defineProps<{
  modelValue: boolean;
  sourceRoomId: number;
  /** One seq forwards via the single endpoint; several use the bulk endpoint. */
  sourceSeqs: number[];
  sourcePreview?: string;
}>();
const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  forwarded: [roomId: number, roomName: string];
}>();

const chat = useChatStore();
const panel = ref<HTMLElement | null>(null);
const loadingRooms = ref(false);
const busyRoomId = ref<number | null>(null);
const count = computed(() => props.sourceSeqs.length);
const isBulk = computed(() => count.value > 1);

// The source room is the only room that cannot receive this copy.
const rooms = computed<RoomSummary[]>(() =>
  chat.rooms.mine.filter((room) => room.id !== props.sourceRoomId),
);

function close() {
  if (busyRoomId.value !== null) {
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

async function forwardTo(room: RoomSummary) {
  if (busyRoomId.value !== null || count.value === 0) {
    return;
  }
  busyRoomId.value = room.id;
  try {
    if (isBulk.value) {
      await http.post(`/rooms/${room.id}/forward-bulk`, {
        sourceRoomId: props.sourceRoomId,
        sourceSeqs: [...props.sourceSeqs],
      });
      ElMessage.success(`已转发 ${count.value} 条消息到「${room.name}」`);
    } else {
      await http.post(`/rooms/${room.id}/forward`, {
        sourceRoomId: props.sourceRoomId,
        sourceSeq: props.sourceSeqs[0],
      });
      ElMessage.success(`已转发到「${room.name}」`);
    }
    emit('forwarded', room.id, room.name);
    emit('update:modelValue', false);
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    busyRoomId.value = null;
  }
}

watch(
  () => props.modelValue,
  async (open) => {
    if (!open) {
      busyRoomId.value = null;
      return;
    }
    await nextTick();
    panel.value?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    if (chat.rooms.mine.length > 0) {
      return;
    }
    // Deep-linked straight into the chat view: the room list may not be loaded yet.
    loadingRooms.value = true;
    try {
      await chat.loadRooms();
    } catch {
      // The empty state below covers a failed load.
    } finally {
      loadingRooms.value = false;
    }
  },
);
</script>

<template>
  <div v-if="modelValue" class="forward-overlay" @click.self="close">
    <div
      ref="panel"
      class="forward-panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="forward-title"
      data-testid="forward-dialog"
      tabindex="-1"
      @keydown="onKeydown"
    >
      <header class="forward-head">
        <div class="forward-head-text">
          <h2 id="forward-title">
            转发消息
            <span v-if="isBulk" class="forward-count" data-testid="forward-count">
              共 {{ count }} 条消息
            </span>
          </h2>
          <p>选择一个你已加入的房间</p>
        </div>
        <button
          class="forward-close"
          type="button"
          aria-label="关闭转发"
          data-autofocus
          @click="close"
        >
          <Icon name="close" :size="16" />
        </button>
      </header>

      <p v-if="isBulk" class="forward-preview" data-testid="forward-preview">
        共 {{ count }} 条消息
      </p>
      <p v-else-if="sourcePreview" class="forward-preview">{{ sourcePreview }}</p>

      <div class="forward-rooms">
        <div v-if="loadingRooms" class="forward-empty">加载房间…</div>
        <div v-else-if="!rooms.length" class="forward-empty">
          没有其他可转发的房间
        </div>
        <template v-else>
          <button
            v-for="room in rooms"
            :key="room.id"
            class="forward-room"
            type="button"
            data-testid="forward-room"
            :disabled="busyRoomId !== null"
            @click="forwardTo(room)"
          >
            <span class="avatar forward-room-avatar" :class="avatarClass(room.id)">
              {{ initialOf(room.name) }}
            </span>
            <span class="forward-room-main">
              <span class="forward-room-name">{{ room.name }}</span>
              <span class="forward-room-meta">{{ room.memberCount }} 位成员</span>
            </span>
            <span v-if="busyRoomId === room.id" class="forward-busy">转发中…</span>
            <Icon v-else name="forward" :size="15" />
          </button>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.forward-overlay {
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

.forward-panel {
  width: min(420px, 100%);
  max-height: min(560px, calc(100vh - 48px));
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

.forward-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.forward-head-text h2 {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 0;
  color: var(--text);
  font-size: var(--fs-h);
  font-weight: 600;
  line-height: 1.3;
}

.forward-count {
  color: var(--rust);
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  font-weight: 500;
  letter-spacing: 0.04em;
  white-space: nowrap;
}

.forward-head-text p {
  margin: 4px 0 0;
  color: var(--faint);
  font-size: var(--fs-sub);
}

.forward-close {
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

.forward-close:hover {
  background: var(--paper-3);
  color: var(--text);
}

.forward-close:focus-visible,
.forward-room:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: 2px;
}

.forward-preview {
  margin: 14px 0 0;
  padding: 8px 10px;
  border-left: 2px solid var(--rust);
  border-radius: 0 var(--r-sm) var(--r-sm) 0;
  background: var(--paper-3);
  color: var(--muted);
  font-size: var(--fs-sub);
  line-height: 1.5;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.forward-rooms {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 14px;
  overflow-y: auto;
  min-height: 0;
}

.forward-empty {
  padding: 22px 8px;
  color: var(--faint);
  font-size: var(--fs-sub);
  text-align: center;
}

.forward-room {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: var(--paper-2);
  color: var(--text);
  cursor: pointer;
  text-align: left;
  transition: background 0.12s ease-out, border-color 0.12s ease-out;
}

.forward-room:hover:not(:disabled) {
  background: var(--paper-3);
  border-color: var(--line-strong);
}

.forward-room:disabled {
  cursor: progress;
  opacity: 0.6;
}

.forward-room-avatar {
  width: 30px;
  height: 30px;
  border-radius: var(--r-sm);
  font-size: var(--fs-sub);
  font-weight: 700;
}

.forward-room-main {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: 1px;
}

.forward-room-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-body);
  font-weight: 600;
}

.forward-room-meta {
  color: var(--faint);
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  letter-spacing: 0.04em;
}

.forward-busy {
  flex: none;
  color: var(--muted);
  font-size: var(--fs-mono);
}
</style>
