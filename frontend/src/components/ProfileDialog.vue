<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import axios from 'axios';
import { ElMessage, ElMessageBox } from 'element-plus';
import http, { errorMessage } from '../api/http';
import { useAuthStore } from '../stores/auth';
import { useChatStore } from '../stores/chat';
import type { NotificationSettings } from '../types';
import Icon from './Icon.vue';
import UserAvatar from './UserAvatar.vue';
import { themeMode, setTheme, type ThemeMode } from '../theme';

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();

const auth = useAuthStore();
const chat = useChatStore();
const saving = ref(false);
const notifyEnabled = ref(localStorage.getItem('bfa_notify') === '1');
// Purely local: no server field, so the choice follows this browser only.
const notifySound = ref(localStorage.getItem('bfa_notify_sound') === '1');
const notifySupported = typeof Notification !== 'undefined';
// Mirrors the store while the dialog is open; committed only by the DND save
// button, so a half-edited window never leaks into the suppression check.
const dnd = reactive({
  start: chat.dndStart ?? '',
  end: chat.dndEnd ?? '',
  allowMentions: chat.dndAllowMentions,
});
const savingDnd = ref(false);
const form = reactive({
  displayName: auth.user?.displayName ?? '',
  statusEmoji: auth.user?.statusEmoji ?? '',
  statusText: auth.user?.statusText ?? '',
});
const pwd = reactive({ current: '', next: '', confirm: '' });
const changingPwd = ref(false);
const loggingOutAll = ref(false);
const exportingData = ref(false);
const exportingZip = ref(false);
const themeOptions: { value: ThemeMode; label: string }[] = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
];
const notifyModeOptions: { value: NotificationSettings['notifyMode']; label: string }[] = [
  { value: 'all', label: '全部消息' },
  { value: 'mention', label: '仅提及' },
];

const avatarInput = ref<HTMLInputElement | null>(null);
const uploadingAvatar = ref(false);
const removingAvatar = ref(false);
const avatarBusy = computed(() => uploadingAvatar.value || removingAvatar.value);

const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

const statusPreview = computed(() =>
  [form.statusEmoji.trim(), form.statusText.trim()].filter(Boolean).join(' '),
);

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      form.displayName = auth.user?.displayName ?? '';
      form.statusEmoji = auth.user?.statusEmoji ?? '';
      form.statusText = auth.user?.statusText ?? '';
      pwd.current = '';
      pwd.next = '';
      pwd.confirm = '';
      dnd.start = chat.dndStart ?? '';
      dnd.end = chat.dndEnd ?? '';
      dnd.allowMentions = chat.dndAllowMentions;
      notifySound.value = localStorage.getItem('bfa_notify_sound') === '1';
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

// The beep is a per-device convenience, not an account setting: the store
// reads this key at play time, so the change applies to the next toast.
function toggleNotifySound(event: Event) {
  const input = event.target as HTMLInputElement;
  notifySound.value = input.checked;
  if (input.checked) {
    localStorage.setItem('bfa_notify_sound', '1');
  } else {
    localStorage.removeItem('bfa_notify_sound');
  }
}

// The store owns the optimistic update and its rollback; this only reports a
// rejected PATCH. The value itself comes from the server-synced chat state, so
// opening the dialog needs no extra request.
async function changeNotifyMode(mode: NotificationSettings['notifyMode']) {
  if (chat.notifyMode === mode) {
    return;
  }
  try {
    await chat.setNotifyMode(mode);
  } catch (error) {
    ElMessage.error(errorMessage(error));
  }
}

// Clearing both times turns DND off. The server validates the pair as one
// value; checking here first keeps a half-filled form from a pointless round
// trip. Errors surface as a toast and leave the store (the real source of
// truth) untouched.
async function saveDndWindow() {
  const start = dnd.start || null;
  const end = dnd.end || null;
  if ((start === null) !== (end === null)) {
    ElMessage.warning('请同时填写开始和结束时间');
    return;
  }
  if (start !== null && start === end) {
    ElMessage.warning('开始和结束时间不能相同');
    return;
  }
  savingDnd.value = true;
  try {
    await chat.saveDnd(start, end, dnd.allowMentions);
    ElMessage.success(start === null ? '已关闭免打扰' : '免打扰时段已保存');
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    savingDnd.value = false;
  }
}

