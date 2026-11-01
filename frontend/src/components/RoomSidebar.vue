<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import http, { errorMessage } from '../api/http';
import { useAuthStore } from '../stores/auth';
import { useChatStore } from '../stores/chat';
import { useUiStore } from '../stores/ui';
import type { RoomSummary } from '../types';
import { avatarClass, formatRelative, initialOf, plainPreview } from '../utils/format';
import Icon from './Icon.vue';
import BrandMark from './BrandMark.vue';
import ProfileDialog from './ProfileDialog.vue';

const props = defineProps<{ activeRoomId?: number }>();
const emit = defineEmits<{ navigate: [] }>();

const router = useRouter();
const auth = useAuthStore();
const ui = useUiStore();
const chat = useChatStore();

const query = ref('');
const tab = ref<'mine' | 'public'>('mine');
const createVisible = ref(false);
const joinVisible = ref(false);
const profileVisible = ref(false);
const busy = ref(false);
const createForm = reactive({ name: '', topic: '', isPublic: true });
const joinForm = reactive({ roomId: '', inviteCode: '' });

const rooms = computed(() => {
  const list = tab.value === 'mine' ? chat.rooms.mine : chat.rooms.public;
  const keyword = query.value.trim().toLowerCase();
  if (!keyword) {
    return list;
  }
  return list.filter(
    (room) =>
      room.name.toLowerCase().includes(keyword) ||
      room.topic.toLowerCase().includes(keyword),
  );
});

const userInitial = computed(() => initialOf(auth.user?.displayName ?? '?'));
const userAvatar = computed(() => avatarClass(auth.user?.id ?? 0));

onMounted(async () => {
  if (chat.rooms.mine.length === 0 && chat.rooms.public.length === 0) {
    try {
      await chat.loadRooms();
    } catch (error) {
      ElMessage.error(errorMessage(error));
    }
  }
  if (chat.rooms.mine.length === 0 && chat.rooms.public.length > 0) {
    tab.value = 'public';
  }
});

async function selectRoom(room: RoomSummary) {
  try {
    if (!room.joined) {
      busy.value = true;
      await http.post(`/rooms/${room.id}/join`, {});
      await chat.loadRooms();
    }
    emit('navigate');
    await router.push(`/rooms/${room.id}`);
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    busy.value = false;
  }
}

async function createRoom() {
  if (!createForm.name.trim()) {
    ElMessage.warning('请输入房间名');
    return;
  }
  try {
    busy.value = true;
    const { data } = await http.post<{ room: RoomSummary }>('/rooms', {
      name: createForm.name.trim(),
      topic: createForm.topic.trim(),
      isPublic: createForm.isPublic,
    });
    createVisible.value = false;
    createForm.name = '';
    createForm.topic = '';
    await chat.loadRooms();
    emit('navigate');
    await router.push(`/rooms/${data.room.id}`);
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    busy.value = false;
  }
}

