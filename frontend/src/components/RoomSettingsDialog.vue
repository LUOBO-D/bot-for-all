<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import axios from 'axios';
import { ElMessage, ElMessageBox } from 'element-plus';
import { toDataURL as qrToDataURL } from 'qrcode';
import http, { errorMessage } from '../api/http';
import { useAuthStore } from '../stores/auth';
import { useChatStore } from '../stores/chat';
import type { JoinRequest, Member, RoomSummary } from '../types';
import { formatRelative } from '../utils/format';
import Icon from './Icon.vue';

const props = defineProps<{ modelValue: boolean; roomId: number }>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();

const router = useRouter();
const auth = useAuthStore();
const chat = useChatStore();
const saving = ref(false);
const muteBusy = ref(false);
const form = reactive({
  name: '',
  topic: '',
  announcement: '',
  slowModeSeconds: 0,
  retentionDays: 0,
});

const SLOW_MODE_OPTIONS = [
  { value: 0, label: '关闭' },
  { value: 5, label: '每 5 秒一条' },
  { value: 10, label: '每 10 秒一条' },
  { value: 30, label: '每 30 秒一条' },
  { value: 60, label: '每 1 分钟一条' },
  { value: 300, label: '每 5 分钟一条' },
] as const;

const room = computed<RoomSummary | null>(() => {
  return (
    chat.rooms.mine.find((item) => item.id === props.roomId) ??
    chat.rooms.public.find((item) => item.id === props.roomId) ??
    chat.currentRoom
  );
});

// Slow mode is a fixed set of intervals; a room that got some other value
// through the API keeps it as an extra option so the picker never shows blank.
const slowModeChoices = computed(() => {
  const options: { value: number; label: string }[] = SLOW_MODE_OPTIONS.map((option) => ({
    value: option.value,
    label: option.label,
  }));
  const current = room.value?.slowModeSeconds ?? 0;
  if (current > 0 && !options.some((option) => option.value === current)) {
    options.push({ value: current, label: `每 ${current} 秒一条` });
  }
  return options.sort((a, b) => a.value - b.value);
});

const canEdit = computed(() => {
  if (!room.value || !auth.user) {
    return false;
  }
  return auth.user.role === 'admin' || room.value.ownerId === auth.user.id;
});

// Room moderators (room_members.role='admin') may edit the announcement but
// never the room identity fields.
const canEditAnnouncement = computed(() => {
  if (canEdit.value) {
    return true;
  }
  const userId = auth.user?.id;
  if (userId == null) {
    return false;
  }
  return (chat.members[props.roomId] ?? []).some(
    (member) => member.userId === userId && member.role === 'admin',
  );
});

// Handing the room over is owner-only: a global admin may edit the room but
// the server still refuses the transfer, so the block is hidden for them.
const isOwner = computed(() => {
  if (!room.value || !auth.user) {
    return false;
  }
  return room.value.ownerId === auth.user.id;
});

// The same people who may edit the announcement (owner, room admin, global
// admin) are the ones the server allows to review join requests.
const canManageJoinRequests = computed(() => canEditAnnouncement.value);

const joinRequests = ref<JoinRequest[]>([]);
const requestsLoading = ref(false);
const requestBusy = ref<number | null>(null);
const selectedJoinUsers = ref<Set<number>>(new Set());
const joinBulkBusy = ref(false);

const allJoinSelected = computed(
  () =>
    joinRequests.value.length > 0 &&
    selectedJoinUsers.value.size === joinRequests.value.length,
);

const someJoinSelected = computed(
  () => selectedJoinUsers.value.size > 0 && !allJoinSelected.value,
);

const joinBulkDisabled = computed(
  () => joinBulkBusy.value || requestBusy.value !== null || selectedJoinUsers.value.size === 0,
);

function toggleJoinSelection(userId: number, event: Event) {
  const checked = (event.target as HTMLInputElement).checked;
  const next = new Set(selectedJoinUsers.value);
  if (checked) {
    next.add(userId);
  } else {
    next.delete(userId);
  }
  selectedJoinUsers.value = next;
}

