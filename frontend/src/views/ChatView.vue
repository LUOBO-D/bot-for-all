<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import BotDialog from '../components/BotDialog.vue';
import Composer from '../components/Composer.vue';
import Icon from '../components/Icon.vue';
import MemberList from '../components/MemberList.vue';
import MessageList from '../components/MessageList.vue';
import RoomSettingsDialog from '../components/RoomSettingsDialog.vue';
import RoomSidebar from '../components/RoomSidebar.vue';
import { errorMessage } from '../api/http';
import { useAuthStore } from '../stores/auth';
import { useChatStore } from '../stores/chat';
import type { Message } from '../types';
import { avatarClass, formatTime, initialOf, plainPreview } from '../utils/format';

const route = useRoute();
const auth = useAuthStore();
const chat = useChatStore();

const sidebarOpen = ref(false);
const membersOpen = ref(false);
const botVisible = ref(false);
const settingsVisible = ref(false);
const pinsOpen = ref(false);
const pinnedMessages = ref<Message[]>([]);
const pinnedLoading = ref(false);
const replyTarget = ref<Message | null>(null);
const editingMessage = ref<Message | null>(null);
const searchOpen = ref(false);
const searchQuery = ref('');
const searchResults = ref<Message[]>([]);
const searching = ref(false);
const highlightSeq = ref<number | null>(null);
let searchTimer: number | undefined;
let highlightTimer: number | undefined;
let searchRequestId = 0;

const roomId = computed(() => Number(route.params.id));
const inviteCode = computed(() =>
  typeof route.query.invite === 'string' ? route.query.invite : undefined,
);
const room = computed(() => chat.currentRoom);
const roomInitial = computed(() => initialOf(room.value?.name ?? 'R'));
const canModerate = computed(() => {
  if (!room.value || !auth.user) {
    return false;
  }
  return auth.user.role === 'admin' || room.value.ownerId === auth.user.id;
});
const typingText = computed(() =>
  chat.typingUsers
    .filter((user) => user.userId !== auth.user?.id)
    .map((user) => user.displayName)
    .join('、'),
);

function handleSend(content: string, done: (ok: boolean) => void) {
  const editing = editingMessage.value;
  if (editing) {
    chat.editMessage(roomId.value, editing.seq, content).then(
      () => {
        done(true);
        editingMessage.value = null;
      },
      (error: unknown) => {
        done(false);
        ElMessage.error(errorMessage(error));
      },
    );
    return;
  }
  const target = replyTarget.value;
  chat.send(
    content,
    (ok) => {
      done(ok);
      if (ok) {
        replyTarget.value = null;
      }
    },
    target?.id,
  );
}

function setReply(message: Message) {
  editingMessage.value = null;
  replyTarget.value = message;
}

function clearReply() {
  replyTarget.value = null;
}

function startEdit(message: Message) {
  replyTarget.value = null;
  editingMessage.value = message;
}

function cancelEdit() {
  editingMessage.value = null;
}

