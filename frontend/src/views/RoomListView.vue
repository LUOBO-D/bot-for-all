<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import http, { errorMessage } from '../api/http';
import { useChatStore } from '../stores/chat';
import type { RoomSummary } from '../types';
import RoomSidebar from '../components/RoomSidebar.vue';
import { avatarClass, formatRelative, initialOf, plainPreview } from '../utils/format';

const router = useRouter();
const chat = useChatStore();
const busy = ref(false);
const markingAll = ref(false);

onMounted(() => {
  chat.bind();
});

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
  return list;
});

const hasUnread = computed(() => rooms.value.some((room) => room.unreadCount > 0));

async function markAllRead() {
  if (markingAll.value) {
    return;
  }
  markingAll.value = true;
  try {
    const { data } = await http.post<{ updated: number }>('/rooms/read-all', {});
    await chat.loadRooms();
    ElMessage.success(`已将 ${data.updated} 个房间标为已读`);
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    markingAll.value = false;
  }
}

function cardMeta(room: RoomSummary): string {
  const bits = [`#${room.id}`];
  if (room.isPublic && !room.joined) {
    bits.push('公开');
  } else if (!room.isPublic) {
    bits.push('私密');
  }
  bits.push(`${room.memberCount} 成员`);
  if (room.unreadCount) {
    bits.push(`${room.unreadCount} 未读`);
  }
  if (room.lastMessage) {
    bits.push(formatRelative(room.lastMessage.createdAt));
  }
  return bits.join(' · ');
}

async function open(room: RoomSummary) {
  if (busy.value) {
    return;
  }
  try {
    if (!room.joined) {
      busy.value = true;
      await http.post(`/rooms/${room.id}/join`, {});
      await chat.loadRooms();
    }
    await router.push(`/rooms/${room.id}`);
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="app-layout rooms-layout">
    <RoomSidebar class="rooms-sidebar" />
    <main class="welcome-pane">
      <div class="workbench-inner">
        <header class="wb-head">
          <h1 class="wb-title">房间</h1>
          <p class="wb-lead">
            <span class="count">{{ rooms.length }}</span>
            间 · 机器人是群成员：拉进来、挂在成员列表里，@它 就会逐字回复。
          </p>
          <button
            v-if="hasUnread"
            type="button"
            class="btn ghost small wb-read-all"
            data-testid="rooms-read-all"
            :disabled="markingAll"
            @click="markAllRead"
          >
            全部已读
          </button>
        </header>

        <div class="wb-layout">
          <div class="wb-grid">
          <button
            v-for="room in rooms"
            :key="room.id"
            class="wb-card"
            :class="{ unjoined: !room.joined }"
            :title="room.name"
            @click="open(room)"
          >
            <span class="wb-card-head">
              <span class="avatar" :class="avatarClass(room.id)">
                {{ initialOf(room.name) }}
              </span>
              <span class="wb-card-name">{{ room.name }}</span>
              <span v-if="room.unreadCount" class="unread">{{ room.unreadCount }}</span>
            </span>
            <span v-if="room.topic" class="wb-card-topic">{{ room.topic }}</span>
            <span class="wb-card-last">
              <template v-if="room.lastMessage">
                {{ room.lastMessage.senderName }}：{{ plainPreview(room.lastMessage.content) }}
              </template>
            </span>
            <span class="wb-card-meta">{{ cardMeta(room) }}</span>
          </button>

          <div v-if="rooms.length === 0" class="wb-empty">
            <strong>还没有房间</strong>
            <span>用左下角的「创建」开第一个房间，或「加入」一个私密房。</span>
          </div>
          </div>

          <section class="wb-guide">
            <h2>机器人怎么用</h2>
            <ol class="wb-steps">
              <li>
                <span class="wb-step-no">01</span>
                <p>点房间右上角「机器人」，填 baseUrl、API Key 和 model，创建机器人。</p>
              </li>
              <li>
                <span class="wb-step-no">02</span>
                <p>点「挂载」。它会像真人一样出现在成员列表里，有名字、有头像。</p>
              </li>
              <li>
                <span class="wb-step-no">03</span>
                <p>在输入框 @它，回复流式逐字打出；断线重连后缺的消息自动补上。</p>
              </li>
            </ol>
          </section>
        </div>
      </div>
    </main>
  </div>
</template>

<style scoped>
/* Sits at the far end of the header, clear of the title/lead baseline. */
.wb-read-all {
  margin-left: auto;
  align-self: center;
}
</style>