function toggleSelectAllJoinRequests(event: Event) {
  selectedJoinUsers.value = (event.target as HTMLInputElement).checked
    ? new Set(joinRequests.value.map((request) => request.userId))
    : new Set();
}

async function loadJoinRequests() {
  if (!canManageJoinRequests.value) {
    return;
  }
  requestsLoading.value = true;
  try {
    const { data } = await http.get<{ requests: JoinRequest[] }>(
      `/rooms/${props.roomId}/requests`,
    );
    joinRequests.value = data.requests;
    // A reload may follow another moderator's decision; keep only ids still
    // present so the selection can never target a vanished request.
    selectedJoinUsers.value = new Set(
      [...selectedJoinUsers.value].filter((userId) =>
        data.requests.some((request) => request.userId === userId),
      ),
    );
  } catch (error) {
    joinRequests.value = [];
    selectedJoinUsers.value = new Set();
    ElMessage.error(errorMessage(error));
  } finally {
    requestsLoading.value = false;
  }
}

async function decideJoinRequest(request: JoinRequest, approve: boolean) {
  if (requestBusy.value !== null || joinBulkBusy.value) {
    return;
  }
  requestBusy.value = request.userId;
  try {
    await http.post(
      `/rooms/${props.roomId}/requests/${request.userId}/${approve ? 'approve' : 'reject'}`,
    );
    ElMessage.success(
      approve
        ? `已批准 ${request.displayName} 加入`
        : `已拒绝 ${request.displayName} 的申请`,
    );
    await loadJoinRequests();
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    requestBusy.value = null;
  }
}

/** Decides every ticked request at once; the server applies the batch atomically. */
async function decideJoinRequestsBulk(approve: boolean) {
  const userIds = [...selectedJoinUsers.value];
  if (userIds.length === 0 || joinBulkBusy.value || requestBusy.value !== null) {
    return;
  }
  const label = approve ? '批准' : '拒绝';
  try {
    await ElMessageBox.confirm(
      `确定${label}选中的 ${userIds.length} 条申请？`,
      '批量处理加入申请',
      { confirmButtonText: label, cancelButtonText: '取消', type: 'warning' },
    );
  } catch {
    return;
  }
  joinBulkBusy.value = true;
  try {
    const { data } = await http.post<{ updated: number }>(
      `/rooms/${props.roomId}/requests/bulk`,
      { userIds, action: approve ? 'approve' : 'reject' },
    );
    ElMessage.success(`已${label} ${data.updated} 条申请`);
    selectedJoinUsers.value = new Set();
    await loadJoinRequests();
    await chat.refreshMembers(props.roomId);
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    joinBulkBusy.value = false;
  }
}

// Inviting by username is the moderator shortcut around the join-request
// queue: the server checks the target is an active human and not already in.
// The box accepts several names at once; commas, spaces and newlines all
// separate entries, and a leading @ is optional.
const inviteUsername = ref('');
const inviteBusy = ref(false);

function parseInviteUsernames(raw: string): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const token of raw.split(/[\s,，]+/)) {
    const name = token.trim().replace(/^@+/, '');
    if (!name) {
      continue;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    names.push(name);
  }
  return names;
}

async function inviteMember() {
  const usernames = parseInviteUsernames(inviteUsername.value);
  if (usernames.length === 0 || inviteBusy.value) {
    return;
  }
  inviteBusy.value = true;
  try {
    if (usernames.length === 1) {
      const { data } = await http.post<{ member: Member }>(`/rooms/${props.roomId}/members`, {
        username: usernames[0],
      });
      ElMessage.success(`已邀请 @${data.member.username || usernames[0]}`);
    } else {
      // The bulk endpoint is all-or-nothing, so a rejection never leaves the
      // room with only part of the list invited.
      const { data } = await http.post<{ invited: number }>(
        `/rooms/${props.roomId}/members/bulk`,
        { usernames },
      );
      ElMessage.success(`已邀请 ${data.invited} 名成员`);
    }
    inviteUsername.value = '';
    await chat.refreshMembers(props.roomId);
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    inviteBusy.value = false;
  }
}