async function save() {
  if (!form.displayName.trim()) {
    ElMessage.warning('显示名不能为空');
    return;
  }
  // Empty input clears the status: the server stores NULL for both fields.
  const statusEmoji = form.statusEmoji.trim();
  const statusText = form.statusText.trim();
  saving.value = true;
  try {
    const { data } = await http.patch<{ user: typeof auth.user }>('/auth/me', {
      displayName: form.displayName.trim(),
      statusEmoji: statusEmoji || null,
      statusText: statusText || null,
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

// The server owns the random token, so both calls write its returned URL
// straight into the session; every avatar of the current user re-renders from
// this one field.
function applyAvatar(avatar: string | null) {
  if (!auth.user) {
    return;
  }
  auth.user = { ...auth.user, avatar };
}

function pickAvatar() {
  if (avatarBusy.value) {
    return;
  }
  avatarInput.value?.click();
}

function onAvatarPicked(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0] ?? null;
  // Clear immediately: picking the same file again must still fire `change`.
  input.value = '';
  if (!file) {
    return;
  }
  void uploadAvatar(file);
}

// The size guard keeps an oversized file from leaving the browser at all
// (same pattern as attachments); the accepted formats are the server's call,
// so its 400 message reaches the user through the shared error toast.
async function uploadAvatar(file: File) {
  if (avatarBusy.value) {
    return;
  }
  if (file.size > AVATAR_MAX_BYTES) {
    ElMessage.error('头像不能超过 2 MB');
    return;
  }
  uploadingAvatar.value = true;
  try {
    const body = new FormData();
    body.append('file', file);
    const { data } = await http.post<{ avatar: string }>('/me/avatar', body);
    applyAvatar(data.avatar);
    ElMessage.success('头像已更新');
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    uploadingAvatar.value = false;
  }
}

async function removeAvatar() {
  if (avatarBusy.value) {
    return;
  }
  removingAvatar.value = true;
  try {
    const { data } = await http.delete<{ avatar: null }>('/me/avatar');
    applyAvatar(data.avatar);
    ElMessage.success('头像已移除');
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    removingAvatar.value = false;
  }
}

async function changePassword() {
  if (!pwd.current) {
    ElMessage.warning('请输入当前密码');
    return;
  }
  if (pwd.next.length < 8 || pwd.next.length > 72) {
    ElMessage.warning('新密码长度需为 8-72 个字符');
    return;
  }
  if (pwd.next === pwd.current) {
    ElMessage.warning('新密码不能与当前密码相同');
    return;
  }
  if (pwd.next !== pwd.confirm) {
    ElMessage.warning('两次输入的新密码不一致');
    return;
  }
  changingPwd.value = true;
  try {
    // Bare axios instead of the shared `http` instance: its response
    // interceptor treats every 401 as an expired session and redirects to
    // /login, but a wrong current password is also a 401 — that has to
    // surface as a form error here, not as a forced logout.
    const token = localStorage.getItem('bfa_token');
    const { data } = await axios.post<{ ok: true; token: string }>(
      '/api/auth/password',
      { currentPassword: pwd.current, newPassword: pwd.next },
      token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
    );
    // The change bumps the account's token version, so every previously issued
    // token dies — including this tab's. The server returns a replacement for
    // the current session; adopt it to stay logged in here.
    auth.updateToken(data.token);
    pwd.current = '';
    pwd.next = '';
    pwd.confirm = '';
    ElMessage.success('密码已修改');
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    changingPwd.value = false;
  }
}

async function logoutAll() {
  try {
    await ElMessageBox.confirm(
      '退出其他设备？其他设备上的登录会立即失效，当前设备保持在线。',
      '退出其他设备',
      {
        confirmButtonText: '退出其他设备',
        cancelButtonText: '取消',
        type: 'warning',
      },
    );
  } catch {
    return;
  }
  loggingOutAll.value = true;
  try {
    // Shared `http` is safe here: unlike the password form this request has no
    // user-supplied credential, so a 401 genuinely means the session is dead.
    const { data } = await http.post<{ ok: true; token: string }>('/auth/logout-all');
    auth.updateToken(data.token);
    ElMessage.success('其他设备已退出');
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    loggingOutAll.value = false;
  }
}

/**
 * Errors from the export arrive as JSON, but `responseType: 'blob'` wraps the
 * body in a Blob, so `errorMessage` would only see the status code. Reading
 * the body back keeps the server's explanation (for example a rate-limit
 * message) in the toast; anything else falls back to the shared helper.
 */
async function exportErrorText(error: unknown): Promise<string> {
  if (axios.isAxiosError(error) && error.response?.data instanceof Blob) {
    try {
      const payload: unknown = JSON.parse(await error.response.data.text());
      if (typeof payload === 'object' && payload !== null && 'error' in payload) {
        const apiError = payload.error;
        if (
          typeof apiError === 'object' &&
          apiError !== null &&
          'message' in apiError &&
          typeof apiError.message === 'string'
        ) {
          return apiError.message;
        }
      }
    } catch {
      // Not the API's JSON (proxy page, empty body): use the generic message.
    }
  }
  return errorMessage(error);
}

// Both formats spend the same hourly server bucket, so either button disables
// both while a download is in flight.
const exportBusy = computed(() => exportingData.value || exportingZip.value);

// The endpoint requires the bearer token, so the file is fetched as a blob and
// handed to the browser through a transient object URL. Downloading is
// read-only: no form value or store state is saved or reset here.
async function exportMyData(format: 'json' | 'zip') {
  if (exportBusy.value) {
    return;
  }
  const busy = format === 'zip' ? exportingZip : exportingData;
  busy.value = true;
  let objectUrl: string | null = null;
  try {
    const { data } = await http.get<Blob>('/me/export', {
      // The JSON export keeps its original request (and stays the default).
      params: format === 'zip' ? { format } : undefined,
      responseType: 'blob',
    });
    objectUrl = URL.createObjectURL(data);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = `me-export-${auth.user?.id ?? 'me'}.${format}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    ElMessage.success(format === 'zip' ? '已导出个人数据（含附件）' : '已导出个人数据');
  } catch (error) {
    ElMessage.error(await exportErrorText(error));
  } finally {
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
    }
    busy.value = false;
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
    append-to-body
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="profile-head">
      <UserAvatar
        size="lg"
        :avatar="auth.user?.avatar ?? null"
        :id="auth.user?.id ?? null"
        :name="auth.user?.displayName ?? null"
      />
      <div>
        <div class="profile-name">{{ auth.user?.displayName }}</div>
        <div class="profile-sub">@{{ auth.user?.username }}</div>
      </div>
    </div>

    <div class="theme-field">
      <div class="theme-copy">
        <strong>头像</strong>
        <small>PNG / JPEG / WebP / GIF，不超过 2 MB</small>
      </div>
      <div class="avatar-actions">
        <button
          type="button"
          class="btn ghost small"
          data-testid="avatar-upload"
          :disabled="avatarBusy"
          @click="pickAvatar"
        >
          {{ uploadingAvatar ? '上传中…' : '更换头像' }}
        </button>
        <button
          v-if="auth.user?.avatar"
          type="button"
          class="btn ghost small"
          data-testid="avatar-remove"
          :disabled="avatarBusy"
          @click="removeAvatar"
        >
          {{ removingAvatar ? '移除中…' : '移除头像' }}
        </button>
      </div>
      <input
        ref="avatarInput"
        class="avatar-file"
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        data-testid="avatar-input"
        @change="onAvatarPicked"
      />
    </div>

    <label class="field">
      <span>显示名</span>
      <input v-model="form.displayName" maxlength="64" />
    </label>

    <div class="status-group">
      <label class="field status-emoji">
        <span>Emoji</span>
        <input v-model="form.statusEmoji" maxlength="16" placeholder="🎧" />
      </label>
      <label class="field status-text">
        <span>状态文本</span>
        <input v-model="form.statusText" maxlength="64" placeholder="专注写代码，稍后回复" />
      </label>
    </div>
    <div class="status-hint">
      <span v-if="statusPreview" class="status-preview">{{ statusPreview }}</span>
      <span v-else class="status-preview empty">留空即不展示状态</span>
    </div>

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

    <div v-if="notifyEnabled" class="theme-field notify-scope">
      <div class="theme-copy">
        <strong>通知范围</strong>
        <small>“仅提及”只在有人 @你 时提醒，其它消息不打扰</small>
      </div>
      <div class="theme-options" role="radiogroup" aria-label="通知范围">
        <button
          v-for="option in notifyModeOptions"
          :key="option.value"
          type="button"
          role="radio"
          class="btn ghost theme-option"
          :class="{ active: chat.notifyMode === option.value }"
          :aria-checked="chat.notifyMode === option.value"
          @click="changeNotifyMode(option.value)"
        >
          {{ option.label }}
        </button>
      </div>
    </div>

    <div v-if="notifyEnabled" class="theme-field notify-sound">
      <div class="theme-copy">
        <strong>提示音</strong>
        <small>通知弹出时轻响一声；只保存在本设备，不同步到其它设备</small>
      </div>
      <label class="dnd-mention">
        <input
          type="checkbox"
          :checked="notifySound"
          data-testid="notify-sound"
          @change="toggleNotifySound"
        />
        <span>播放提示音</span>
      </label>
    </div>

    <div v-if="notifyEnabled" class="theme-field dnd-field">
      <div class="theme-copy">
        <strong>免打扰时段</strong>
        <small>免打扰时段内不弹桌面通知；留空两个时间即关闭，开始晚于结束表示跨午夜</small>
      </div>
      <div class="dnd-times">
        <label class="field">
          <span>开始</span>
          <input v-model="dnd.start" type="time" data-testid="dnd-start" />
        </label>
        <label class="field">
          <span>结束</span>
          <input v-model="dnd.end" type="time" data-testid="dnd-end" />
        </label>
      </div>
      <label class="dnd-mention">
        <input
          v-model="dnd.allowMentions"
          type="checkbox"
          data-testid="dnd-allow-mentions"
        />
        <span>免打扰时段内仍然提醒 @提及</span>
      </label>
      <button
        class="btn ghost dnd-submit"
        data-testid="dnd-save"
        :disabled="savingDnd"
        @click="saveDndWindow"
      >
        {{ savingDnd ? '保存中…' : '保存免打扰时段' }}
      </button>
    </div>

    <div class="theme-field">
      <div class="theme-copy">
        <strong>主题</strong>
        <small>跟随系统会随系统外观实时切换</small>
      </div>
      <div class="theme-options" role="radiogroup" aria-label="主题">
        <button
          v-for="option in themeOptions"
          :key="option.value"
          type="button"
          role="radio"
          class="btn ghost theme-option"
          :class="{ active: themeMode === option.value }"
          :aria-checked="themeMode === option.value"
          @click="setTheme(option.value)"
        >
          {{ option.label }}
        </button>
      </div>
    </div>

    <div class="theme-field pwd-field">
      <div class="theme-copy">
        <strong>修改密码</strong>
        <small>修改后其他设备需重新登录，当前设备保持在线</small>
      </div>
      <label class="field">
        <span>当前密码</span>
        <input
          v-model="pwd.current"
          type="password"
          autocomplete="current-password"
          maxlength="72"
        />
      </label>
      <label class="field">
        <span>新密码</span>
        <input
          v-model="pwd.next"
          type="password"
          autocomplete="new-password"
          maxlength="72"
          placeholder="8-72 个字符"
        />
      </label>
      <label class="field">
        <span>确认新密码</span>
        <input
          v-model="pwd.confirm"
          type="password"
          autocomplete="new-password"
          maxlength="72"
        />
      </label>
      <button class="btn primary pwd-submit" :disabled="changingPwd" @click="changePassword">
        {{ changingPwd ? '修改中…' : '修改密码' }}
      </button>
    </div>

    <div class="theme-field session-field">
      <div class="theme-copy">
        <strong>其他设备</strong>
        <small>退出后其他设备上的登录立即失效，当前设备保持在线</small>
      </div>
      <button
        class="btn ghost session-submit"
        data-testid="logout-all"
        :disabled="loggingOutAll"
        @click="logoutAll"
      >
        {{ loggingOutAll ? '退出中…' : '退出其他设备' }}
      </button>
    </div>

    <div class="theme-field export-field">
      <div class="theme-copy">
        <strong>导出我的数据</strong>
        <small>
          下载个人资料、加入的房间、自己发送的消息、收藏和通知；压缩包额外包含这些消息的附件文件
        </small>
      </div>
      <button
        type="button"
        class="btn ghost session-submit"
        data-testid="me-export"
        :disabled="exportBusy"
        :aria-busy="exportingData"
        @click="exportMyData('json')"
      >
        {{ exportingData ? '导出中…' : '导出我的数据' }}
      </button>
      <button
        type="button"
        class="btn ghost session-submit export-zip"
        data-testid="me-export-zip"
        :disabled="exportBusy"
        :aria-busy="exportingZip"
        @click="exportMyData('zip')"
      >
        {{ exportingZip ? '打包中…' : '导出含附件压缩包' }}
      </button>
    </div>

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

<style scoped>
.avatar-actions {
  display: flex;
  gap: 8px;
}

/* The real control is the styled button above; the input only opens the
   picker and is driven by tests via data-testid. */
.avatar-file {
  display: none;
}

.status-group {
  display: flex;
  gap: 8px;
}

.status-group .field {
  margin-bottom: 0;
  min-width: 0;
}

.status-emoji {
  flex: 0 0 88px;
}

.status-emoji input {
  text-align: center;
}

.status-text {
  flex: 1;
}

.status-hint {
  margin: 6px 0 12px;
  min-height: 15px;
  line-height: 1.4;
}

.status-preview {
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: bottom;
  font-size: var(--fs-mono);
  color: var(--muted);
}

.status-preview.empty {
  color: var(--faint);
}

.theme-field {
  margin: 14px 0 2px;
  padding: 12px 0 0;
  border-top: 1px solid var(--line);
}

.theme-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 8px;
}

.theme-copy strong {
  font-size: var(--fs-body);
  font-weight: 700;
  line-height: 1.4;
}

.theme-copy small {
  color: var(--muted);
  font-size: var(--fs-sub);
  line-height: 1.45;
}

.theme-options {
  display: flex;
  gap: 8px;
}

.theme-option {
  flex: 1;
  height: 32px;
  padding: 0 8px;
}

.theme-option.active,
.theme-option.active:hover {
  background: var(--ink);
  border-color: var(--ink);
  color: var(--on-ink);
}

.notify-scope {
  margin-top: 8px;
  padding-top: 0;
  border-top: 0;
}

.pwd-field {
  padding-bottom: 2px;
}

.pwd-submit,
.session-submit {
  width: 100%;
  justify-content: center;
}

.export-zip {
  margin-top: 8px;
}

.dnd-times {
  display: flex;
  gap: 8px;
}

.dnd-times .field {
  flex: 1;
  margin-bottom: 0;
  min-width: 0;
}

.dnd-mention {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
  color: var(--muted);
  font-size: var(--fs-sub);
  cursor: pointer;
}

.dnd-mention input {
  margin: 0;
}

.dnd-submit {
  width: 100%;
  justify-content: center;
  margin-top: 10px;
}
</style>
