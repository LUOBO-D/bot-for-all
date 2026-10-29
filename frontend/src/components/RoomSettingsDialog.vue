<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import http, { errorMessage } from '../api/http';
import { useAuthStore } from '../stores/auth';
import { useChatStore } from '../stores/chat';
import type { RoomSummary } from '../types';
import Icon from './Icon.vue';

const props = defineProps<{ modelValue: boolean; roomId: number }>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();

const router = useRouter();
const auth = useAuthStore();
const chat = useChatStore();
const saving = ref(false);
const form = reactive({ name: '', topic: '' });

const room = computed<RoomSummary | null>(() => {
  return (
    chat.rooms.mine.find((item) => item.id === props.roomId) ??
    chat.rooms.public.find((item) => item.id === props.roomId) ??
    chat.currentRoom
  );
});

const canEdit = computed(() => {
  if (!room.value || !auth.user) {
    return false;
  }
  return auth.user.role === 'admin' || room.value.ownerId === auth.user.id;
});

const roomLink = computed(() => {
  const base = `${window.location.origin}/rooms/${props.roomId}`;
  if (room.value && !room.value.isPublic && room.value.inviteCode) {
    return `${base}?invite=${encodeURIComponent(room.value.inviteCode)}`;
  }
  return base;
});

watch(
  () => [props.modelValue, room.value?.name, room.value?.topic],
  () => {
    if (props.modelValue && room.value) {
      form.name = room.value.name;
      form.topic = room.value.topic;
    }
  },
  { immediate: true },
);

async function save() {
  if (!form.name.trim()) {
    ElMessage.warning('房间名不能为空');
    return;
  }
  saving.value = true;
  try {
    await http.patch(`/rooms/${props.roomId}`, {
      name: form.name.trim(),
      topic: form.topic.trim(),
    });
    await chat.loadRooms();
    ElMessage.success('已保存');
    emit('update:modelValue', false);
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    saving.value = false;
  }
}

async function copy(value: string, label: string) {
  try {
    await navigator.clipboard.writeText(value);
    ElMessage.success(`${label}已复制`);
  } catch {
    ElMessage.info(value);
  }
}

async function leaveRoom() {
  if (!room.value) {
    return;
  }
  try {
    await ElMessageBox.confirm(`确定离开「${room.value.name}」？`, '离开房间', {
      confirmButtonText: '离开',
      cancelButtonText: '取消',
      type: 'warning',
    });
  } catch {
    return;
  }
  try {
    await http.post(`/rooms/${props.roomId}/leave`);
    chat.unwatchRoom(props.roomId);
    chat.closeRoom();
    await chat.loadRooms();
    emit('update:modelValue', false);
    await router.push('/rooms');
  } catch (error) {
    ElMessage.error(errorMessage(error));
  }
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="房间设置"
    width="480px"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div v-if="room" class="settings">
      <div class="settings-hero">
        <div class="settings-avatar">{{ room.name.slice(0, 1).toUpperCase() }}</div>
        <div>
          <div class="settings-name">{{ room.name }}</div>
          <div class="settings-sub">
            {{ room.memberCount }} 位成员 · {{ room.isPublic ? '公开房间' : '私密房间' }}
          </div>
        </div>
      </div>

      <label class="field">
        <span>房间名</span>
        <input v-model="form.name" :disabled="!canEdit" maxlength="64" />
      </label>
      <label class="field">
        <span>话题</span>
        <input v-model="form.topic" :disabled="!canEdit" maxlength="255" />
      </label>

      <div class="settings-section">
        <div class="settings-label">邀请</div>
        <template v-if="room.isPublic">
          <p class="settings-hint">公开房间会出现在「公开」列表里，任何人可直接加入。</p>
        </template>
        <template v-else>
          <div class="invite-row">
            <code>{{ room.inviteCode ?? '仅房主可见' }}</code>
            <button
              v-if="room.inviteCode"
              class="icon-btn"
              title="复制邀请码"
              @click="copy(room.inviteCode, '邀请码')"
            >
              <Icon name="copy" :size="16" />
            </button>
          </div>
          <button class="btn ghost small" @click="copy(roomLink, '链接')">
            <Icon name="link" :size="15" />
            复制房间链接
          </button>
        </template>
      </div>

      <div v-if="!canEdit && !room.isPublic" class="settings-hint">
        只有房主可以修改房间信息。
      </div>
    </div>

    <template #footer>
      <button
        v-if="room && auth.user?.id !== room.ownerId"
        class="btn danger"
        @click="leaveRoom"
      >
        离开房间
      </button>
      <span class="spacer" />
      <button class="btn ghost" @click="emit('update:modelValue', false)">关闭</button>
      <button v-if="canEdit" class="btn primary" :disabled="saving" @click="save">
        {{ saving ? '保存中…' : '保存' }}
      </button>
    </template>
  </el-dialog>
</template>