// Opening the dialog (or the room changing while it is open) refreshes the
// pending list. Moderators only become known after the roster arrives, so the
// permission flag is part of the trigger too.
watch(
  () => [props.modelValue, props.roomId, canManageJoinRequests.value] as const,
  ([open]) => {
    if (!open) {
      return;
    }
    void loadJoinRequests();
  },
  { immediate: true },
);

// Only human members can own a room, and transferring to yourself is a no-op.
const transferCandidates = computed(() =>
  (chat.members[props.roomId] ?? []).filter(
    (member) => member.type === 'human' && member.userId !== auth.user?.id,
  ),
);
const transferTarget = ref(0);
const transferBusy = ref(false);

const roomLink = computed(() => {
  const base = `${window.location.origin}/rooms/${props.roomId}`;
  if (room.value && !room.value.isPublic && room.value.inviteCode) {
    return `${base}?invite=${encodeURIComponent(room.value.inviteCode)}`;
  }
  return base;
});

// A QR code only makes sense for a private room that actually handed out a
// code; public rooms are joinable straight from the list.
const hasInviteQr = computed(
  () => Boolean(room.value && !room.value.isPublic && room.value.inviteCode),
);

const INVITE_QR_SIZE = 180;
const inviteQrDataUrl = ref('');

// Every render bumps the token, so a slow render for a superseded link (or one
// that lands after the dialog unmounted) can never overwrite the current code.
let inviteQrToken = 0;
let inviteQrDisposed = false;

async function renderInviteQr(link: string, active: boolean) {
  const token = ++inviteQrToken;
  inviteQrDataUrl.value = '';
  if (!active) {
    return;
  }
  try {
    const dataUrl = await qrToDataURL(link, {
      width: INVITE_QR_SIZE,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#1a1a1a', light: '#ffffff' },
    });
    if (inviteQrDisposed || token !== inviteQrToken) {
      return;
    }
    inviteQrDataUrl.value = dataUrl;
  } catch {
    if (inviteQrDisposed || token !== inviteQrToken) {
      return;
    }
    // A code the encoder cannot draw (e.g. an over-long link) must never break
    // the dialog: leave the image out and keep the copy actions working.
    inviteQrDataUrl.value = '';
  }
}