async function joinRoom() {
  const roomId = Number(joinForm.roomId);
  if (!Number.isInteger(roomId) || roomId <= 0) {
    ElMessage.warning('请输入房间 ID');
    return;
  }
  try {
    busy.value = true;
    await http.post(`/rooms/${roomId}/join`, {
      inviteCode: joinForm.inviteCode.trim() || undefined,
    });
    joinVisible.value = false;
    joinForm.roomId = '';
    joinForm.inviteCode = '';
    await chat.loadRooms();
    emit('navigate');
    await router.push(`/rooms/${roomId}`);
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <aside class="sidebar">
    <div class="sidebar-brand">
      <span class="brand-logo"><BrandMark :size="22" /></span>
      <div class="brand-copy">
        <div class="brand-name">bot-for-all</div>
        <div class="brand-sub">群聊 · AI 机器人</div>
      </div>
      <button class="icon-btn" title="个人设置" @click="profileVisible = true">
        <span class="avatar avatar-sm" :class="userAvatar">{{ userInitial }}</span>
      </button>
    </div>

    <div class="sidebar-search">
      <Icon name="search" :size="16" />
      <input v-model="query" placeholder="搜索房间" />
    </div>

    <div class="sidebar-tabs">
      <button
        class="tab"
        data-testid="tab-mine"
        :class="{ active: tab === 'mine' }"
        @click="tab = 'mine'"
      >
        我的 <span>{{ chat.rooms.mine.length }}</span>
      </button>
      <button
        class="tab"
        data-testid="tab-public"
        :class="{ active: tab === 'public' }"
        @click="tab = 'public'"
      >
        公开 <span>{{ chat.rooms.public.length }}</span>
      </button>
    </div>

    <div class="room-list">
      <button
        v-for="room in rooms"
        :key="room.id"
        class="room-card"
        data-testid="room-item"
        :class="{ active: room.id === props.activeRoomId }"
        @click="selectRoom(room)"
      >
        <span class="avatar room-avatar" :class="avatarClass(room.id)">
          {{ initialOf(room.name) }}
        </span>
        <span class="room-info">
          <span class="room-name">
            {{ room.name }}
            <span v-if="room.unreadCount" class="unread">{{ room.unreadCount }}</span>
          </span>
          <span class="room-preview">
            <template v-if="room.lastMessage">
              {{ room.lastMessage.senderName }}: {{ plainPreview(room.lastMessage.content) }}
            </template>
            <template v-else>{{ room.topic || '暂无消息' }}</template>
          </span>
        </span>
        <span class="room-side">
          <span v-if="room.lastMessage" class="room-time">
            {{ formatRelative(room.lastMessage.createdAt) }}
          </span>
          <span v-if="!room.joined" class="join-hint">加入</span>
        </span>
      </button>
      <div v-if="rooms.length === 0" class="sidebar-empty">
        <Icon name="chat" :size="22" />
        <span>{{ query ? '没有匹配的房间' : '还没有房间' }}</span>
      </div>
    </div>

    <div class="sidebar-actions">
      <button class="btn primary" data-testid="create-room" @click="createVisible = true">
        <Icon name="plus" />
        创建
      </button>
      <button class="btn ghost" @click="joinVisible = true">
        <Icon name="hash" />
        加入
      </button>
    </div>

    <button
      class="density-toggle"
      type="button"
      :title="ui.density === 'compact' ? '切换为舒适密度' : '切换为紧凑密度'"
      :aria-label="ui.density === 'compact' ? '切换为舒适密度' : '切换为紧凑密度'"
      @click="ui.toggle"
    >
      <span class="density-label">显示密度</span>
      <span class="density-value">{{ ui.density === 'compact' ? '紧凑' : '舒适' }}</span>
    </button>

    <button class="sidebar-user" @click="profileVisible = true">
      <span class="avatar avatar-sm" :class="userAvatar">{{ userInitial }}</span>
      <span class="sidebar-user-copy">
        <span class="sidebar-user-name">{{ auth.user?.displayName }}</span>
        <span class="sidebar-user-sub">@{{ auth.user?.username }}</span>
      </span>
      <Icon name="settings" :size="16" />
    </button>

    <el-dialog v-model="createVisible" title="创建房间" width="420px">
      <label class="field">
        <span>房间名</span>
        <input v-model="createForm.name" data-testid="room-name" maxlength="64" />
      </label>
      <label class="field">
        <span>话题</span>
        <input v-model="createForm.topic" maxlength="255" />
      </label>
      <label class="switch-field">
        <span>公开房间</span>
        <input v-model="createForm.isPublic" type="checkbox" />
      </label>
      <template #footer>
        <button class="btn ghost" @click="createVisible = false">取消</button>
        <button class="btn primary" data-testid="create-room-submit" :disabled="busy" @click="createRoom">
          创建
        </button>
      </template>
    </el-dialog>

    <el-dialog v-model="joinVisible" title="加入私密房" width="420px">
      <label class="field">
        <span>房间 ID</span>
        <input v-model="joinForm.roomId" placeholder="例如 1" />
      </label>
      <label class="field">
        <span>邀请码</span>
        <input v-model="joinForm.inviteCode" placeholder="8 位邀请码" />
      </label>
      <template #footer>
        <button class="btn ghost" @click="joinVisible = false">取消</button>
        <button class="btn primary" :disabled="busy" @click="joinRoom">加入</button>
      </template>
    </el-dialog>

    <ProfileDialog v-model="profileVisible" />
  </aside>
</template>