async function handleDelete(message: Message) {
  try {
    await ElMessageBox.confirm(
      '删除后消息会显示为「消息已撤回」，确定删除？',
      '删除消息',
      { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' },
    );
  } catch {
    return;
  }
  try {
    await chat.deleteMessage(roomId.value, message.seq);
    if (editingMessage.value?.seq === message.seq) {
      editingMessage.value = null;
    }
  } catch (error) {
    ElMessage.error(errorMessage(error));
  }
}

async function handleReact(message: Message, emoji: string) {
  try {
    await chat.toggleReaction(roomId.value, message.seq, emoji);
  } catch (error) {
    ElMessage.error(errorMessage(error));
  }
}

async function handlePin(message: Message, pinned: boolean) {
  try {
    const updated = await chat.pinMessage(roomId.value, message.seq, pinned);
    if (pinned) {
      if (!pinnedMessages.value.some((item) => item.seq === updated.seq)) {
        pinnedMessages.value = [updated, ...pinnedMessages.value];
      }
    } else {
      pinnedMessages.value = pinnedMessages.value.filter((item) => item.seq !== updated.seq);
    }
  } catch (error) {
    ElMessage.error(errorMessage(error));
  }
}

async function loadPins() {
  pinnedLoading.value = true;
  try {
    pinnedMessages.value = await chat.loadPinned(roomId.value);
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    pinnedLoading.value = false;
  }
}

function togglePins() {
  pinsOpen.value = !pinsOpen.value;
  if (pinsOpen.value) {
    void loadPins();
  }
}

function loadOlder() {
  return chat.loadOlder(roomId.value);
}

function toggleSearch() {
  searchOpen.value = !searchOpen.value;
  if (!searchOpen.value) {
    searchQuery.value = '';
    searchResults.value = [];
  }
}

watch(searchQuery, (value) => {
  window.clearTimeout(searchTimer);
  if (!value.trim()) {
    searchRequestId += 1;
    searchResults.value = [];
    searching.value = false;
    return;
  }
  searchTimer = window.setTimeout(async () => {
    const requestId = (searchRequestId += 1);
    searching.value = true;
    try {
      const results = await chat.searchMessages(roomId.value, value.trim());
      if (requestId !== searchRequestId) {
        return;
      }
      searchResults.value = results;
    } catch {
      if (requestId === searchRequestId) {
        searchResults.value = [];
      }
    } finally {
      if (requestId === searchRequestId) {
        searching.value = false;
      }
    }
  }, 250);
});

async function jumpTo(seq: number) {
  await chat.loadAround(roomId.value, seq);
  await nextTick();
  highlightSeq.value = seq;
  const element = document.querySelector(`[data-seq="${seq}"]`);
  element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  window.clearTimeout(highlightTimer);
  highlightTimer = window.setTimeout(() => {
    highlightSeq.value = null;
  }, 2200);
}

async function jumpToResult(message: Message) {
  searchOpen.value = false;
  searchQuery.value = '';
  searchResults.value = [];
  await jumpTo(message.seq);
}

async function jumpToPinned(message: Message) {
  pinsOpen.value = false;
  await jumpTo(message.seq);
}

onUnmounted(() => {
  window.clearTimeout(searchTimer);
  window.clearTimeout(highlightTimer);
});

onMounted(async () => {
  chat.bind();
  try {
    await chat.loadRooms();
  } catch {
    // room loading errors are surfaced by openRoom
  }
  await chat.openRoom(roomId.value, inviteCode.value);
});

watch([roomId, inviteCode], async ([next, invite], [previous, previousInvite]) => {
  if (next && (next !== previous || invite !== previousInvite)) {
    replyTarget.value = null;
    editingMessage.value = null;
    pinsOpen.value = false;
    pinnedMessages.value = [];
    searchOpen.value = false;
    searchQuery.value = '';
    searchResults.value = [];
    await chat.openRoom(next, invite);
  }
});

onUnmounted(() => {
  chat.closeRoom();
});
</script>

<template>
  <div class="app-layout chat-layout">
    <RoomSidebar
      class="desktop-sidebar"
      :active-room-id="roomId"
      @navigate="sidebarOpen = false"
    />

    <main class="chat-main">
      <header class="chat-topbar">
        <button class="icon-btn mobile-only" title="房间列表" @click="sidebarOpen = true">
          <Icon name="menu" />
        </button>
        <span class="avatar room-avatar" :class="avatarClass(roomId)">
          {{ roomInitial }}
        </span>
        <div class="chat-title">
          <h1>{{ room?.name ?? '房间' }}</h1>
          <p class="chat-meta">
            {{ chat.currentOnline.length }} 在线 · {{ chat.currentMembers.length }} 成员
            <span v-if="room?.topic">· {{ room.topic }}</span>
          </p>
        </div>
        <span class="spacer"></span>
        <button class="icon-btn" title="置顶消息" aria-label="置顶消息" @click="togglePins">
          <Icon name="pin" />
        </button>
        <button class="icon-btn" title="搜索消息" aria-label="搜索消息" @click="toggleSearch">
          <Icon name="search" />
        </button>
        <button class="icon-btn" title="成员" @click="membersOpen = true">
          <Icon name="users" />
        </button>
        <button
          v-if="canModerate"
          class="icon-btn"
          title="机器人"
          aria-label="机器人"
          @click="botVisible = true"
        >
          <Icon name="bot" />
        </button>
        <button class="icon-btn" title="房间设置" @click="settingsVisible = true">
          <Icon name="settings" />
        </button>
      </header>

      <div v-if="searchOpen" class="room-search-panel">
        <div class="room-search-bar">
          <Icon name="search" :size="16" />
          <input
            v-model="searchQuery"
            placeholder="搜索本房间消息"
            maxlength="100"
          />
          <button class="icon-btn small-icon" title="关闭搜索" @click="toggleSearch">
            <Icon name="close" :size="14" />
          </button>
        </div>
        <div class="room-search-results">
          <button
            v-for="message in searchResults"
            :key="message.seq"
            class="search-result"
            @click="jumpToResult(message)"
          >
            <span class="search-meta">
              {{ message.senderName }} · {{ formatTime(message.createdAt) }}
            </span>
            <span class="search-text">{{ plainPreview(message.content) }}</span>
          </button>
          <div v-if="searching" class="search-empty">搜索中…</div>
          <div v-else-if="searchQuery.trim() && !searchResults.length" class="search-empty">
            没有匹配消息
          </div>
        </div>
      </div>

      <div v-if="!chat.connected" class="connection-banner">
        <span>连接已断开，正在重连…</span>
        <button class="btn ghost small" @click="chat.reconnect">立即重连</button>
      </div>

      <div class="messages-pane">
        <MessageList
          :messages="chat.currentMessages"
          :has-more="chat.hasMore[roomId]"
          :loading-older="chat.loadingOlder[roomId]"
          :unread-marker="chat.unreadMarker[roomId]"
          :highlight-seq="highlightSeq ?? undefined"
          :can-moderate="canModerate"
          :load-older="loadOlder"
          @reply="setReply"
          @edit="startEdit"
          @delete="handleDelete"
          @react="handleReact"
          @pin="handlePin"
        />
        <div class="typing-line">
          <span v-if="typingText">{{ typingText }} 正在输入…</span>
        </div>
        <Composer
          :disabled="chat.loading || !chat.connected"
          :room-id="roomId"
          :members="chat.currentMembers"
          :reply-to="replyTarget"
          :editing="editingMessage"
          @send="handleSend"
          @typing="chat.sendTyping"
          @cancel-reply="clearReply"
          @cancel-edit="cancelEdit"
        />
      </div>
    </main>

    <aside class="members-panel">
      <MemberList :members="chat.currentMembers" />
    </aside>

    <el-drawer
      v-model="sidebarOpen"
      direction="ltr"
      size="300px"
      :with-header="false"
    >
      <RoomSidebar :active-room-id="roomId" @navigate="sidebarOpen = false" />
    </el-drawer>

    <el-drawer v-model="membersOpen" direction="rtl" size="300px" title="成员">
      <MemberList :members="chat.currentMembers" />
    </el-drawer>

    <el-drawer v-model="pinsOpen" direction="rtl" size="320px" title="置顶消息">
      <div class="pins-panel">
        <div v-if="pinnedLoading" class="pins-empty">加载中…</div>
        <div v-else-if="!pinnedMessages.length" class="pins-empty">
          还没有置顶消息
        </div>
        <div v-for="message in pinnedMessages" :key="message.seq" class="pin-card">
          <button class="pin-jump" type="button" @click="jumpToPinned(message)">
            <span class="pin-card-meta">
              {{ message.senderName }} · {{ formatTime(message.createdAt) }}
            </span>
            <span class="pin-card-text">
              {{ message.deleted ? '消息已撤回' : plainPreview(message.content) }}
            </span>
          </button>
          <button
            v-if="canModerate && !message.deleted"
            class="pin-unpin"
            type="button"
            title="取消置顶"
            @click="handlePin(message, false)"
          >
            取消置顶
          </button>
        </div>
      </div>
    </el-drawer>

    <BotDialog v-model="botVisible" :room-id="roomId" />
    <RoomSettingsDialog v-model="settingsVisible" :room-id="roomId" />
  </div>
</template>