// The QR is already a data URL, so saving it needs no canvas or server round
// trip; the anchor is removed immediately after the browser starts the save.
function downloadInviteQr() {
  if (!inviteQrDataUrl.value) {
    return;
  }
  const anchor = document.createElement('a');
  anchor.href = inviteQrDataUrl.value;
  anchor.download = `room-${props.roomId}-invite.png`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

// Rotation rewrites `room.inviteCode`, which flows into `roomLink`; watching
// the link keeps the image in sync without a second source of truth.
watch(
  () => [props.modelValue, hasInviteQr.value, roomLink.value] as const,
  ([open, hasCode, link]) => {
    void renderInviteQr(link, open && hasCode);
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  inviteQrDisposed = true;
  // Invalidate any in-flight render so it cannot set state after teardown.
  inviteQrToken += 1;
});

watch(
  () => [
    props.modelValue,
    room.value?.name,
    room.value?.topic,
    room.value?.announcement,
    room.value?.slowModeSeconds,
    room.value?.retentionDays,
  ],
  () => {
    if (props.modelValue && room.value) {
      form.name = room.value.name;
      form.topic = room.value.topic;
      form.announcement = room.value.announcement;
      form.slowModeSeconds = room.value.slowModeSeconds ?? 0;
      form.retentionDays = room.value.retentionDays ?? 0;
    }
  },
  { immediate: true },
);

// Preview of what the retention sweep would delete. The dialog debounces the
// draft value so a burst of keystrokes cannot flood the server, and every
// request carries a token so a slow answer for an old value can never
// overwrite the current one. A failed preview stays silent: it must never
// block editing or saving.
interface RetentionPreview {
  retentionDays: number;
  messages: number;
  oldestAt: string | null;
}

const RETENTION_PREVIEW_DEBOUNCE_MS = 400;

const retentionPreview = ref<RetentionPreview | null>(null);
const retentionPreviewPending = ref(false);
let retentionPreviewToken = 0;
let retentionPreviewTimer: ReturnType<typeof setTimeout> | null = null;

function clearRetentionPreviewTimer() {
  if (retentionPreviewTimer !== null) {
    clearTimeout(retentionPreviewTimer);
    retentionPreviewTimer = null;
  }
}

/** Draft value, or null while the input is empty or out of range. */
function retentionDraftDays(): number | null {
  const raw: unknown = form.retentionDays;
  if (raw === '' || raw === null || raw === undefined) {
    return null;
  }
  const days = Number(raw);
  return Number.isInteger(days) && days >= 0 && days <= 3650 ? days : null;
}

async function loadRetentionPreview(days: number, token: number) {
  try {
    const { data } = await http.get<RetentionPreview>(
      `/rooms/${props.roomId}/retention/preview`,
      { params: { days } },
    );
    if (token !== retentionPreviewToken) {
      return;
    }
    retentionPreview.value = data;
  } catch {
    if (token !== retentionPreviewToken) {
      return;
    }
    retentionPreview.value = null;
  } finally {
    if (token === retentionPreviewToken) {
      retentionPreviewPending.value = false;
    }
  }
}

function requestRetentionPreview(immediate = false) {
  clearRetentionPreviewTimer();
  const days = retentionDraftDays();
  if (days === null) {
    retentionPreviewToken += 1;
    retentionPreview.value = null;
    retentionPreviewPending.value = false;
    return;
  }
  // Invalidate any in-flight answer for a previous value at once, then let the
  // debounced request (or the immediate one) own the state.
  const token = ++retentionPreviewToken;
  retentionPreviewPending.value = days > 0;
  if (immediate) {
    void loadRetentionPreview(days, token);
    return;
  }
  retentionPreviewTimer = setTimeout(() => {
    retentionPreviewTimer = null;
    void loadRetentionPreview(days, token);
  }, RETENTION_PREVIEW_DEBOUNCE_MS);
}

const retentionPreviewText = computed(() => {
  if (!canEditAnnouncement.value) {
    return '';
  }
  const days = retentionDraftDays();
  if (days === null) {
    return '';
  }
  if (days === 0) {
    return '永久保留，不自动清理';
  }
  const preview = retentionPreview.value;
  if (!preview || preview.retentionDays !== days) {
    return retentionPreviewPending.value ? '正在统计…' : '';
  }
  if (preview.messages === 0) {
    return '当前设置暂无可清理消息';
  }
  const oldest = preview.oldestAt
    ? `（最早 ${new Date(preview.oldestAt).toLocaleString()}）`
    : '';
  return `当前设置将清理 ${preview.messages} 条消息${oldest}`;
});

// Opening the dialog previews the saved policy at once (the form-sync watcher
// above has already copied the room's value by the time this runs).
watch(
  () => [props.modelValue, props.roomId, canEditAnnouncement.value] as const,
  ([open]) => {
    if (!open) {
      clearRetentionPreviewTimer();
      retentionPreviewToken += 1;
      retentionPreviewPending.value = false;
      return;
    }
    if (!canEditAnnouncement.value) {
      retentionPreview.value = null;
      return;
    }
    requestRetentionPreview(true);
  },
  { immediate: true },
);

watch(
  () => form.retentionDays,
  () => {
    if (!props.modelValue || !canEditAnnouncement.value) {
      return;
    }
    requestRetentionPreview();
  },
);

onBeforeUnmount(() => {
  clearRetentionPreviewTimer();
  retentionPreviewToken += 1;
});

// The roster behind the transfer picker is fetched when the dialog opens so
// members who joined after the last room sync still show up.
watch(
  () => props.modelValue,
  (open) => {
    if (!open) {
      return;
    }
    transferTarget.value = 0;
    inviteUsername.value = '';
    void chat.refreshMembers(props.roomId).catch(() => undefined);
  },
  { immediate: true },
);

async function save() {
  const payload: {
    name?: string;
    topic?: string;
    announcement?: string;
    slowModeSeconds?: number;
    retentionDays?: number;
  } = {};
  if (canEdit.value) {
    if (!form.name.trim()) {
      ElMessage.warning('房间名不能为空');
      return;
    }
    payload.name = form.name.trim();
    payload.topic = form.topic.trim();
  }
  if (canEditAnnouncement.value) {
    payload.announcement = form.announcement.trim();
    // Room admins moderate the room, so they own its pacing as well.
    payload.slowModeSeconds = form.slowModeSeconds;
    // The input can still hold an empty/out-of-range value after typing; the
    // server rejects those with a 400, so fail here with a clear message.
    const retentionDays = Number(form.retentionDays);
    if (!Number.isInteger(retentionDays) || retentionDays < 0 || retentionDays > 3650) {
      ElMessage.warning('消息保留天数需为 0 到 3650 之间的整数');
      return;
    }
    payload.retentionDays = retentionDays;
  }
  if (Object.keys(payload).length === 0) {
    return;
  }
  saving.value = true;
  try {
    await http.patch(`/rooms/${props.roomId}`, payload);
    await chat.loadRooms();
    ElMessage.success('已保存');
    emit('update:modelValue', false);
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    saving.value = false;
  }
}

async function toggleMute(event: Event) {
  const input = event.target as HTMLInputElement;
  if (!room.value || muteBusy.value) {
    return;
  }
  muteBusy.value = true;
  try {
    const muted = await chat.setRoomMuted(props.roomId, input.checked);
    ElMessage.success(muted ? '已开启消息免打扰' : '已关闭消息免打扰');
  } catch (error) {
    input.checked = room.value.muted;
    ElMessage.error(errorMessage(error));
  } finally {
    muteBusy.value = false;
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

const rotateBusy = ref(false);

// Rotation invalidates the code the moment the server answers, so the confirm
// spells out that already-shared links stop working.
async function rotateInviteCode() {
  if (rotateBusy.value || !room.value) {
    return;
  }
  try {
    await ElMessageBox.confirm(
      '重新生成后旧邀请码立即失效，已经分享出去的邀请链接将无法再加入。确定继续？',
      '重新生成邀请码',
      { confirmButtonText: '重新生成', cancelButtonText: '取消', type: 'warning' },
    );
  } catch {
    return;
  }
  rotateBusy.value = true;
  try {
    const { data } = await http.post<{ inviteCode: string }>(
      `/rooms/${props.roomId}/invite-code/rotate`,
    );
    for (const list of [chat.rooms.mine, chat.rooms.public]) {
      const target = list.find((item) => item.id === props.roomId);
      if (target) {
        target.inviteCode = data.inviteCode;
      }
    }
    ElMessage.success('已生成新的邀请码');
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    rotateBusy.value = false;
  }
}

// Exporting streams the whole room history as a file download. The server
// answers with an attachment blob, so the click path builds an object URL for
// an <a download> and releases it as soon as the browser has taken it.
const exportBusy = ref<'markdown' | 'json' | 'zip' | null>(null);

/**
 * Errors from the export arrive as JSON, but `responseType: 'blob'` wraps the
 * body in a Blob, so `errorMessage` would only see the status code. Reading
 * the body back keeps the server's explanation ("over the 100-file export
 * limit") in the toast.
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

async function exportHistory(format: 'markdown' | 'json' | 'zip') {
  if (exportBusy.value !== null) {
    return;
  }
  exportBusy.value = format;
  let objectUrl: string | null = null;
  try {
    const { data } = await http.get<Blob>(`/rooms/${props.roomId}/export`, {
      params: { format },
      responseType: 'blob',
    });
    objectUrl = URL.createObjectURL(data);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    const extension = format === 'json' ? 'json' : format === 'zip' ? 'zip' : 'md';
    anchor.download = `room-${props.roomId}.${extension}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } catch (error) {
    ElMessage.error(await exportErrorText(error));
  } finally {
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
    }
    exportBusy.value = null;
  }
}

async function transferOwner() {
  const target = transferCandidates.value.find((member) => member.userId === transferTarget.value);
  if (!target || transferBusy.value) {
    return;
  }
  try {
    await ElMessageBox.confirm(
      `将「${room.value?.name ?? '该房间'}」的房主转让给「${target.displayName}」？转让后你将成为普通成员。`,
      '转让房主',
      { confirmButtonText: '转让', cancelButtonText: '取消', type: 'warning' },
    );
  } catch {
    return;
  }
  transferBusy.value = true;
  try {
    await http.post(`/rooms/${props.roomId}/transfer`, { userId: target.userId });
    await chat.loadRooms();
    ElMessage.success('已转让房主');
    emit('update:modelValue', false);
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    transferBusy.value = false;
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
      <label class="field">
        <span>公告</span>
        <textarea
          v-model="form.announcement"
          :disabled="!canEditAnnouncement"
          maxlength="2000"
          rows="4"
          placeholder="向全房间展示的公告，最多 2000 字"
        />
      </label>
      <label class="field">
        <span>慢速模式</span>
        <select
          v-model.number="form.slowModeSeconds"
          data-testid="slow-mode-select"
          :disabled="!canEditAnnouncement"
        >
          <option
            v-for="choice in slowModeChoices"
            :key="choice.value"
            :value="choice.value"
          >
            {{ choice.label }}
          </option>
        </select>
      </label>
      <p class="settings-hint">
        开启后同一成员在间隔内只能发送一条消息，发送过快会被服务端拒绝并提示剩余秒数。
      </p>
      <label class="field">
        <span>消息保留</span>
        <input
          v-model.number="form.retentionDays"
          data-testid="retention-days"
          type="number"
          min="0"
          max="3650"
          step="1"
          inputmode="numeric"
          :disabled="!canEditAnnouncement"
        />
      </label>
      <p class="settings-hint">
        按天保留普通消息，0 表示永久保留；置顶消息不会被清理。清理按周期执行，删除可能有延迟。
      </p>
      <p
        v-if="retentionPreviewText"
        class="settings-hint"
        data-testid="retention-preview"
      >
        {{ retentionPreviewText }}
      </p>

      <div v-if="room.joined" class="settings-section">
        <div class="settings-label">通知</div>
        <label class="switch-field">
          <span>消息免打扰</span>
          <input
            type="checkbox"
            :checked="room.muted"
            :disabled="muteBusy"
            @change="toggleMute"
          />
        </label>
        <p class="settings-hint">开启后该房间的未读不再提醒，消息仍会正常接收。</p>
      </div>

      <div v-if="room.joined" class="settings-section" data-testid="export-room">
        <div class="settings-label">导出聊天记录</div>
        <p class="settings-hint">
          下载本房间的历史消息，最多包含最近 5000 条；ZIP 会一并打包未撤回消息的附件（至多 100
          个、合计不超过 200 MiB），缺失文件自动跳过。
        </p>
        <button
          class="btn ghost small"
          data-testid="export-md"
          :disabled="exportBusy !== null"
          @click="exportHistory('markdown')"
        >
          {{ exportBusy === 'markdown' ? '导出中…' : 'Markdown' }}
        </button>
        <button
          class="btn ghost small"
          data-testid="export-json"
          :disabled="exportBusy !== null"
          @click="exportHistory('json')"
        >
          {{ exportBusy === 'json' ? '导出中…' : 'JSON' }}
        </button>
        <button
          class="btn ghost small"
          data-testid="export-zip"
          :disabled="exportBusy !== null"
          @click="exportHistory('zip')"
        >
          {{ exportBusy === 'zip' ? '导出中…' : 'ZIP（含附件）' }}
        </button>
      </div>

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
          <div v-if="inviteQrDataUrl" class="invite-qr">
            <img
              data-testid="invite-qr"
              alt="邀请二维码"
              :src="inviteQrDataUrl"
              :width="INVITE_QR_SIZE"
              :height="INVITE_QR_SIZE"
            />
            <p class="settings-hint">扫码打开带邀请码的房间链接。</p>
            <button
              class="btn ghost small invite-qr-download"
              type="button"
              data-testid="invite-qr-download"
              @click="downloadInviteQr"
            >
              <Icon name="arrowDown" :size="14" />
              下载二维码
            </button>
          </div>
          <button
            v-if="canEdit"
            class="btn ghost small"
            data-testid="rotate-invite"
            :disabled="rotateBusy"
            @click="rotateInviteCode"
          >
            {{ rotateBusy ? '生成中…' : '重新生成邀请码' }}
          </button>
        </template>
      </div>

      <div v-if="canManageJoinRequests" class="settings-section" data-testid="join-requests">
        <div class="settings-label">加入申请</div>
        <div v-if="requestsLoading && joinRequests.length === 0" class="settings-hint">
          加载中…
        </div>
        <div v-else-if="joinRequests.length === 0" class="settings-hint">
          暂无待处理申请
        </div>
        <div v-else class="join-request-list">
          <div class="join-bulk-bar">
            <label class="join-check">
              <input
                type="checkbox"
                data-testid="join-select-all"
                :checked="allJoinSelected"
                :indeterminate="someJoinSelected"
                :disabled="joinBulkBusy || requestBusy !== null"
                @change="toggleSelectAllJoinRequests"
              />
              <span>全选（{{ joinRequests.length }}）</span>
            </label>
            <span class="settings-hint" data-testid="join-selected-count">
              已选 {{ selectedJoinUsers.size }} 条
            </span>
          </div>
          <div
            v-for="request in joinRequests"
            :key="request.userId"
            class="join-request-row"
            data-testid="join-request-row"
          >
            <input
              type="checkbox"
              class="join-select"
              data-testid="join-select"
              :checked="selectedJoinUsers.has(request.userId)"
              :disabled="joinBulkBusy || requestBusy !== null"
              :aria-label="`选择申请：${request.displayName}`"
              @change="toggleJoinSelection(request.userId, $event)"
            />
            <div class="join-request-main">
              <span class="join-request-name">{{ request.displayName }}</span>
              <span class="join-request-meta">
                @{{ request.username }} · {{ formatRelative(request.createdAt) }}
              </span>
            </div>
            <div class="join-request-actions">
              <button
                class="btn primary small"
                data-testid="join-approve"
                :disabled="requestBusy !== null || joinBulkBusy"
                @click="decideJoinRequest(request, true)"
              >
                批准
              </button>
              <button
                class="btn ghost small"
                data-testid="join-reject"
                :disabled="requestBusy !== null || joinBulkBusy"
                @click="decideJoinRequest(request, false)"
              >
                拒绝
              </button>
            </div>
          </div>
          <div class="join-bulk-actions">
            <button
              class="btn primary small"
              data-testid="join-bulk-approve"
              :disabled="joinBulkDisabled"
              @click="decideJoinRequestsBulk(true)"
            >
              {{ joinBulkBusy ? '处理中…' : '批量批准' }}
            </button>
            <button
              class="btn ghost small"
              data-testid="join-bulk-reject"
              :disabled="joinBulkDisabled"
              @click="decideJoinRequestsBulk(false)"
            >
              批量拒绝
            </button>
          </div>
        </div>
      </div>

      <div v-if="canManageJoinRequests" class="settings-section" data-testid="invite-member">
        <div class="settings-label">邀请成员</div>
        <p class="settings-hint">
          输入对方的用户名，可以直接把对方拉进房间。多个用户名可用逗号、空格或换行分隔。
        </p>
        <div class="inline-row">
          <textarea
            v-model="inviteUsername"
            class="inline-input invite-input"
            data-testid="invite-username"
            rows="2"
            placeholder="用户名，例如 alice, bob"
            :disabled="inviteBusy"
            @keydown.enter.exact.prevent="inviteMember"
          />
          <button
            class="btn primary"
            data-testid="invite-submit"
            :disabled="inviteBusy || !inviteUsername.trim()"
            @click="inviteMember"
          >
            {{ inviteBusy ? '邀请中…' : '邀请' }}
          </button>
        </div>
      </div>

      <div v-if="isOwner" class="settings-section">
        <div class="settings-label">转让房主</div>
        <p class="settings-hint">
          转让后你将变为普通成员，仅新房主可修改房间名与话题。
        </p>
        <div class="inline-row">
          <select
            v-model.number="transferTarget"
            class="inline-input"
            data-testid="transfer-select"
            :disabled="transferBusy || transferCandidates.length === 0"
          >
            <option :value="0" disabled>
              {{ transferCandidates.length === 0 ? '暂无可转让的人类成员' : '选择新房东' }}
            </option>
            <option
              v-for="member in transferCandidates"
              :key="member.userId"
              :value="member.userId"
            >
              {{ member.displayName }}
            </option>
          </select>
          <button
            class="btn danger"
            data-testid="transfer-submit"
            :disabled="transferBusy || !transferTarget"
            @click="transferOwner"
          >
            {{ transferBusy ? '转让中…' : '转让' }}
          </button>
        </div>
      </div>

      <div v-if="!canEdit" class="settings-hint">
        房管可编辑公告、慢速模式与消息保留；房间名与话题仅房主或全局管理员可修改。
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
      <button
        v-if="canEdit || canEditAnnouncement"
        class="btn primary"
        :disabled="saving"
        @click="save"
      >
        {{ saving ? '保存中…' : '保存' }}
      </button>
    </template>
  </el-dialog>
</template>

<style scoped>
/* The invite section carries two small actions side by side; the compiler
   drops the whitespace between them, so the gap is explicit. */
.settings-section > .btn + .btn {
  margin-left: 6px;
}

/* The QR sits between the copy buttons and keeps a white quiet zone so it
   still scans on the dark theme. */
.invite-qr {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  margin: 10px 0 12px;
}

.invite-qr img {
  display: block;
  width: 180px;
  height: 180px;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: #fff;
}

.invite-qr .settings-hint {
  margin: 0;
}

.join-request-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.join-request-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: var(--paper-2);
}

.join-request-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1 1 auto;
}

.join-request-name {
  overflow: hidden;
  color: var(--text);
  font-size: 13px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.join-request-meta {
  overflow: hidden;
  color: var(--muted);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.join-request-actions {
  display: flex;
  flex: none;
  gap: 6px;
}

.join-bulk-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 2px;
}

.join-check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--muted);
  font-size: 12px;
  cursor: pointer;
  user-select: none;
}

