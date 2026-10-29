<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import http, { errorMessage } from '../api/http';
import { useAuthStore } from '../stores/auth';
import { useChatStore } from '../stores/chat';
import { initialOf, avatarClass } from '../utils/format';
import Icon from './Icon.vue';

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();

const auth = useAuthStore();
const chat = useChatStore();
const saving = ref(false);
const notifyEnabled = ref(localStorage.getItem('bfa_notify') === '1');
const notifySupported = typeof Notification !== 'undefined';
const form = reactive({ displayName: auth.user?.displayName ?? '' });

const initial = computed(() => initialOf(auth.user?.displayName ?? '?'));
const avatar = computed(() => avatarClass(auth.user?.id ?? 0));

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      form.displayName = auth.user?.displayName ?? '';
    }
  },
);

async function toggleNotify(event: Event) {
  const input = event.target as HTMLInputElement;
  if (!input.checked) {
    notifyEnabled.value = false;
    localStorage.removeItem('bfa_notify');
    return;
  }
  if (!notifySupported) {
    notifyEnabled.value = false;
    input.checked = false;
    ElMessage.warning('当前浏览器不支持桌面通知');
    return;
  }
  const permission = await Notification.requestPermission();
  if (permission === 'granted') {
    notifyEnabled.value = true;
    localStorage.setItem('bfa_notify', '1');
    ElMessage.success('已开启桌面通知');
  } else {
    notifyEnabled.value = false;
    input.checked = false;
    ElMessage.warning('通知权限未授予');
  }
}

async function save() {
  if (!form.displayName.trim()) {
    ElMessage.warning('显示名不能为空');
    return;
  }
  saving.value = true;
  try {
    const { data } = await http.patch<{ user: typeof auth.user }>('/auth/me', {
      displayName: form.displayName.trim(),
    });
    if (data.user) {
      auth.user = data.user;
    }
    ElMessage.success('已保存');
    emit('update:modelValue', false);
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    saving.value = false;
  }
}

async function logout() {
  try {
    await ElMessageBox.confirm('确定退出登录？', '退出', {
      confirmButtonText: '退出',
      cancelButtonText: '取消',
      type: 'warning',
    });
  } catch {
    return;
  }
  chat.closeRoom();
  auth.logout();
  window.location.href = '/login';
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="个人设置"
    width="420px"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="profile-head">
      <div class="avatar avatar-lg" :class="avatar">
        {{ initial }}
      </div>
      <div>
        <div class="profile-name">{{ auth.user?.displayName }}</div>
        <div class="profile-sub">@{{ auth.user?.username }}</div>
      </div>
    </div>

    <label class="field">
      <span>显示名</span>
      <input v-model="form.displayName" maxlength="64" />
    </label>

    <label class="switch-field notify-field">
      <span class="notify-copy">
        <strong>桌面通知</strong>
        <small>标签页在后台时提醒新消息</small>
      </span>
      <input
        type="checkbox"
        :checked="notifyEnabled"
        :disabled="!notifySupported"
        @change="toggleNotify"
      />
    </label>

    <template #footer>
      <button class="btn ghost" @click="logout">
        <Icon name="logout" />
        退出登录
      </button>
      <button class="btn primary" :disabled="saving" @click="save">
        {{ saving ? '保存中…' : '保存' }}
      </button>
    </template>
  </el-dialog>
</template>
