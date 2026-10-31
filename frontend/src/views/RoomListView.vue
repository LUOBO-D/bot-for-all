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

const joinedCount = computed(() => rooms.value.filter((room) => room.joined).length);
const unreadTotal = computed(() =>
  rooms.value.reduce((sum, room) => sum + (room.unreadCount ?? 0), 0),
);
const memberTotal = computed(() =>
  rooms.value.reduce((sum, room) => sum + (room.memberCount ?? 0), 0),
);

const recentRooms = computed(() =>
  rooms.value
    .filter((room) => room.lastMessage)
    .sort((a, b) => {
      const left = new Date(a.lastMessage!.createdAt).getTime();
      const right = new Date(b.lastMessage!.createdAt).getTime();
      return right - left;
    })
    .slice(0, 5),
);

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
  <div class="rooms-shell">
    <RoomSidebar />
    <main class="rooms-board">
      <span class="board-watermark" aria-hidden="true">01</span>
      <header class="rooms-head">
        <div>
          <div class="rooms-index">01 — ROOMS · 深海会议室</div>
          <h1 class="rooms-title">今天聊<em>什么</em>？</h1>
          <p class="rooms-lead">
            选一个房间进去。机器人就坐在成员列表里，@ 它就会开口；
            离开再回来，错过的每一句都还在。
          </p>
        </div>
        <div class="rooms-stats">
          <div class="rooms-stat">
            <b>{{ rooms.length }}</b>
            <span>ROOMS</span>
          </div>
          <div class="rooms-stat">
            <b>{{ joinedCount }}</b>
            <span>JOINED</span>
          </div>
          <div class="rooms-stat">
            <b>{{ unreadTotal }}</b>
            <span>UNREAD</span>
          </div>
        </div>
      </header>

      <div class="rooms-body">
        <div class="room-grid">
          <button
            v-for="(room, index) in rooms"
            :key="room.id"
            class="room-card"
            :class="{ unjoined: !room.joined, featured: index === 0 && rooms.length <= 2 }"
            :title="room.name"
            :style="{ animationDelay: `${index * 45}ms` }"
            @click="open(room)"
          >
            <span class="room-card-head">
              <span class="avatar" :class="avatarClass(room.id)">
                {{ initialOf(room.name) }}
              </span>
              <span class="room-card-name">{{ room.name }}</span>
              <span v-if="room.unreadCount" class="unread">{{ room.unreadCount }}</span>
            </span>
            <span v-if="room.topic" class="room-card-topic">{{ room.topic }}</span>
            <span class="room-card-last">
              <template v-if="room.lastMessage">
                {{ room.lastMessage.senderName }}：{{ plainPreview(room.lastMessage.content) }}
              </template>
              <template v-else>还没有消息，进去说第一句。</template>
            </span>
            <span class="room-card-meta">{{ cardMeta(room) }}</span>
          </button>

          <div v-if="rooms.length === 0" class="rooms-empty">
            <strong>海底还很安静</strong>
            <span>用左下角的「创建」开第一个房间，或「加入」一个已有房间。</span>
          </div>
        </div>

        <aside class="rooms-rail">
          <section class="guide-panel">
          <h2>机器人怎么用</h2>
          <p class="guide-sub">{{ memberTotal }} 个座位 · 三步开聊</p>
          <ol class="guide-steps">
            <li class="guide-step">
              <i>01</i>
              <b>创建机器人</b>
              点房间右上角「机器人」，填 baseUrl、API Key 与模型名。
            </li>
            <li class="guide-step">
              <i>02</i>
              <b>挂载进房间</b>
              点「挂载」，它会像真人一样出现在成员列表里。
            </li>
            <li class="guide-step">
              <i>03</i>
              <b>@ 它说话</b>
              回复会流式逐字打出；断线重连后缺口自动补齐。
            </li>
          </ol>
        </section>

        <section class="recap-panel">
          <h2>最近动态</h2>
          <ul v-if="recentRooms.length" class="recap-list">
            <li
              v-for="room in recentRooms"
              :key="room.id"
              class="recap-item"
              @click="open(room)"
            >
              <span class="recap-room">{{ room.name }}</span>
              <span class="recap-time">{{ formatRelative(room.lastMessage!.createdAt) }}</span>
              <span class="recap-text">
                {{ room.lastMessage!.senderName }}：{{ plainPreview(room.lastMessage!.content) }}
              </span>
            </li>
          </ul>
          <div v-else class="recap-empty">还没有人说话，第一个开口的就是你。</div>
        </section>
        </aside>
      </div>

      <footer class="rooms-foot">
        <span>DEEP SEA · LOCAL DEMO</span>
        <span>{{ rooms.length }} 房间 · {{ memberTotal }} 个座位 · {{ joinedCount }} 已加入</span>
      </footer>
    </main>
  </div>
</template>