.join-bulk-bar .settings-hint {
  margin: 0;
}

.join-select {
  flex: none;
  cursor: pointer;
}

.join-select:disabled {
  cursor: not-allowed;
}

.join-bulk-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 2px;
}

@media (max-width: 420px) {
  .join-request-row {
    flex-wrap: wrap;
  }

  .join-request-actions {
    width: 100%;
  }

  .join-request-actions .btn {
    flex: 1 1 0;
  }
}

.inline-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* Same skin as `.field input` so the invite box and the transfer picker match
   the inputs above. */
.inline-input {
  flex: 1 1 auto;
  min-width: 0;
  height: 36px;
  padding: 0 10px;
  border: 1px solid var(--line-strong);
  border-radius: var(--r-md);
  background: var(--paper);
  color: var(--text);
  font-size: 13px;
  outline: none;
  transition: border-color 0.12s ease-out, background 0.12s ease-out;
}

.inline-input:focus {
  border-color: var(--ink);
  background: var(--paper-2);
}

.inline-input:disabled {
  opacity: 0.6;
  cursor: not-allowed;
  background: var(--paper-3);
}

/* The invite box is a textarea so a pasted list of names keeps its line
   breaks; it reuses the inline-input skin with room for two rows. */
.invite-input {
  height: auto;
  min-height: 56px;
  padding: 8px 10px;
  font-family: inherit;
  line-height: 1.4;
  resize: vertical;
}

.inline-row .btn {
  flex: 0 0 auto;
}

/* The dialog already caps at 100vw - 24px; stack the row once the input and
   button no longer fit side by side so nothing spills out of the body. */
@media (max-width: 420px) {
  .inline-row {
    flex-wrap: wrap;
  }

  .inline-input,
  .inline-row .btn {
    flex: 1 1 100%;
    width: 100%;
  }
}
</style>
