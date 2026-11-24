<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import http, { errorMessage } from '../api/http';
import { useAuthStore } from '../stores/auth';
import type { AdminAnnouncement, AdminUser, AuditEntry, Bot } from '../types';
import Icon from '../components/Icon.vue';
import UserAvatar from '../components/UserAvatar.vue';

const PAGE_SIZE = 50;

const router = useRouter();
const auth = useAuthStore();

type AdminTab = 'overview' | 'users' | 'rooms' | 'bots' | 'reports' | 'audit';

const tab = ref<AdminTab>('overview');

/* ---------------- overview ---------------- */

interface TrendPoint {
  date: string;
  users: number;
  messages: number;
  rooms: number;
  bots: number;
}

interface AdminStats {
  users: { total: number; active: number; banned: number; admins: number };
  rooms: { total: number; public: number; private: number };
  messages: { total: number; deleted: number };
  bots: { total: number; enabled: number };
  reports?: { open: number; resolved: number; dismissed: number; total: number };
  trend?: TrendPoint[];
  /** Same series over the equally long window just before `trend`. */
  previous?: { users: number; messages: number; rooms: number; bots: number };
}

interface StatGroup {
  key: string;
  title: string;
  items: { label: string; value: number }[];
}

const stats = ref<AdminStats | null>(null);
const statsLoading = ref(false);
const statsExporting = ref(false);

const statGroups = computed<StatGroup[]>(() => {
  const data = stats.value;
  if (!data) {
    return [];
  }
  return [
    {
      key: 'users',
      title: '用户',
      items: [
        { label: '总数', value: data.users.total },
        { label: '活跃', value: data.users.active },
        { label: '封禁', value: data.users.banned },
        { label: '管理员', value: data.users.admins },
      ],
    },
    {
      key: 'rooms',
      title: '房间',
      items: [
        { label: '总数', value: data.rooms.total },
        { label: '公开', value: data.rooms.public },
        { label: '私有', value: data.rooms.private },
      ],
    },
    {
      key: 'messages',
      title: '消息',
      items: [
        { label: '总数', value: data.messages.total },
        { label: '已撤回', value: data.messages.deleted },
      ],
    },
    {
      key: 'bots',
      title: '机器人',
      items: [
        { label: '总数', value: data.bots.total },
        { label: '启用', value: data.bots.enabled },
      ],
    },
    {
      key: 'reports',
      title: '举报',
      items: [
        { label: '待处理', value: data.reports?.open ?? 0 },
        { label: '已处理', value: data.reports?.resolved ?? 0 },
        { label: '已忽略', value: data.reports?.dismissed ?? 0 },
        { label: '总数', value: data.reports?.total ?? 0 },
      ],
    },
  ];
});

/** Selectable windows of daily buckets; the server accepts 7..30, default 14. */
const TREND_DAYS_OPTIONS = [7, 14, 30] as const;

/** Window of daily buckets requested from `/admin/stats`; drives cards, trend and export. */
const trendDays = ref<number>(14);

// Guards against out-of-order responses when the range is switched quickly.
let statsRequest = 0;

async function loadStats() {
  const request = (statsRequest += 1);
  statsLoading.value = true;
  try {
    // One request feeds both the snapshot cards and the trend panel.
    const { data } = await http.get<AdminStats>('/admin/stats', {
      params: { days: trendDays.value },
    });
    if (request === statsRequest) {
      stats.value = data;
    }
  } catch (error) {
    if (request === statsRequest) {
      ElMessage.error(errorMessage(error));
    }
  } finally {
    if (request === statsRequest) {
      statsLoading.value = false;
    }
  }
}

// Picking another range refetches immediately; the trend copy, skeleton and
// export read the same `trendDays` value, so they follow along without extra state.
watch(trendDays, () => {
  void loadStats();
});

// Downloads the same window the trend panel renders. The server already names
// the attachment `admin-trend-<days>d.csv`; pinning it here keeps the saved
// name stable when the response is handed to the browser as a blob.
async function exportStats() {
  if (statsExporting.value) {
    return;
  }
  const days = trendDays.value;
  statsExporting.value = true;
  try {
    const { data } = await http.get<Blob>('/admin/stats/export', {
      params: { days },
      responseType: 'blob',
    });
    saveBlob(data, `admin-trend-${days}d.csv`);
    ElMessage.success(`已导出最近 ${days} 天趋势数据`);
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    statsExporting.value = false;
  }
}

/* ---------------- overview: trend ---------------- */

interface TrendSeries {
  key: Exclude<keyof TrendPoint, 'date'>;
  label: string;
  color: string;
}

const trendSeries: TrendSeries[] = [
  { key: 'users', label: '新用户', color: 'var(--ink)' },
  { key: 'messages', label: '消息', color: 'var(--rust)' },
  { key: 'rooms', label: '房间', color: 'var(--lime)' },
  { key: 'bots', label: '机器人', color: 'var(--muted)' },
];

const trendPoints = computed<TrendPoint[]>(() => stats.value?.trend ?? []);

/** Peak of each metric across the window; kept for the per-series legend tooltip. */
const trendSeriesMax = computed<Record<TrendSeries['key'], number>>(() => {
  const peaks: Record<TrendSeries['key'], number> = { users: 0, messages: 0, rooms: 0, bots: 0 };
  for (const point of trendPoints.value) {
    for (const series of trendSeries) {
      if (point[series.key] > peaks[series.key]) {
        peaks[series.key] = point[series.key];
      }
    }
  }
  return peaks;
});

const trendHasData = computed(() =>
  trendSeries.some((series) => trendSeriesMax.value[series.key] > 0),
);

/** One shared ceiling: every metric is a daily count, so a single scale keeps
 *  the four series directly comparable (a messages spike now visibly dwarfs
 *  a users bump instead of each bar filling its own track). */
const trendScaleMax = computed(() =>
  Math.max(0, ...trendSeries.map((series) => trendSeriesMax.value[series.key])),
);

// Half of the shared ceiling labels the mid guide; odd peaks read as "N.5",
// which is exact for a count axis.
const trendScaleMid = computed(() => trendScaleMax.value / 2);

function trendBarHeight(value: number): string {
  if (!trendScaleMax.value || value <= 0) {
    return '0%';
  }
  // Keep tiny non-zero days visible instead of collapsing into the baseline.
  return `${Math.max((value / trendScaleMax.value) * 100, 2)}%`;
}

/** `2026-10-20` -> `10-20`; falls back to the raw value for unexpected input. */
function trendDayLabel(date: string): string {
  return date.length >= 10 ? date.slice(5) : date;
}

/** Only the first, middle and last days get an axis label. */
function trendTickVisible(index: number): boolean {
  const last = trendPoints.value.length - 1;
  return index === 0 || index === Math.floor(last / 2) || index === last;
}

function trendDayTitle(point: TrendPoint): string {
  const values = trendSeries.map((series) => `${series.label} ${point[series.key]}`);
  return `${point.date} · ${values.join(' · ')}`;
}

/** New rows in the current window, summed from the same daily buckets. */
const trendTotals = computed<Record<TrendSeries['key'], number>>(() => {
  const totals: Record<TrendSeries['key'], number> = { users: 0, messages: 0, rooms: 0, bots: 0 };
  for (const point of trendPoints.value) {
    for (const series of trendSeries) {
      totals[series.key] += point[series.key];
    }
  }
  return totals;
});

/** Same series over the window before the current one; missing data reads as 0. */
const trendPrevious = computed<Record<TrendSeries['key'], number>>(() => {
  const previous = stats.value?.previous;
  return {
    users: previous?.users ?? 0,
    messages: previous?.messages ?? 0,
    rooms: previous?.rooms ?? 0,
    bots: previous?.bots ?? 0,
  };
});

/** `本期 N · 前 N 天 M` for one series; the second N is the range in days. */
function trendCompareText(key: TrendSeries['key']): string {
  return `本期 ${trendTotals.value[key]} · 前 ${trendDays.value} 天 ${trendPrevious.value[key]}`;
}

/**
 * Signed change against the previous window. A zero baseline has no meaningful
 * ratio, so it renders as an em dash instead of a fake 100%.
 */
function trendDelta(key: TrendSeries['key']): string {
  const previous = trendPrevious.value[key];
  if (previous === 0) {
    return '—';
  }
  const percent = Math.round(((trendTotals.value[key] - previous) / previous) * 1000) / 10;
  return `${percent > 0 ? '+' : ''}${percent}%`;
}

/** Tone for the delta: up / down / flat (also covers the no-baseline dash). */
function trendDeltaTone(key: TrendSeries['key']): string {
  const previous = trendPrevious.value[key];
  if (previous === 0 || trendTotals.value[key] === previous) {
    return 'is-flat';
  }
  return trendTotals.value[key] > previous ? 'is-up' : 'is-down';
}

/* ---------------- announcements ---------------- */

/** Matches `announcements.body` and the route's validation on the server. */
const ANNOUNCEMENT_BODY_MAX = 1000;

const announcements = ref<AdminAnnouncement[]>([]);
const announcementsLoading = ref(false);
const announcementBody = ref('');
const announcementPublishing = ref(false);
const announcementBusyId = ref<number | null>(null);
const announcementEditingId = ref<number | null>(null);

async function loadAnnouncements() {
  announcementsLoading.value = true;
  try {
    const { data } = await http.get<{ announcements: AdminAnnouncement[] }>(
      '/admin/announcements',
    );
    announcements.value = data.announcements;
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    announcementsLoading.value = false;
  }
}

async function publishAnnouncement() {
  const body = announcementBody.value.trim();
  if (!body) {
    ElMessage.warning('公告内容不能为空');
    return;
  }
  try {
    await ElMessageBox.confirm(
      '发布后所有成员都会在页面顶部看到这条公告，可以随时停用。',
      '发布平台公告',
      { confirmButtonText: '发布', cancelButtonText: '取消', type: 'warning' },
    );
  } catch {
    return;
  }
  announcementPublishing.value = true;
  try {
    await http.post('/admin/announcements', { body });
    announcementBody.value = '';
    ElMessage.success('公告已发布');
    await loadAnnouncements();
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    announcementPublishing.value = false;
  }
}

async function editAnnouncement(item: AdminAnnouncement) {
  if (announcementEditingId.value !== null) {
    return;
  }
  announcementEditingId.value = item.id;
  try {
    let body: string;
    try {
      const { value } = await ElMessageBox.prompt('修改后立即对全站生效。', '编辑公告', {
        confirmButtonText: '保存',
        cancelButtonText: '取消',
        inputValue: item.body,
        inputType: 'textarea',
        inputPlaceholder: '公告内容',
        customClass: 'announcement-edit-box',
        inputValidator: (value) => {
          const trimmed = value.trim();
          if (!trimmed) {
            return '公告内容不能为空';
          }
          if (trimmed.length > ANNOUNCEMENT_BODY_MAX) {
            return `公告内容不能超过 ${ANNOUNCEMENT_BODY_MAX} 个字符`;
          }
          return true;
        },
      });
      body = value.trim();
    } catch {
      return;
    }
    await http.patch(`/admin/announcements/${item.id}`, { body });
    await loadAnnouncements();
    ElMessage.success('已更新公告');
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    announcementEditingId.value = null;
  }
}

async function deactivateAnnouncement(item: AdminAnnouncement) {
  try {
    await ElMessageBox.confirm(
      '停用后全站不再展示这条公告，记录会保留在列表里。',
      '停用公告',
      { confirmButtonText: '停用', cancelButtonText: '取消', type: 'warning' },
    );
  } catch {
    return;
  }
  announcementBusyId.value = item.id;
  try {
    await http.delete(`/admin/announcements/${item.id}`);
    ElMessage.success('公告已停用');
    await loadAnnouncements();
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    announcementBusyId.value = null;
  }
}

/* ---------------- users ---------------- */

const users = ref<AdminUser[]>([]);
const total = ref(0);
const offset = ref(0);
const query = ref('');
const usersLoading = ref(false);
const usersExporting = ref(false);
const statusBusyId = ref<number | null>(null);
const roleBusyId = ref<number | null>(null);
const selectedUserIds = ref<number[]>([]);
const bulkBusy = ref(false);
let searchTimer: number | undefined;

const page = computed(() => Math.floor(offset.value / PAGE_SIZE) + 1);
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)));
const hasPrev = computed(() => offset.value > 0);
const hasNext = computed(() => offset.value + users.value.length < total.value);

async function loadUsers() {
  usersLoading.value = true;
  try {
    const { data } = await http.get<{
      users: AdminUser[];
      total: number;
      limit: number;
      offset: number;
    }>('/admin/users', {
      params: {
        q: query.value.trim() || undefined,
        limit: PAGE_SIZE,
        offset: offset.value,
      },
    });
    users.value = data.users;
    total.value = data.total;
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    usersLoading.value = false;
  }
}

function scheduleSearch() {
  if (searchTimer !== undefined) {
    window.clearTimeout(searchTimer);
  }
  searchTimer = window.setTimeout(() => {
    searchTimer = undefined;
    offset.value = 0;
    clearSelection();
    void loadUsers();
  }, 300);
}

// Downloads the rows for the active search; the server caps the file at 5000
// and names the attachment `users.csv`.
async function exportUsersCsv() {
  if (usersExporting.value) {
    return;
  }
  const q = query.value.trim() || undefined;
  usersExporting.value = true;
  try {
    const { data, headers } = await http.get<Blob>('/admin/users/export', {
      params: { q },
      responseType: 'blob',
    });
    saveBlob(data, 'users.csv');
    if (headers['x-users-truncated'] === 'true') {
      ElMessage.warning(
        '导出达到 5000 行上限，仅包含最新用户；请缩小搜索范围后再导出',
      );
    } else {
      ElMessage.success('已导出用户数据');
    }
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    usersExporting.value = false;
  }
}

function applySearch() {
  if (searchTimer !== undefined) {
    window.clearTimeout(searchTimer);
    searchTimer = undefined;
  }
  offset.value = 0;
  void loadUsers();
}

function turnPage(direction: -1 | 1) {
  const next = offset.value + direction * PAGE_SIZE;
  if (next < 0) {
    return;
  }
  offset.value = next;
  clearSelection();
  void loadUsers();
}

function isSelf(user: AdminUser) {
  return user.id === auth.user?.id;
}

function isBotRow(user: AdminUser) {
  return user.type === 'bot';
}

function rowLocked(user: AdminUser) {
  return isSelf(user) || isBotRow(user);
}

function lockHint(user: AdminUser) {
  if (isSelf(user)) {
    return '不能修改自己的状态';
  }
  if (isBotRow(user)) {
    return '机器人账号不支持封禁';
  }
  return '';
}

async function toggleStatus(user: AdminUser) {
  if (rowLocked(user)) {
    return;
  }
  const next = user.status === 'active' ? 'banned' : 'active';
  statusBusyId.value = user.id;
  try {
    await http.patch(`/admin/users/${user.id}/status`, { status: next });
    ElMessage.success(next === 'banned' ? '已封禁' : '已解封');
    await loadUsers();
    if (detailUserId.value === user.id) {
      await loadUserDetail(user.id);
    }
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    statusBusyId.value = null;
  }
}

function clearSelection() {
  selectedUserIds.value = [];
}

function isSelectable(user: AdminUser) {
  return !rowLocked(user);
}

const selectableUsers = computed(() => users.value.filter(isSelectable));
const allSelected = computed(
  () =>
    selectableUsers.value.length > 0 &&
    selectableUsers.value.every((user) => selectedUserIds.value.includes(user.id)),
);
const selectedCount = computed(() => selectedUserIds.value.length);

function selectUser(user: AdminUser, event: Event) {
  const checked = (event.target as HTMLInputElement).checked;
  const ids = selectedUserIds.value.filter((id) => id !== user.id);
  if (checked) {
    ids.push(user.id);
  }
  selectedUserIds.value = ids;
}

function selectAllVisible(event: Event) {
  selectedUserIds.value = (event.target as HTMLInputElement).checked
    ? selectableUsers.value.map((user) => user.id)
    : [];
}

async function bulkSetStatus(next: 'active' | 'banned') {
  const ids = [...selectedUserIds.value];
  if (ids.length === 0 || bulkBusy.value) {
    return;
  }
  const label = next === 'banned' ? '封禁' : '解封';
  try {
    await ElMessageBox.confirm(
      `确定${label}选中的 ${ids.length} 位用户？`,
      `批量${label}`,
      {
        confirmButtonText: '确认',
        cancelButtonText: '取消',
        type: 'warning',
      },
    );
  } catch {
    return;
  }
  bulkBusy.value = true;
  try {
    const { data } = await http.patch<{ updated: number; unchanged: number }>(
      '/admin/users/bulk-status',
      { userIds: ids, status: next },
    );
    const skipped = data.unchanged > 0 ? `，${data.unchanged} 位状态未变` : '';
    ElMessage.success(`已${label} ${data.updated} 位用户${skipped}`);
    clearSelection();
    await Promise.all([loadUsers(), loadStats()]);
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    bulkBusy.value = false;
  }
}

function roleLocked(user: AdminUser) {
  return isSelf(user) || isBotRow(user);
}

function roleLockHint(user: AdminUser) {
  if (isSelf(user)) {
    return '不能修改自己的角色';
  }
  if (isBotRow(user)) {
    return '机器人账号不支持角色变更';
  }
  return '';
}

async function toggleRole(user: AdminUser) {
  if (roleLocked(user)) {
    return;
  }
  const next: 'admin' | 'user' = user.role === 'admin' ? 'user' : 'admin';
  const name = user.displayName || user.username;
  try {
    await ElMessageBox.confirm(
      next === 'admin'
        ? `确定将 ${name} 设为管理员？`
        : `确定取消 ${name} 的管理员权限？`,
      next === 'admin' ? '设为管理员' : '取消管理员',
      {
        confirmButtonText: '确认',
        cancelButtonText: '取消',
        type: 'warning',
      },
    );
  } catch {
    return;
  }
  roleBusyId.value = user.id;
  try {
    await http.patch(`/admin/users/${user.id}/role`, { role: next });
    ElMessage.success(next === 'admin' ? '已设为管理员' : '已取消管理员');
    await loadUsers();
    if (detailUserId.value === user.id) {
      await loadUserDetail(user.id);
    }
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    roleBusyId.value = null;
  }
}

/* ---------------- user detail ---------------- */

interface AdminUserRoom {
  id: number;
  name: string;
  role: 'owner' | 'admin' | 'member' | 'bot' | string;
  joinedAt: string;
  memberCount: number;
}

interface AdminUserDetail {
  user: AdminUser;
  stats: { rooms: number; messages: number; bots: number };
  rooms: AdminUserRoom[];
}

const detailOpen = ref(false);
const detailLoading = ref(false);
const detailUserId = ref<number | null>(null);
const detail = ref<AdminUserDetail | null>(null);

function openUserDetail(user: AdminUser) {
  detail.value = null;
  detailUserId.value = user.id;
  detailOpen.value = true;
  void loadUserDetail(user.id);
}

async function loadUserDetail(id: number) {
  detailUserId.value = id;
  detailLoading.value = true;
  try {
    const { data } = await http.get<AdminUserDetail>(`/admin/users/${id}`);
    if (detailUserId.value !== id) {
      return;
    }
    detail.value = data;
  } catch (error) {
    if (detailUserId.value === id) {
      detail.value = null;
      ElMessage.error(errorMessage(error));
    }
  } finally {
    if (detailUserId.value === id) {
      detailLoading.value = false;
    }
  }
}

function closeUserDetail() {
  detailOpen.value = false;
}

function roleLabel(role: string) {
  switch (role) {
    case 'owner':
      return '房主';
    case 'admin':
      return '房管';
    case 'bot':
      return '机器人';
    default:
      return '成员';
  }
}

function formatCreated(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/* ---------------- rooms ---------------- */

interface AdminRoom {
  id: number;
  name: string;
  ownerId: number;
  ownerName: string;
  isPublic: boolean;
  memberCount: number;
  messageCount: number;
  createdAt: string;
}

interface AdminRoomDetail extends AdminRoom {
  topic: string;
  announcement: string;
  retentionDays: number;
  slowModeSeconds: number;
}

const rooms = ref<AdminRoom[]>([]);
const roomsTotal = ref(0);
const roomsOffset = ref(0);
const roomQuery = ref('');
const roomsLoading = ref(false);
const roomsExporting = ref(false);
const roomBusyId = ref<number | null>(null);
const selectedRoomIds = ref<number[]>([]);
const roomBulkBusy = ref(false);
const roomDetailOpen = ref(false);
const roomDetailLoading = ref(false);
const roomDetailError = ref('');
const roomDetailId = ref<number | null>(null);
const roomDetail = ref<AdminRoomDetail | null>(null);
let roomSearchTimer: number | undefined;

const roomsPage = computed(() => Math.floor(roomsOffset.value / PAGE_SIZE) + 1);
const roomsPageCount = computed(() =>
  Math.max(1, Math.ceil(roomsTotal.value / PAGE_SIZE)),
);
const hasRoomsPrev = computed(() => roomsOffset.value > 0);
const hasRoomsNext = computed(
  () => roomsOffset.value + rooms.value.length < roomsTotal.value,
);
const selectedRoomCount = computed(() => selectedRoomIds.value.length);
const allRoomsSelected = computed(
  () =>
    rooms.value.length > 0 &&
    rooms.value.every((room) => selectedRoomIds.value.includes(room.id)),
);

function clearRoomSelection() {
  selectedRoomIds.value = [];
}

function isRoomSelected(room: AdminRoom) {
  return selectedRoomIds.value.includes(room.id);
}

function selectRoom(room: AdminRoom, event: Event) {
  const checked = (event.target as HTMLInputElement).checked;
  const ids = selectedRoomIds.value.filter((id) => id !== room.id);
  if (checked) {
    ids.push(room.id);
  }
  selectedRoomIds.value = ids;
}

function selectAllRooms(event: Event) {
  selectedRoomIds.value = (event.target as HTMLInputElement).checked
    ? rooms.value.map((room) => room.id)
    : [];
}

async function loadRooms() {
  roomsLoading.value = true;
  try {
    const { data } = await http.get<{
      rooms: AdminRoom[];
      total: number;
      limit: number;
      offset: number;
    }>('/admin/rooms', {
      params: {
        q: roomQuery.value.trim() || undefined,
        limit: PAGE_SIZE,
        offset: roomsOffset.value,
      },
    });
    rooms.value = data.rooms;
    roomsTotal.value = data.total;
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    roomsLoading.value = false;
  }
}

function openRoomDetail(room: AdminRoom) {
  roomDetailId.value = room.id;
  roomDetail.value = null;
  roomDetailError.value = '';
  roomDetailOpen.value = true;
  void loadRoomDetail(room.id);
}

async function loadRoomDetail(id: number) {
  roomDetailId.value = id;
  roomDetailLoading.value = true;
  roomDetailError.value = '';
  try {
    const { data } = await http.get<{ room: AdminRoomDetail }>(`/admin/rooms/${id}`);
    if (roomDetailId.value !== id) {
      return;
    }
    roomDetail.value = data.room;
  } catch (error) {
    if (roomDetailId.value === id) {
      roomDetail.value = null;
      roomDetailError.value = errorMessage(error);
    }
  } finally {
    if (roomDetailId.value === id) {
      roomDetailLoading.value = false;
    }
  }
}

function closeRoomDetail() {
  roomDetailOpen.value = false;
}

function scheduleRoomSearch() {
  if (roomSearchTimer !== undefined) {
    window.clearTimeout(roomSearchTimer);
  }
  roomSearchTimer = window.setTimeout(() => {
    roomSearchTimer = undefined;
    roomsOffset.value = 0;
    clearRoomSelection();
    void loadRooms();
  }, 300);
}

// Downloads the rooms matching the active search, capped by the server at
// 5000 rows and named `rooms.csv`.
async function exportRoomsCsv() {
  if (roomsExporting.value) {
    return;
  }
  const q = roomQuery.value.trim() || undefined;
  roomsExporting.value = true;
  try {
    const { data, headers } = await http.get<Blob>('/admin/rooms/export', {
      params: { q },
      responseType: 'blob',
    });
    saveBlob(data, 'rooms.csv');
    if (headers['x-rooms-truncated'] === 'true') {
      ElMessage.warning(
        '导出达到 5000 行上限，仅包含最新房间；请缩小搜索范围后再导出',
      );
    } else {
      ElMessage.success('已导出房间数据');
    }
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    roomsExporting.value = false;
  }
}

function applyRoomSearch() {
  if (roomSearchTimer !== undefined) {
    window.clearTimeout(roomSearchTimer);
    roomSearchTimer = undefined;
  }
  roomsOffset.value = 0;
  clearRoomSelection();
  void loadRooms();
}

function turnRoomsPage(direction: -1 | 1) {
  const next = roomsOffset.value + direction * PAGE_SIZE;
  if (next < 0) {
    return;
  }
  roomsOffset.value = next;
  clearRoomSelection();
  void loadRooms();
}

async function removeRoom(room: AdminRoom) {
  try {
    await ElMessageBox.confirm(
      `确定删除房间「${room.name}」？房间内的 ${room.memberCount} 位成员和 ${room.messageCount} 条消息会被一并清除，且不可恢复。`,
      '删除房间',
      { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' },
    );
  } catch {
    return;
  }
  roomBusyId.value = room.id;
  try {
    await http.delete(`/admin/rooms/${room.id}`);
    ElMessage.success('房间已删除');
    if (roomDetail.value?.id === room.id) {
      closeRoomDetail();
    }
    selectedRoomIds.value = selectedRoomIds.value.filter((id) => id !== room.id);
    if (rooms.value.length === 1 && roomsOffset.value > 0) {
      roomsOffset.value = Math.max(0, roomsOffset.value - PAGE_SIZE);
    }
    await loadRooms();
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    roomBusyId.value = null;
  }
}

async function bulkRemoveRooms() {
  const ids = [...selectedRoomIds.value];
  if (ids.length === 0 || roomBulkBusy.value) {
    return;
  }
  try {
    await ElMessageBox.confirm(
      `确定删除选中的 ${ids.length} 个房间？房间内的成员、消息和附件文件会被一并清除，且不可恢复。`,
      '批量删除房间',
      { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' },
    );
  } catch {
    return;
  }
  roomBulkBusy.value = true;
  try {
    const { data } = await http.post<{ deleted: number }>('/admin/rooms/bulk-delete', {
      ids,
    });
    ElMessage.success(`已删除 ${data.deleted} 个房间`);
    clearRoomSelection();
    if (rooms.value.every((room) => ids.includes(room.id)) && roomsOffset.value > 0) {
      roomsOffset.value = Math.max(0, roomsOffset.value - PAGE_SIZE);
    }
    await Promise.all([loadRooms(), loadStats()]);
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    roomBulkBusy.value = false;
  }
}

/* ---------------- bots ---------------- */

const bots = ref<Bot[]>([]);
const botsLoading = ref(false);
const botBusyId = ref<number | null>(null);
const createVisible = ref(false);
const saving = ref(false);
const editingId = ref<number | null>(null);
const botForm = reactive({
  name: '',
  baseUrl: 'http://127.0.0.1:11434',
  apiKey: '',
  model: 'qwen3.5:9b',
  systemPrompt: '',
  triggerMode: 'mention' as 'mention' | 'all',
});

async function loadBots() {
  botsLoading.value = true;
  try {
    const { data } = await http.get<{ bots: Bot[] }>('/admin/bots');
    bots.value = data.bots;
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    botsLoading.value = false;
  }
}

async function toggleBot(bot: Bot) {
  botBusyId.value = bot.userId;
  try {
    await http.patch(`/admin/bots/${bot.userId}`, { enabled: !bot.enabled });
    ElMessage.success(bot.enabled ? '已停用' : '已启用');
    await loadBots();
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    botBusyId.value = null;
  }
}

async function removeBot(bot: Bot) {
  try {
    await ElMessageBox.confirm(
      `确定删除机器人「${bot.name}」？删除后它不会再出现在任何房间。`,
      '删除机器人',
      { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' },
    );
  } catch {
    return;
  }
  botBusyId.value = bot.userId;
  try {
    await http.delete(`/admin/bots/${bot.userId}`);
    ElMessage.success('已删除');
    await loadBots();
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    botBusyId.value = null;
  }
}

function openCreate() {
  editingId.value = null;
  botForm.name = '';
  botForm.baseUrl = 'http://127.0.0.1:11434';
  botForm.apiKey = '';
  botForm.model = 'qwen3.5:9b';
  botForm.systemPrompt = '';
  botForm.triggerMode = 'mention';
  createVisible.value = true;
}

function openEdit(bot: Bot) {
  editingId.value = bot.userId;
  botForm.name = bot.name;
  botForm.baseUrl = bot.baseUrl;
  botForm.apiKey = '';
  botForm.model = bot.model;
  botForm.systemPrompt = bot.systemPrompt;
  botForm.triggerMode = bot.triggerMode;
  createVisible.value = true;
}

async function saveBot() {
  if (!botForm.name.trim() || !botForm.baseUrl.trim() || !botForm.model.trim()) {
    ElMessage.warning('请填写名称、baseUrl、model');
    return;
  }
  const apiKey = botForm.apiKey.trim();
  if (editingId.value == null && !apiKey) {
    ElMessage.warning('新建机器人需要 API Key');
    return;
  }
  saving.value = true;
  try {
    const payload: Record<string, unknown> = {
      name: botForm.name.trim(),
      baseUrl: botForm.baseUrl.trim(),
      model: botForm.model.trim(),
      systemPrompt: botForm.systemPrompt,
      triggerMode: botForm.triggerMode,
    };
    if (apiKey) {
      payload.apiKey = apiKey;
    }
    if (editingId.value != null) {
      await http.patch(`/admin/bots/${editingId.value}`, payload);
      ElMessage.success('机器人已保存');
    } else {
      await http.post('/admin/bots', payload);
      ElMessage.success('已创建全局机器人');
    }
    createVisible.value = false;
    await loadBots();
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    saving.value = false;
  }
}

/* ---------------- reports ---------------- */

type ReportStatus = 'open' | 'resolved' | 'dismissed';

/** One row of `message_reports` joined with its message, room and people. */
interface AdminReport {
  id: number;
  messageId: number;
  messageSeq: number;
  messageContent: string;
  messageDeleted: boolean;
  roomId: number;
  roomName: string;
  reporterId: number;
  reporterName: string;
  senderId: number;
  senderName: string;
  reason: string;
  status: ReportStatus;
  createdAt: string;
  resolvedBy: number | null;
  resolvedByName: string | null;
  resolvedAt: string | null;
}

const reports = ref<AdminReport[]>([]);
const reportsTotal = ref(0);
const reportsOffset = ref(0);
// `open` is the moderation queue (the default); `all` keeps the history.
const reportFilter = ref<'open' | 'all'>('open');
const reportsLoading = ref(false);
const reportBusyId = ref<number | null>(null);
const reportExporting = ref(false);
// Selection is page-local: select-all covers only the rows currently loaded.
const selectedReportIds = ref<number[]>([]);
const reportBulkBusy = ref(false);

const reportsPage = computed(() => Math.floor(reportsOffset.value / PAGE_SIZE) + 1);
const reportsPageCount = computed(() =>
  Math.max(1, Math.ceil(reportsTotal.value / PAGE_SIZE)),
);
const hasReportsPrev = computed(() => reportsOffset.value > 0);
const hasReportsNext = computed(
  () => reportsOffset.value + reports.value.length < reportsTotal.value,
);
const allReportsSelected = computed(
  () =>
    reports.value.length > 0 &&
    reports.value.every((report) => selectedReportIds.value.includes(report.id)),
);
const selectedReportCount = computed(() => selectedReportIds.value.length);

function clearReportSelection() {
  selectedReportIds.value = [];
}

function selectReport(report: AdminReport, event: Event) {
  const checked = (event.target as HTMLInputElement).checked;
  const ids = selectedReportIds.value.filter((id) => id !== report.id);
  if (checked) {
    ids.push(report.id);
  }
  selectedReportIds.value = ids;
}

function selectAllReports(event: Event) {
  selectedReportIds.value = (event.target as HTMLInputElement).checked
    ? reports.value.map((report) => report.id)
    : [];
}

async function loadReports() {
  reportsLoading.value = true;
  try {
    const { data } = await http.get<{
      reports: AdminReport[];
      total: number;
      limit: number;
      offset: number;
    }>('/admin/reports', {
      params: {
        status: reportFilter.value,
        limit: PAGE_SIZE,
        offset: reportsOffset.value,
      },
    });
    reports.value = data.reports;
    reportsTotal.value = data.total;
    // A row that left the page (filter change, page turn, status change) must
    // not stay silently selected for a later bulk action.
    const visible = new Set(reports.value.map((report) => report.id));
    selectedReportIds.value = selectedReportIds.value.filter((id) => visible.has(id));
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    reportsLoading.value = false;
  }
}

function applyReportFilter() {
  reportsOffset.value = 0;
  clearReportSelection();
  void loadReports();
}

// Downloads the rows for the active filter; the server names the attachment
// `reports-<status>.csv` and caps it at 5000 rows.
async function exportReports() {
  if (reportExporting.value) {
    return;
  }
  const status = reportFilter.value;
  reportExporting.value = true;
  try {
    const { data, headers } = await http.get<Blob>('/admin/reports/export', {
      params: { status },
      responseType: 'blob',
    });
    saveBlob(data, `reports-${status}.csv`);
    if (headers['x-report-truncated'] === 'true') {
      ElMessage.warning('导出达到 5000 行上限，仅包含最新记录；可切换筛选后再导出');
    } else {
      ElMessage.success(status === 'open' ? '已导出待处理举报' : '已导出全部举报');
    }
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    reportExporting.value = false;
  }
}

function turnReportsPage(direction: -1 | 1) {
  const next = reportsOffset.value + direction * PAGE_SIZE;
  if (next < 0) {
    return;
  }
  reportsOffset.value = next;
  clearReportSelection();
  void loadReports();
}

async function resolveReport(report: AdminReport, status: 'resolved' | 'dismissed') {
  if (reportBusyId.value !== null || reportBulkBusy.value) {
    return;
  }
  reportBusyId.value = report.id;
  try {
    await http.patch(`/admin/reports/${report.id}`, { status });
    ElMessage.success(status === 'resolved' ? '举报已处理' : '举报已忽略');
    // Reloading (rather than patching in place) keeps both filters honest:
    // the open queue drops the row, "all" picks up resolver and timestamp.
    if (reportFilter.value === 'open' && reports.value.length === 1 && reportsOffset.value > 0) {
      reportsOffset.value = Math.max(0, reportsOffset.value - PAGE_SIZE);
    }
    await loadReports();
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    reportBusyId.value = null;
  }
}

/**
 * Handles every selected report in one all-or-nothing request. The backend
 * verifies all ids in a transaction, so a stale selection (one report row
 * removed concurrently) fails the batch instead of half-applying it.
 */
async function bulkResolveReports(status: 'resolved' | 'dismissed') {
  const ids = [...selectedReportIds.value];
  if (ids.length === 0 || reportBulkBusy.value || reportBusyId.value !== null) {
    return;
  }
  const label = status === 'resolved' ? '处理' : '忽略';
  try {
    await ElMessageBox.confirm(
      `确定${label}选中的 ${ids.length} 条举报？`,
      `批量${label}举报`,
      {
        confirmButtonText: '确认',
        cancelButtonText: '取消',
        type: 'warning',
      },
    );
  } catch {
    return;
  }
  reportBulkBusy.value = true;
  try {
    const { data } = await http.patch<{ updated: number }>('/admin/reports/bulk', {
      ids,
      status,
    });
    ElMessage.success(`已${label} ${data.updated} 条举报`);
    clearReportSelection();
    // Reload both panes: the queue drops handled rows and the overview cards
    // count them by status.
    await Promise.all([loadReports(), loadStats()]);
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    reportBulkBusy.value = false;
  }
}

function reportStatusLabel(status: ReportStatus) {
  switch (status) {
    case 'open':
      return '待处理';
    case 'resolved':
      return '已处理';
    default:
      return '已忽略';
  }
}

function reportResolverHint(report: AdminReport) {
  if (!report.resolvedByName) {
    return '';
  }
  const when = report.resolvedAt ? ` · ${formatCreated(report.resolvedAt)}` : '';
  return `由 ${report.resolvedByName} 处理${when}`;
}

/* ---------------- audit ---------------- */

const AUDIT_ACTIONS = [
  { value: 'user.status', label: '用户状态变更' },
  { value: 'user.role', label: '用户角色变更' },
  { value: 'bot.create', label: '创建机器人' },
  { value: 'bot.update', label: '更新机器人' },
  { value: 'bot.delete', label: '删除机器人' },
  { value: 'bot.mount', label: '挂载机器人' },
  { value: 'bot.unmount', label: '卸载机器人' },
  { value: 'room.delete', label: '删除房间' },
  { value: 'announcement.create', label: '发布公告' },
  { value: 'announcement.update', label: '编辑公告' },
  { value: 'announcement.delete', label: '停用公告' },
  { value: 'report.resolve', label: '处理举报' },
] as const;

const auditEntries = ref<AuditEntry[]>([]);
const auditTotal = ref(0);
const auditOffset = ref(0);
const auditAction = ref('');
const auditActor = ref('');
const auditFrom = ref('');
const auditTo = ref('');
const auditLoading = ref(false);
const auditExporting = ref(false);
const auditExportAllBusy = ref(false);

const auditPage = computed(() => Math.floor(auditOffset.value / PAGE_SIZE) + 1);
const auditPageCount = computed(() =>
  Math.max(1, Math.ceil(auditTotal.value / PAGE_SIZE)),
);
const hasAuditPrev = computed(() => auditOffset.value > 0);
const hasAuditNext = computed(
  () => auditOffset.value + auditEntries.value.length < auditTotal.value,
);
const hasAuditFilters = computed(
  () =>
    auditAction.value !== '' ||
    auditActor.value.trim() !== '' ||
    auditFrom.value !== '' ||
    auditTo.value !== '',
);
// `<input type="date">` yields `YYYY-MM-DD`, so plain string order is date order.
const auditRangeInvalid = computed(
  () =>
    auditFrom.value !== '' &&
    auditTo.value !== '' &&
    auditFrom.value > auditTo.value,
);

/** Local calendar date, matching `<input type="date">` rather than UTC. */
function localDate(offsetDays = 0): string {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;
}

function setAuditRange(days: number | null) {
  if (days === null) {
    auditFrom.value = '';
    auditTo.value = '';
  } else {
    auditFrom.value = localDate(-(days - 1));
    auditTo.value = localDate(0);
  }
  applyAuditFilter();
}

function auditRangeMatches(days: number): boolean {
  return auditFrom.value === localDate(-(days - 1)) && auditTo.value === localDate(0);
}

// Empty filters must be omitted, not sent as `actor=`; the list and the export
// share this so a download always matches the table above it.
const auditParams = computed(() => ({
  action: auditAction.value || undefined,
  actor: auditActor.value.trim() || undefined,
  from: auditFrom.value || undefined,
  to: auditTo.value || undefined,
}));

function rejectInvertedRange(): boolean {
  if (!auditRangeInvalid.value) {
    return false;
  }
  ElMessage.error('开始日期不能晚于结束日期');
  return true;
}

// Typing in the actor box re-queries like the user search does, so the filter
// applies without a separate submit.
let auditSearchTimer: number | undefined;
function scheduleAuditSearch() {
  if (auditSearchTimer !== undefined) {
    window.clearTimeout(auditSearchTimer);
  }
  auditSearchTimer = window.setTimeout(() => {
    auditSearchTimer = undefined;
    applyAuditFilter();
  }, 300);
}

async function loadAudit() {
  auditLoading.value = true;
  try {
    const { data } = await http.get<{
      entries: AuditEntry[];
      total: number;
      limit: number;
      offset: number;
    }>('/admin/audit', {
      params: {
        ...auditParams.value,
        limit: PAGE_SIZE,
        offset: auditOffset.value,
      },
    });
    auditEntries.value = data.entries;
    auditTotal.value = data.total;
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    auditLoading.value = false;
  }
}

function applyAuditFilter() {
  if (rejectInvertedRange()) {
    return;
  }
  auditOffset.value = 0;
  void loadAudit();
}

// The export honors the active filters and streams the server's
// `audit-export.csv` attachment through an object URL, same as room history.
async function exportAudit() {
  if (auditExporting.value || rejectInvertedRange()) {
    return;
  }
  auditExporting.value = true;
  try {
    const { data, headers } = await http.get<Blob>('/admin/audit/export', {
      params: auditParams.value,
      responseType: 'blob',
    });
    const truncated = headers['x-audit-truncated'] === 'true';
    saveBlob(data, 'audit-export.csv');
    if (truncated) {
      ElMessage.warning('导出达到 5000 行上限，仅包含最新记录；请缩小筛选范围后再导出');
    } else {
      ElMessage.success('已导出审计日志');
    }
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    auditExporting.value = false;
  }
}

// Hands a response blob to the browser. The object URL is revoked once the
// click has been dispatched so a download never leaks it.
function saveBlob(data: Blob, filename: string): void {
  const objectUrl = URL.createObjectURL(data);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
}

// The full export is not capped at 5000 rows, so ask first: it can be large
// and the server allows one download per admin per five minutes.
async function exportAuditAll() {
  if (auditExportAllBusy.value || rejectInvertedRange()) {
    return;
  }
  try {
    await ElMessageBox.confirm(
      '将按当前筛选导出全部审计记录，数据量可能较大，下载时间也会更长。',
      '导出全部审计日志',
      { confirmButtonText: '导出', cancelButtonText: '取消', type: 'warning' },
    );
  } catch {
    return;
  }
  auditExportAllBusy.value = true;
  try {
    const { data, headers } = await http.get<Blob>('/admin/audit/export-all', {
      params: auditParams.value,
      responseType: 'blob',
    });
    saveBlob(data, 'audit-export-all.csv');
    if (headers['x-audit-truncated'] === 'true') {
      ElMessage.warning('导出达到服务器行数上限，仅包含最新记录；请缩小筛选范围');
    } else {
      ElMessage.success('已导出全部审计日志');
    }
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    auditExportAllBusy.value = false;
  }
}

function turnAuditPage(direction: -1 | 1) {
  const next = auditOffset.value + direction * PAGE_SIZE;
  if (next < 0) {
    return;
  }
  auditOffset.value = next;
  void loadAudit();
}

function actionLabel(action: string) {
  return AUDIT_ACTIONS.find((item) => item.value === action)?.label ?? action;
}

function targetLabel(entry: AuditEntry) {
  return entry.targetId == null
    ? entry.targetType
    : `${entry.targetType} #${entry.targetId}`;
}

function formatDetail(detail: unknown) {
  if (detail === null || detail === undefined) {
    return '—';
  }
  let text: string;
  if (typeof detail === 'string') {
    text = detail;
  } else {
    try {
      text = JSON.stringify(detail);
    } catch {
      text = String(detail);
    }
  }
  text = text.replace(/\s+/g, ' ').trim();
  if (!text) {
    return '—';
  }
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

/* ---------------- lifecycle ---------------- */

function switchTab(next: AdminTab) {
  tab.value = next;
  if (next === 'overview' && !stats.value && !statsLoading.value) {
    void loadStats();
  }
  if (next === 'overview' && announcements.value.length === 0 && !announcementsLoading.value) {
    void loadAnnouncements();
  }
  if (next === 'users' && users.value.length === 0 && !usersLoading.value) {
    void loadUsers();
  }
  if (next === 'rooms' && rooms.value.length === 0 && !roomsLoading.value) {
    void loadRooms();
  }
  if (next === 'bots' && bots.value.length === 0 && !botsLoading.value) {
    void loadBots();
  }
  if (next === 'reports' && reports.value.length === 0 && !reportsLoading.value) {
    void loadReports();
  }
  if (next === 'audit' && auditEntries.value.length === 0 && !auditLoading.value) {
    void loadAudit();
  }
}

onMounted(() => {
  void loadStats();
  void loadAnnouncements();
  void loadUsers();
  void loadBots();
});

onBeforeUnmount(() => {
  if (searchTimer !== undefined) {
    window.clearTimeout(searchTimer);
  }
  if (roomSearchTimer !== undefined) {
    window.clearTimeout(roomSearchTimer);
  }
});
</script>

<template>
  <div class="admin-page">
    <div class="admin-inner">
      <header class="admin-head">
        <button class="btn ghost small" @click="router.push('/rooms')">
          <Icon name="reply" :size="14" />
          返回房间
        </button>
        <div class="admin-head-copy">
          <h1 class="admin-title">管理后台</h1>
          <p class="admin-lead">
            共 <span class="mono">{{ total }}</span> 位用户 ·
            <span class="mono">{{ bots.length }}</span> 个全局机器人
          </p>
        </div>
      </header>

      <div class="admin-tabs">
        <button
          class="admin-tab"
          data-testid="admin-overview-tab"
          :class="{ active: tab === 'overview' }"
          @click="switchTab('overview')"
        >
          概览
        </button>
        <button
          class="admin-tab"
          data-testid="admin-users-tab"
          :class="{ active: tab === 'users' }"
          @click="switchTab('users')"
        >
          用户 <span class="mono">{{ total }}</span>
        </button>
        <button
          class="admin-tab"
          data-testid="admin-rooms-tab"
          :class="{ active: tab === 'rooms' }"
          @click="switchTab('rooms')"
        >
          房间
        </button>
        <button
          class="admin-tab"
          data-testid="admin-bots-tab"
          :class="{ active: tab === 'bots' }"
          @click="switchTab('bots')"
        >
          全局机器人 <span class="mono">{{ bots.length }}</span>
        </button>
        <button
          class="admin-tab"
          data-testid="admin-reports-tab"
          :class="{ active: tab === 'reports' }"
          @click="switchTab('reports')"
        >
          举报
        </button>
        <button
          class="admin-tab"
          data-testid="admin-audit-tab"
          :class="{ active: tab === 'audit' }"
          @click="switchTab('audit')"
        >
          审计日志
        </button>
      </div>

      <!-- ============ overview ============ -->
      <section v-if="tab === 'overview'" class="admin-panel">
        <div class="admin-toolbar">
          <p class="admin-hint">全站数据快照，包含已封禁用户与已撤回消息。</p>
          <div class="toolbar-actions">
            <label class="trend-range" title="趋势统计范围">
              <span class="trend-range-label">趋势</span>
              <select
                v-model.number="trendDays"
                data-testid="admin-trend-days"
                :disabled="statsLoading"
              >
                <option v-for="days in TREND_DAYS_OPTIONS" :key="days" :value="days">
                  {{ days }} 天
                </option>
              </select>
            </label>
            <button
              class="btn ghost small"
              data-testid="admin-stats-export"
              :disabled="statsExporting"
              @click="exportStats"
            >
              导出趋势
            </button>
            <button class="btn ghost small" :disabled="statsLoading" @click="loadStats">
              刷新
            </button>
          </div>
        </div>

        <div class="stats-grid" data-testid="admin-stats">
          <article v-for="group in statGroups" :key="group.key" class="stat-card">
            <h2 class="stat-title">{{ group.title }}</h2>
            <div class="stat-items">
              <div v-for="item in group.items" :key="item.label" class="stat-item">
                <span class="stat-value mono">{{ item.value }}</span>
                <span class="stat-label">{{ item.label }}</span>
              </div>
            </div>
          </article>
        </div>

        <div v-if="statsLoading && !stats" class="admin-empty">加载中…</div>
        <div v-else-if="!stats" class="admin-empty">暂时无法获取统计数据</div>

        <section
          class="trend-panel"
          :class="{ 'is-refreshing': statsLoading && !!stats }"
          data-testid="admin-trend"
        >
          <div class="trend-head">
            <div class="trend-copy">
              <h2 class="trend-title">数据趋势</h2>
              <p class="trend-sub">
                最近 {{ trendDays }} 天每日新增，含 0 值日期；四个指标共用同一纵向刻度（左上为峰值 {{ trendScaleMax }}），跨指标可直接对比，悬停查看具体数值。
              </p>
            </div>
            <ul class="trend-legend">
              <li
                v-for="series in trendSeries"
                :key="series.key"
                class="trend-legend-item"
                :data-testid="`admin-trend-legend-${series.key}`"
                :title="`峰值 ${trendSeriesMax[series.key]}`"
              >
                <span class="trend-swatch" :style="{ background: series.color }"></span>
                {{ series.label }}
              </li>
            </ul>
          </div>

          <div v-if="statsLoading && !stats" class="trend-skeleton" aria-hidden="true">
            <span v-for="n in trendDays" :key="n" class="trend-skeleton-bar"></span>
          </div>
          <div v-else-if="trendPoints.length === 0" class="admin-empty">
            暂时无法获取趋势数据
          </div>
          <div v-else-if="!trendHasData" class="admin-empty">
            最近 {{ trendPoints.length }} 天没有新增数据
          </div>
          <div v-else class="trend-scroll">
            <div
              class="trend-chart"
              role="img"
              :aria-label="`最近 ${trendPoints.length} 天每日新增（四指标同一纵向刻度）：新用户、消息、房间、机器人`"
              :style="{ '--trend-days': trendPoints.length }"
            >
              <!-- The shared-count y axis: the guides sit at 0 / half / peak of
                   one scale for every series, so heights compare across colors. -->
              <div class="trend-axis mono" aria-hidden="true">
                <span class="trend-axis-value">{{ trendScaleMax }}</span>
                <span class="trend-axis-value">{{ trendScaleMid }}</span>
                <span class="trend-axis-value">0</span>
              </div>
              <div class="trend-body">
                <div class="trend-plot">
                  <div
                    v-for="point in trendPoints"
                    :key="point.date"
                    class="trend-day"
                    :title="trendDayTitle(point)"
                  >
                    <span
                      v-for="series in trendSeries"
                      :key="series.key"
                      class="trend-bar"
                      :style="{
                        height: trendBarHeight(point[series.key]),
                        background: series.color,
                      }"
                      :title="`${point.date} · ${series.label} ${point[series.key]}`"
                    ></span>
                  </div>
                </div>
                <div class="trend-ticks" aria-hidden="true">
                  <span
                    v-for="(point, index) in trendPoints"
                    :key="point.date"
                    class="trend-tick mono"
                    :class="{ 'is-hidden': !trendTickVisible(index) }"
                  >
                    {{ trendDayLabel(point.date) }}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div v-if="stats" class="trend-compare" data-testid="admin-compare">
            <span class="trend-compare-title">环比</span>
            <ul class="trend-compare-list">
              <li
                v-for="series in trendSeries"
                :key="series.key"
                class="trend-compare-item"
                :data-testid="`admin-compare-${series.key}`"
                :title="`${series.label} 与紧邻的前 ${trendDays} 天对比`"
              >
                <span class="trend-swatch" :style="{ background: series.color }"></span>
                <span class="trend-compare-label">{{ series.label }}</span>
                <span class="trend-compare-value mono">{{ trendCompareText(series.key) }}</span>
                <span class="trend-compare-delta mono" :class="trendDeltaTone(series.key)">
                  {{ trendDelta(series.key) }}
                </span>
              </li>
            </ul>
          </div>
        </section>

        <div class="announcement-panel">
          <div class="admin-toolbar">
            <p class="admin-hint">
              公告发布后全站登录用户都会在页面顶部看到，可以随时停用。
            </p>
            <button
              class="btn ghost small"
              :disabled="announcementsLoading"
              @click="loadAnnouncements"
            >
              刷新
            </button>
          </div>

          <div class="announcement-form">
            <label class="field">
              <span>平台公告</span>
              <textarea
                v-model="announcementBody"
                data-testid="announcement-body"
                rows="3"
                :maxlength="ANNOUNCEMENT_BODY_MAX"
                placeholder="例如：今晚 23:00 起停机维护，预计 30 分钟。"
                @keydown.ctrl.enter.prevent="publishAnnouncement"
                @keydown.meta.enter.prevent="publishAnnouncement"
              ></textarea>
            </label>
            <div class="announcement-form-foot">
              <span class="mono announcement-count">
                {{ announcementBody.trim().length }} / {{ ANNOUNCEMENT_BODY_MAX }}
              </span>
              <button
                class="btn primary small"
                data-testid="announcement-publish"
                :disabled="announcementPublishing || !announcementBody.trim()"
                @click="publishAnnouncement"
              >
                {{ announcementPublishing ? '发布中…' : '发布公告' }}
              </button>
            </div>
          </div>

          <div class="announcement-table">
            <div class="announcement-row announcement-row-head">
              <span>发布时间</span>
              <span>内容</span>
              <span>发布者</span>
              <span>状态</span>
              <span></span>
            </div>
            <div
              v-for="item in announcements"
              :key="item.id"
              class="announcement-row"
              data-testid="announcement-row"
            >
              <span class="mono announcement-time">{{ formatCreated(item.createdAt) }}</span>
              <span class="announcement-content" :title="item.body">{{ item.body }}</span>
              <span class="announcement-actor">{{ item.actorName }}</span>
              <span class="status-pill" :class="item.active ? 'active' : 'banned'">
                <span class="status-dot"></span>
                {{ item.active ? '展示中' : '已停用' }}
              </span>
              <div class="announcement-actions">
                <button
                  class="btn ghost small"
                  data-testid="announcement-edit"
                  :disabled="announcementEditingId !== null || announcementBusyId === item.id"
                  @click="editAnnouncement(item)"
                >
                  {{ announcementEditingId === item.id ? '编辑中…' : '编辑' }}
                </button>
                <button
                  class="btn ghost small"
                  data-testid="announcement-deactivate"
                  :disabled="!item.active || announcementBusyId === item.id || announcementEditingId === item.id"
                  @click="deactivateAnnouncement(item)"
                >
                  {{ announcementBusyId === item.id ? '处理中…' : '停用' }}
                </button>
              </div>
            </div>
            <div v-if="announcementsLoading" class="admin-empty">加载中…</div>
            <div v-else-if="announcements.length === 0" class="admin-empty">
              还没有发布过平台公告
            </div>
          </div>
        </div>
      </section>

      <!-- ============ users ============ -->
      <section v-else-if="tab === 'users'" class="admin-panel">
        <div class="admin-toolbar">
          <div class="admin-search">
            <Icon name="search" :size="16" />
            <input
              v-model="query"
              data-testid="admin-search"
              placeholder="搜索用户名 / 显示名"
              @input="scheduleSearch"
              @keydown.enter.prevent="applySearch"
            />
            <button
              v-if="query"
              class="icon-btn"
              title="清空"
              @click="query = ''; applySearch()"
            >
              <Icon name="close" :size="14" />
            </button>
          </div>
          <div class="toolbar-actions">
            <span v-if="selectedCount > 0" class="admin-hint">已选 {{ selectedCount }} 位</span>
            <button
              class="btn ghost small"
              data-testid="admin-users-export"
              :disabled="usersExporting"
              @click="exportUsersCsv"
            >
              {{ usersExporting ? '导出中…' : '导出 CSV' }}
            </button>
            <button
              class="btn danger small"
              data-testid="admin-bulk-ban"
              :disabled="selectedCount === 0 || bulkBusy"
              @click="bulkSetStatus('banned')"
            >
              批量封禁
            </button>
            <button
              class="btn ghost small"
              data-testid="admin-bulk-unban"
              :disabled="selectedCount === 0 || bulkBusy"
              @click="bulkSetStatus('active')"
            >
              批量解封
            </button>
            <button class="btn ghost small" :disabled="usersLoading" @click="applySearch">
              刷新
            </button>
          </div>
        </div>

        <div class="user-table">
          <div class="user-row user-row-head">
            <span class="col-check">
              <input
                type="checkbox"
                data-testid="admin-user-check-all"
                aria-label="全选用户"
                :checked="allSelected"
                :disabled="selectableUsers.length === 0 || bulkBusy"
                @change="selectAllVisible"
              />
            </span>
            <span>用户</span>
            <span class="col-type">类型</span>
            <span class="col-role">角色</span>
            <span class="col-status">状态</span>
            <span class="col-time">创建时间</span>
            <span class="col-action"></span>
          </div>

          <div
            v-for="user in users"
            :key="user.id"
            class="user-row user-row-clickable"
            data-testid="admin-user-row"
            role="button"
            tabindex="0"
            @click="openUserDetail(user)"
            @keydown.enter.self.prevent="openUserDetail(user)"
          >
            <span class="col-check" @click.stop>
              <input
                type="checkbox"
                data-testid="admin-user-check"
                :aria-label="`选择 ${user.displayName || user.username}`"
                :checked="selectedUserIds.includes(user.id)"
                :disabled="!isSelectable(user) || bulkBusy"
                :title="lockHint(user)"
                @change="selectUser(user, $event)"
              />
            </span>
            <span class="col-user">
              <UserAvatar
                size="sm"
                :avatar="user.avatar"
                :id="user.id"
                :name="user.displayName || user.username"
              />
              <span class="user-copy">
                <span class="user-name">{{ user.displayName || user.username }}</span>
                <span class="user-handle">@{{ user.username }}</span>
              </span>
            </span>
            <span class="col-type">
              <span class="tag" :class="{ muted: user.type === 'bot' }">
                {{ user.type === 'bot' ? 'BOT' : 'HUMAN' }}
              </span>
            </span>
            <span class="col-role">
              <span class="tag" :class="{ muted: user.role !== 'admin' }">
                {{ user.role === 'admin' ? 'ADMIN' : 'USER' }}
              </span>
            </span>
            <span class="col-status">
              <span
                class="status-pill"
                data-testid="admin-user-status"
                :class="user.status"
              >
                <span class="status-dot"></span>
                {{ user.status === 'banned' ? '已封禁' : '正常' }}
              </span>
            </span>
            <span class="col-time mono">{{ formatCreated(user.createdAt) }}</span>
            <span class="col-action">
              <button
                class="btn small"
                :class="user.status === 'active' ? 'danger' : 'ghost'"
                :disabled="rowLocked(user) || statusBusyId === user.id"
                :title="lockHint(user)"
                @click.stop="toggleStatus(user)"
              >
                {{
                  statusBusyId === user.id
                    ? '处理中…'
                    : user.status === 'active'
                      ? '封禁'
                      : '解封'
                }}
              </button>
            </span>
          </div>

          <div v-if="usersLoading" class="admin-empty">加载中…</div>
          <div v-else-if="users.length === 0" class="admin-empty">
            {{ query ? '没有匹配的用户' : '还没有用户' }}
          </div>
        </div>

        <div class="admin-pager">
          <span class="mono">第 {{ page }} / {{ pageCount }} 页 · 共 {{ total }} 位</span>
          <div class="pager-actions">
            <button
              class="btn ghost small"
              :disabled="!hasPrev || usersLoading"
              @click="turnPage(-1)"
            >
              上一页
            </button>
            <button
              class="btn ghost small"
              :disabled="!hasNext || usersLoading"
              @click="turnPage(1)"
            >
              下一页
            </button>
          </div>
        </div>
      </section>

      <!-- ============ rooms ============ -->
      <section v-else-if="tab === 'rooms'" class="admin-panel">
        <div class="admin-toolbar">
          <div class="admin-search">
            <Icon name="search" :size="16" />
            <input
              v-model="roomQuery"
              data-testid="admin-room-search"
              placeholder="搜索房间名称"
              @input="scheduleRoomSearch"
              @keydown.enter.prevent="applyRoomSearch"
            />
            <button
              v-if="roomQuery"
              class="icon-btn"
              title="清空"
              @click="roomQuery = ''; applyRoomSearch()"
            >
              <Icon name="close" :size="14" />
            </button>
          </div>
          <div class="toolbar-actions">
            <span v-if="selectedRoomCount > 0" class="admin-hint">
              已选 {{ selectedRoomCount }} 个
            </span>
            <button
              class="btn ghost small"
              data-testid="admin-rooms-export"
              :disabled="roomsExporting"
              @click="exportRoomsCsv"
            >
              {{ roomsExporting ? '导出中…' : '导出 CSV' }}
            </button>
            <button
              class="btn danger small"
              data-testid="admin-room-bulk-delete"
              :disabled="selectedRoomCount === 0 || roomBulkBusy"
              @click="bulkRemoveRooms"
            >
              {{ roomBulkBusy ? '删除中…' : '批量删除' }}
            </button>
            <button class="btn ghost small" :disabled="roomsLoading" @click="applyRoomSearch">
              刷新
            </button>
          </div>
        </div>

        <div class="room-table">
          <div class="room-row room-row-head">
            <span class="col-check">
              <input
                type="checkbox"
                data-testid="admin-room-check-all"
                aria-label="全选房间"
                :checked="allRoomsSelected"
                :disabled="rooms.length === 0 || roomBulkBusy"
                @change="selectAllRooms"
              />
            </span>
            <span>名称</span>
            <span>房主</span>
            <span class="col-num">成员</span>
            <span class="col-num">消息</span>
            <span class="col-type">类型</span>
            <span class="col-time">创建时间</span>
            <span class="col-action"></span>
          </div>

          <div
            v-for="room in rooms"
            :key="room.id"
            class="room-row room-row-click"
            data-testid="admin-room-row"
            role="button"
            tabindex="0"
            @click="openRoomDetail(room)"
            @keydown.enter.self.prevent="openRoomDetail(room)"
          >
            <span class="col-check" @click.stop>
              <input
                type="checkbox"
                data-testid="admin-room-check"
                :aria-label="`选择房间 ${room.name}`"
                :checked="isRoomSelected(room)"
                :disabled="roomBulkBusy"
                @change="selectRoom(room, $event)"
              />
            </span>
            <span class="room-name" :title="room.name">{{ room.name }}</span>
            <span class="room-owner" :title="room.ownerName">{{ room.ownerName }}</span>
            <span class="mono col-num">{{ room.memberCount }}</span>
            <span class="mono col-num">{{ room.messageCount }}</span>
            <span class="col-type">
              <span class="tag" :class="{ muted: !room.isPublic }">
                {{ room.isPublic ? '公开' : '私有' }}
              </span>
            </span>
            <span class="col-time mono">{{ formatCreated(room.createdAt) }}</span>
            <span class="col-action">
              <button
                class="btn danger small"
                data-testid="admin-room-delete"
                :disabled="roomBusyId === room.id"
                @click.stop="removeRoom(room)"
              >
                {{ roomBusyId === room.id ? '删除中…' : '删除' }}
              </button>
            </span>
          </div>

          <div v-if="roomsLoading" class="admin-empty">加载中…</div>
          <div v-else-if="rooms.length === 0" class="admin-empty">
            {{ roomQuery ? '没有匹配的房间' : '还没有房间' }}
          </div>
        </div>

        <div class="admin-pager">
          <span class="mono">
            第 {{ roomsPage }} / {{ roomsPageCount }} 页 · 共 {{ roomsTotal }} 个
          </span>
          <div class="pager-actions">
            <button
              class="btn ghost small"
              :disabled="!hasRoomsPrev || roomsLoading"
              @click="turnRoomsPage(-1)"
            >
              上一页
            </button>
            <button
              class="btn ghost small"
              :disabled="!hasRoomsNext || roomsLoading"
              @click="turnRoomsPage(1)"
            >
              下一页
            </button>
          </div>
        </div>
      </section>

      <!-- ============ bots ============ -->
      <section v-else-if="tab === 'bots'" class="admin-panel">
        <div class="admin-toolbar">
          <p class="admin-hint">
            全局机器人对所有房间可见；停用后不会再回复任何消息。
          </p>
          <div class="toolbar-actions">
            <button class="btn ghost small" :disabled="botsLoading" @click="loadBots">
              刷新
            </button>
            <button class="btn primary small" data-testid="admin-bot-create" @click="openCreate">
              <Icon name="plus" :size="14" />
              新建机器人
            </button>
          </div>
        </div>

        <div class="bot-grid">
          <article
            v-for="bot in bots"
            :key="bot.userId"
            class="bot-card"
            data-testid="admin-bot-card"
          >
            <header class="bot-card-head">
              <span class="bot-card-name">{{ bot.name }}</span>
              <span class="status-pill" :class="bot.enabled ? 'active' : 'banned'">
                <span class="status-dot"></span>
                {{ bot.enabled ? '已启用' : '已停用' }}
              </span>
            </header>
            <div class="bot-card-meta">
              <span class="mono">@{{ bot.username }}</span>
              <span class="mono">{{ bot.model }}</span>
              <span class="mono">{{ bot.triggerMode === 'mention' ? '@ 触发' : '每条消息' }}</span>
            </div>
            <div class="bot-card-line" :title="bot.baseUrl">{{ bot.baseUrl }}</div>
            <div class="bot-card-line mono">key {{ bot.apiKeyMasked }}</div>
            <footer class="bot-card-actions">
              <button
                class="btn ghost small"
                :disabled="botBusyId === bot.userId"
                @click="openEdit(bot)"
              >
                编辑
              </button>
              <button
                class="btn small"
                :class="bot.enabled ? 'ghost' : 'primary'"
                :disabled="botBusyId === bot.userId"
                @click="toggleBot(bot)"
              >
                {{ botBusyId === bot.userId ? '处理中…' : bot.enabled ? '停用' : '启用' }}
              </button>
              <button
                class="btn danger small"
                :disabled="botBusyId === bot.userId"
                @click="removeBot(bot)"
              >
                删除
              </button>
            </footer>
          </article>

          <div v-if="botsLoading" class="admin-empty">加载中…</div>
          <div v-else-if="bots.length === 0" class="admin-empty">
            还没有全局机器人，点「新建机器人」创建第一个。
          </div>
        </div>
      </section>

      <!-- ============ reports ============ -->
      <section v-else-if="tab === 'reports'" class="admin-panel">
        <div class="admin-toolbar">
          <div class="admin-search audit-filter">
            <Icon name="megaphone" :size="16" />
            <select
              v-model="reportFilter"
              data-testid="admin-reports-status-filter"
              @change="applyReportFilter"
            >
              <option value="open">待处理</option>
              <option value="all">全部</option>
            </select>
          </div>
          <div class="toolbar-actions">
            <span v-if="selectedReportCount > 0" class="admin-hint">
              已选 {{ selectedReportCount }} 条
            </span>
            <button
              class="btn primary small"
              data-testid="admin-report-bulk-resolve"
              :disabled="selectedReportCount === 0 || reportBulkBusy || reportBusyId !== null"
              @click="bulkResolveReports('resolved')"
            >
              批量处理
            </button>
            <button
              class="btn ghost small"
              data-testid="admin-report-bulk-dismiss"
              :disabled="selectedReportCount === 0 || reportBulkBusy || reportBusyId !== null"
              @click="bulkResolveReports('dismissed')"
            >
              批量忽略
            </button>
            <button class="btn ghost small" :disabled="reportsLoading" @click="loadReports">
              刷新
            </button>
            <button
              class="btn ghost small"
              data-testid="reports-export"
              :disabled="reportExporting"
              @click="exportReports"
            >
              {{ reportExporting ? '导出中…' : '导出 CSV' }}
            </button>
          </div>
        </div>

        <div class="report-table">
          <div class="report-row report-row-head">
            <span class="col-check">
              <input
                type="checkbox"
                data-testid="admin-report-check-all"
                aria-label="全选本页举报"
                :checked="allReportsSelected"
                :disabled="reports.length === 0 || reportBulkBusy"
                @change="selectAllReports"
              />
            </span>
            <span>时间</span>
            <span>房间</span>
            <span>发送者</span>
            <span>内容</span>
            <span>举报人</span>
            <span>原因</span>
            <span>状态</span>
            <span class="col-action">操作</span>
          </div>

          <div
            v-for="report in reports"
            :key="report.id"
            class="report-row"
            data-testid="admin-report-row"
          >
            <span class="col-check">
              <input
                type="checkbox"
                data-testid="admin-report-check"
                :aria-label="`选择举报 ${report.id}`"
                :checked="selectedReportIds.includes(report.id)"
                :disabled="reportBulkBusy"
                @change="selectReport(report, $event)"
              />
            </span>
            <span class="mono report-time">{{ formatCreated(report.createdAt) }}</span>
            <span class="report-room" :title="report.roomName">{{ report.roomName }}</span>
            <span class="report-person" :title="report.senderName">
              {{ report.senderName }}
            </span>
            <span class="report-message">
              <span class="report-message-text" :title="report.messageContent">
                {{ report.messageContent }}
              </span>
              <span v-if="report.messageDeleted" class="tag muted report-deleted">
                已撤回
              </span>
            </span>
            <span class="report-person" :title="report.reporterName">
              {{ report.reporterName }}
            </span>
            <span class="report-reason" :title="report.reason">{{ report.reason }}</span>
            <span
              class="status-pill report-status"
              :class="report.status"
              :title="reportResolverHint(report)"
            >
              <span class="status-dot"></span>
              {{ reportStatusLabel(report.status) }}
            </span>
            <span class="col-action report-row-actions">
              <template v-if="report.status === 'open'">
                <button
                  class="btn primary small"
                  data-testid="report-resolve"
                  :disabled="reportBusyId !== null || reportBulkBusy"
                  @click="resolveReport(report, 'resolved')"
                >
                  处理
                </button>
                <button
                  class="btn ghost small"
                  data-testid="report-dismiss"
                  :disabled="reportBusyId !== null || reportBulkBusy"
                  @click="resolveReport(report, 'dismissed')"
                >
                  忽略
                </button>
              </template>
              <span v-else class="report-handled mono">—</span>
            </span>
          </div>

          <div v-if="reportsLoading" class="admin-empty">加载中…</div>
          <div v-else-if="reports.length === 0" class="admin-empty">
            {{ reportFilter === 'open' ? '没有待处理的举报' : '还没有举报记录' }}
          </div>
        </div>

        <div class="admin-pager">
          <span class="mono">
            第 {{ reportsPage }} / {{ reportsPageCount }} 页 · 共 {{ reportsTotal }} 条
          </span>
          <div class="pager-actions">
            <button
              class="btn ghost small"
              :disabled="!hasReportsPrev || reportsLoading"
              @click="turnReportsPage(-1)"
            >
              上一页
            </button>
            <button
              class="btn ghost small"
              :disabled="!hasReportsNext || reportsLoading"
              @click="turnReportsPage(1)"
            >
              下一页
            </button>
          </div>
        </div>
      </section>

      <!-- ============ audit ============ -->
      <section v-else-if="tab === 'audit'" class="admin-panel">
        <div class="admin-toolbar">
          <div class="audit-filters">
            <div class="admin-search audit-filter">
              <Icon name="settings" :size="16" />
              <select
                v-model="auditAction"
                data-testid="admin-audit-action-filter"
                aria-label="操作类型"
                @change="applyAuditFilter"
              >
                <option value="">全部动作</option>
                <option
                  v-for="item in AUDIT_ACTIONS"
                  :key="item.value"
                  :value="item.value"
                >
                  {{ item.label }}
                </option>
              </select>
            </div>
            <div class="admin-search audit-filter audit-filter-actor">
              <Icon name="users" :size="16" />
              <input
                v-model="auditActor"
                data-testid="admin-audit-actor"
                placeholder="操作人"
                maxlength="64"
                aria-label="操作人"
                @input="scheduleAuditSearch"
                @keydown.enter.prevent="applyAuditFilter"
              />
              <button
                v-if="auditActor"
                class="icon-btn"
                title="清空"
                @click="auditActor = ''; applyAuditFilter()"
              >
                <Icon name="close" :size="14" />
              </button>
            </div>
            <div class="audit-dates">
              <Icon name="clock" :size="16" />
              <input
                v-model="auditFrom"
                type="date"
                data-testid="audit-from"
                aria-label="开始日期"
                @change="applyAuditFilter"
              />
              <span class="audit-dates-sep">至</span>
              <input
                v-model="auditTo"
                type="date"
                data-testid="audit-to"
                aria-label="结束日期"
                @change="applyAuditFilter"
              />
            </div>
            <div class="audit-quick" aria-label="快捷日期范围">
              <button
                type="button"
                class="btn ghost small"
                :class="{ active: auditRangeMatches(1) }"
                data-testid="audit-range-today"
                @click="setAuditRange(1)"
              >
                今天
              </button>
              <button
                type="button"
                class="btn ghost small"
                :class="{ active: auditRangeMatches(7) }"
                data-testid="audit-range-7"
                @click="setAuditRange(7)"
              >
                近 7 天
              </button>
              <button
                type="button"
                class="btn ghost small"
                :class="{ active: auditRangeMatches(30) }"
                data-testid="audit-range-30"
                @click="setAuditRange(30)"
              >
                近 30 天
              </button>
              <button
                type="button"
                class="btn ghost small"
                data-testid="audit-range-clear"
                :disabled="auditFrom === '' && auditTo === ''"
                @click="setAuditRange(null)"
              >
                清除
              </button>
            </div>
          </div>
          <div class="toolbar-actions">
            <button
              class="btn ghost small"
              data-testid="audit-export"
              :disabled="auditExporting || auditExportAllBusy"
              @click="exportAudit"
            >
              导出 CSV
            </button>
            <button
              class="btn ghost small"
              data-testid="audit-export-all"
              :disabled="auditExportAllBusy || auditExporting"
              @click="exportAuditAll"
            >
              导出全部
            </button>
            <button class="btn ghost small" :disabled="auditLoading" @click="loadAudit">
              刷新
            </button>
          </div>
        </div>

        <div class="audit-table">
          <div class="audit-row audit-row-head">
            <span>时间</span>
            <span>操作者</span>
            <span>动作</span>
            <span>目标</span>
            <span>详情</span>
          </div>

          <div
            v-for="entry in auditEntries"
            :key="entry.id"
            class="audit-row"
            data-testid="admin-audit-row"
          >
            <span class="mono audit-time">{{ formatCreated(entry.createdAt) }}</span>
            <span class="audit-actor">
              {{ entry.actorName || `#${entry.actorId}` }}
            </span>
            <span class="audit-action" :title="entry.action">
              {{ actionLabel(entry.action) }}
            </span>
            <span class="mono audit-target">{{ targetLabel(entry) }}</span>
            <span class="audit-detail" :title="formatDetail(entry.detail)">
              {{ formatDetail(entry.detail) }}
            </span>
          </div>

          <div v-if="auditLoading" class="admin-empty">加载中…</div>
          <div v-else-if="auditEntries.length === 0" class="admin-empty">
            {{ hasAuditFilters ? '没有匹配的审计记录' : '还没有审计记录' }}
          </div>
        </div>

        <div class="admin-pager">
          <span class="mono">
            第 {{ auditPage }} / {{ auditPageCount }} 页 · 共 {{ auditTotal }} 条
          </span>
          <div class="pager-actions">
            <button
              class="btn ghost small"
              :disabled="!hasAuditPrev || auditLoading"
              @click="turnAuditPage(-1)"
            >
              上一页
            </button>
            <button
              class="btn ghost small"
              :disabled="!hasAuditNext || auditLoading"
              @click="turnAuditPage(1)"
            >
              下一页
            </button>
          </div>
        </div>
      </section>
    </div>

    <el-drawer
      v-model="detailOpen"
      direction="rtl"
      size="420px"
      title="用户详情"
      :with-header="false"
      data-testid="admin-user-detail"
    >
      <div class="detail-head">
        <h2 class="detail-title">用户详情</h2>
        <button
          class="icon-btn"
          data-testid="admin-user-detail-close"
          title="关闭"
          @click="closeUserDetail"
        >
          <Icon name="close" :size="16" />
        </button>
      </div>

      <div v-if="detailLoading && !detail" class="admin-empty">加载中…</div>
      <div v-else-if="!detail" class="admin-empty">无法加载该用户</div>
      <div v-else class="detail-body">
        <div class="detail-profile">
          <UserAvatar
            :avatar="detail.user.avatar"
            :id="detail.user.id"
            :name="detail.user.displayName || detail.user.username"
          />
          <div class="detail-profile-copy">
            <span class="detail-name">
              {{ detail.user.displayName || detail.user.username }}
            </span>
            <span class="detail-handle">@{{ detail.user.username }}</span>
            <div class="detail-tags">
              <span class="tag" :class="{ muted: detail.user.type === 'bot' }">
                {{ detail.user.type === 'bot' ? 'BOT' : 'HUMAN' }}
              </span>
              <span class="tag" :class="{ muted: detail.user.role !== 'admin' }">
                {{ detail.user.role === 'admin' ? 'ADMIN' : 'USER' }}
              </span>
              <span class="status-pill" :class="detail.user.status">
                <span class="status-dot"></span>
                {{ detail.user.status === 'banned' ? '已封禁' : '正常' }}
              </span>
            </div>
          </div>
        </div>

        <p class="detail-created mono">
          创建于 {{ formatCreated(detail.user.createdAt) }}
        </p>

        <div class="detail-stats">
          <div class="detail-stat">
            <span class="detail-stat-value mono">{{ detail.stats.rooms }}</span>
            <span class="detail-stat-label">加入房间</span>
          </div>
          <div class="detail-stat">
            <span class="detail-stat-value mono">{{ detail.stats.messages }}</span>
            <span class="detail-stat-label">发送消息</span>
          </div>
          <div class="detail-stat">
            <span class="detail-stat-value mono">{{ detail.stats.bots }}</span>
            <span class="detail-stat-label">拥有机器人</span>
          </div>
        </div>

        <div class="detail-role" data-testid="admin-user-role-block">
          <div class="detail-role-copy">
            <span class="detail-role-label">角色</span>
            <span class="tag" :class="{ muted: detail.user.role !== 'admin' }">
              {{ detail.user.role === 'admin' ? '管理员' : '普通用户' }}
            </span>
          </div>
          <button
            class="btn small ghost"
            data-testid="admin-user-role"
            :disabled="roleLocked(detail.user) || roleBusyId === detail.user.id"
            :title="roleLockHint(detail.user)"
            @click="toggleRole(detail.user)"
          >
            {{
              roleBusyId === detail.user.id
                ? '处理中…'
                : detail.user.role === 'admin'
                  ? '取消管理员'
                  : '设为管理员'
            }}
          </button>
        </div>

        <div class="detail-actions">
          <button
            class="btn small"
            :class="detail.user.status === 'active' ? 'danger' : 'ghost'"
            data-testid="admin-user-detail-status"
            :disabled="rowLocked(detail.user) || statusBusyId === detail.user.id"
            :title="lockHint(detail.user)"
            @click="toggleStatus(detail.user)"
          >
            {{
              statusBusyId === detail.user.id
                ? '处理中…'
                : detail.user.status === 'active'
                  ? '封禁'
                  : '解封'
            }}
          </button>
        </div>

        <h3 class="detail-section-title">
          加入的房间 <span class="mono">{{ detail.stats.rooms }}</span>
        </h3>
        <div class="detail-rooms">
          <div
            v-for="room in detail.rooms"
            :key="room.id"
            class="detail-room"
            data-testid="admin-user-detail-room"
          >
            <div class="detail-room-main">
              <span class="detail-room-name" :title="room.name">{{ room.name }}</span>
              <span class="tag" :class="{ muted: room.role === 'member' }">
                {{ roleLabel(room.role) }}
              </span>
            </div>
            <div class="detail-room-meta mono">
              <span>{{ formatCreated(room.joinedAt) }}</span>
              <span>{{ room.memberCount }} 位成员</span>
            </div>
          </div>
          <div v-if="detail.rooms.length === 0" class="admin-empty">
            尚未加入任何房间
          </div>
        </div>
      </div>
    </el-drawer>

    <el-drawer
      v-model="roomDetailOpen"
      direction="rtl"
      size="440px"
      :with-header="false"
      data-testid="admin-room-detail"
    >
      <div class="detail-head">
        <h2 class="detail-title">房间详情</h2>
        <button
          class="icon-btn"
          data-testid="admin-room-detail-close"
          title="关闭"
          @click="closeRoomDetail"
        >
          <Icon name="close" :size="16" />
        </button>
      </div>

      <div v-if="roomDetailLoading && !roomDetail" class="admin-empty">加载中…</div>
      <div v-else-if="!roomDetail" class="admin-empty">
        无法加载房间详情{{ roomDetailError ? `（${roomDetailError}）` : '' }}
      </div>
      <div v-else class="detail-body">
        <div class="detail-profile-copy">
          <span class="detail-name" data-testid="admin-room-detail-name">
            {{ roomDetail.name }}
          </span>
          <div class="detail-tags">
            <span class="tag" :class="{ muted: !roomDetail.isPublic }">
              {{ roomDetail.isPublic ? '公开' : '私有' }}
            </span>
            <span class="tag muted mono">#{{ roomDetail.id }}</span>
          </div>
        </div>

        <div class="detail-stats">
          <div class="detail-stat">
            <span class="detail-stat-value mono">{{ roomDetail.memberCount }}</span>
            <span class="detail-stat-label">成员</span>
          </div>
          <div class="detail-stat">
            <span class="detail-stat-value mono">{{ roomDetail.messageCount }}</span>
            <span class="detail-stat-label">消息</span>
          </div>
          <div class="detail-stat">
            <span class="detail-stat-value mono">
              {{ roomDetail.slowModeSeconds > 0 ? `${roomDetail.slowModeSeconds}s` : '关闭' }}
            </span>
            <span class="detail-stat-label">慢速模式</span>
          </div>
        </div>

        <dl class="detail-fields">
          <div class="detail-field">
            <dt>话题</dt>
            <dd>{{ roomDetail.topic || '—' }}</dd>
          </div>
          <div class="detail-field">
            <dt>公告</dt>
            <dd class="detail-field-multiline">{{ roomDetail.announcement || '—' }}</dd>
          </div>
          <div class="detail-field">
            <dt>房主</dt>
            <dd>{{ roomDetail.ownerName || '—' }} <span class="mono muted">#{{ roomDetail.ownerId }}</span></dd>
          </div>
          <div class="detail-field">
            <dt>公开状态</dt>
            <dd>{{ roomDetail.isPublic ? '公开' : '私有' }}</dd>
          </div>
          <div class="detail-field">
            <dt>成员数</dt>
            <dd class="mono">{{ roomDetail.memberCount }}</dd>
          </div>
          <div class="detail-field">
            <dt>消息数</dt>
            <dd class="mono">{{ roomDetail.messageCount }}</dd>
          </div>
          <div class="detail-field">
            <dt>保留天数</dt>
            <dd>
              {{ roomDetail.retentionDays > 0 ? `${roomDetail.retentionDays} 天` : '永久保留' }}
            </dd>
          </div>
          <div class="detail-field">
            <dt>慢速模式</dt>
            <dd>
              {{ roomDetail.slowModeSeconds > 0 ? `${roomDetail.slowModeSeconds} 秒` : '关闭' }}
            </dd>
          </div>
          <div class="detail-field">
            <dt>创建时间</dt>
            <dd class="mono">{{ formatCreated(roomDetail.createdAt) }}</dd>
          </div>
        </dl>
      </div>
    </el-drawer>

    <el-dialog
      v-model="createVisible"
      :title="editingId ? '编辑全局机器人' : '新建全局机器人'"
      width="560px"
    >
      <div class="bot-form-grid">
        <label class="field">
          <span>名称</span>
          <input v-model="botForm.name" data-testid="admin-bot-name" maxlength="64" />
        </label>
        <label class="field">
          <span>model</span>
          <input v-model="botForm.model" data-testid="admin-bot-model" />
        </label>
        <label class="field field-wide">
          <span>baseUrl</span>
          <input v-model="botForm.baseUrl" data-testid="admin-bot-base-url" />
        </label>
        <label class="field field-wide">
          <span>API Key</span>
          <input
            v-model="botForm.apiKey"
            data-testid="admin-bot-api-key"
            type="password"
            :placeholder="editingId ? '留空则不修改' : ''"
          />
        </label>
        <label class="field field-wide">
          <span>system prompt</span>
          <textarea v-model="botForm.systemPrompt" rows="3"></textarea>
        </label>
        <label class="field field-wide">
          <span>触发模式</span>
          <select v-model="botForm.triggerMode" data-testid="admin-bot-trigger-mode">
            <option value="mention">仅 @机器人</option>
            <option value="all">每条消息</option>
          </select>
        </label>
      </div>
      <template #footer>
        <button class="btn ghost" @click="createVisible = false">取消</button>
        <button class="btn primary" :disabled="saving" @click="saveBot">
          {{ saving ? '保存中…' : editingId ? '保存修改' : '创建' }}
        </button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.admin-page {
  height: 100%;
  overflow-y: auto;
  background: var(--paper);
  color: var(--text);
}

.admin-inner {
  max-width: 1040px;
  margin: 0 auto;
  padding: 28px 32px 56px;
}

.admin-head {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 20px;
}

.admin-head-copy {
  display: flex;
  align-items: baseline;
  gap: 14px;
  flex-wrap: wrap;
}

.admin-title {
  margin: 0;
  font-size: var(--fs-display);
  font-weight: 700;
  letter-spacing: -0.02em;
  line-height: 1.1;
}

.admin-lead {
  margin: 0;
  color: var(--muted);
  font-size: var(--fs-sub);
}

.mono {
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  letter-spacing: 0.04em;
}

.admin-tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 18px;
  border-bottom: 1px solid var(--line);
}

.admin-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 38px;
  padding: 0 14px;
  border: none;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--muted);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: color 0.12s ease-out, border-color 0.12s ease-out;
}

.admin-tab:hover {
  color: var(--text);
}

.admin-tab.active {
  color: var(--text);
  border-bottom-color: var(--lime);
}

.admin-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.admin-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.admin-search {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1 1 260px;
  max-width: 380px;
  padding: 0 10px;
  height: 36px;
  border: 1px solid var(--line-strong);
  border-radius: var(--r-md);
  background: var(--paper-2);
  color: var(--muted);
}

.admin-search input {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  color: var(--text);
  font-size: 13px;
  outline: none;
}

.admin-search input::placeholder {
  color: var(--faint);
}

.admin-search .icon-btn {
  width: 22px;
  height: 22px;
}

.toolbar-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* Range picker for the overview trend window; the select inherits the toolbar look. */
.trend-range {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 8px;
  border: 1px solid var(--line-strong);
  border-radius: var(--r-md);
  background: var(--paper-2);
  color: var(--muted);
  font-size: var(--fs-sub);
}

.trend-range select {
  border: none;
  background: transparent;
  color: var(--text);
  font-family: inherit;
  font-size: var(--fs-sub);
  outline: none;
  cursor: pointer;
}

.trend-range select:disabled {
  cursor: progress;
}

.admin-hint {
  margin: 0;
  color: var(--muted);
  font-size: var(--fs-sub);
}

/* ---------- overview ---------- */

.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 12px;
}

.stat-card {
  padding: 16px 18px;
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  background: var(--paper-2);
}

.stat-title {
  margin: 0 0 12px;
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.stat-items {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 22px;
}

.stat-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.stat-value {
  font-size: 22px;
  font-weight: 700;
  line-height: 1.1;
}

.stat-label {
  color: var(--muted);
  font-size: var(--fs-sub);
}

/* ---------- overview: trend ---------- */

.trend-panel {
  /* Grid track keeps the scrollable chart from widening the page on narrow screens. */
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 12px;
  margin-top: 8px;
  padding: 16px 18px;
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  background: var(--paper-2);
}

.trend-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px 16px;
  flex-wrap: wrap;
}

.trend-title {
  margin: 0;
  font-size: var(--fs-h);
  font-weight: 700;
  letter-spacing: -0.01em;
}

.trend-sub {
  margin: 2px 0 0;
  color: var(--muted);
  font-size: var(--fs-sub);
}

.trend-legend {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 14px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.trend-legend-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--muted);
  font-size: var(--fs-sub);
}

.trend-swatch {
  width: 9px;
  height: 9px;
  border-radius: 2px;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.35);
}

.trend-skeleton {
  display: flex;
  align-items: flex-end;
  gap: 6px;
  height: 150px;
  border-bottom: 1px solid var(--line);
}

.trend-skeleton-bar {
  flex: 1 1 0;
  min-width: 2px;
  height: 60%;
  border-radius: 2px 2px 0 0;
  background: var(--paper-3);
  animation: trend-pulse 1.2s ease-in-out infinite alternate;
}

@keyframes trend-pulse {
  from {
    opacity: 0.55;
  }
  to {
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .trend-skeleton-bar {
    animation: none;
  }
}

.trend-scroll {
  overflow-x: auto;
  overflow-y: hidden;
  transition: opacity 0.15s ease;
}

/* The previous window stays visible while the new range loads, dimmed. */
.trend-panel.is-refreshing .trend-scroll,
.trend-panel.is-refreshing .trend-compare {
  opacity: 0.45;
}

/* Axis column + plot body side by side; the body keeps the old column stack
   (plot on top, day ticks below) untouched. */
.trend-chart {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  min-width: calc(var(--trend-days, 14) * 36px + 26px);
}

/* Shared y axis: peak / mid / 0 labels. Space-between over the plot's exact
   height centers the mid label on the 50% guide line. */
.trend-axis {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  align-items: flex-end;
  width: 26px;
  flex: none;
  height: 150px;
  color: var(--faint);
  line-height: 1;
}

.trend-axis-value {
  white-space: nowrap;
}

.trend-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1 1 0;
  min-width: calc(var(--trend-days, 14) * 36px);
}

.trend-plot {
  display: flex;
  align-items: flex-end;
  gap: 10px;
  height: 150px;
  border-bottom: 1px solid var(--line);
  /* Faint quarter-height guides keep sparse series readable. */
  background-image: linear-gradient(to top, var(--line) 0 1px, transparent 1px);
  background-size: 100% 37.5px;
  background-position: bottom;
}

.trend-day {
  display: flex;
  flex: 1 1 0;
  align-items: flex-end;
  gap: 2px;
  min-width: 26px;
  height: 100%;
}

.trend-bar {
  flex: 1 1 0;
  min-width: 2px;
  border-radius: 2px 2px 0 0;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.3);
  opacity: 0.9;
  transition: opacity 0.12s ease-out;
}

.trend-day:hover .trend-bar {
  opacity: 1;
}

.trend-ticks {
  display: flex;
  gap: 10px;
}

.trend-tick {
  flex: 1 1 0;
  min-width: 26px;
  color: var(--faint);
  text-align: center;
  white-space: nowrap;
}

.trend-tick.is-hidden {
  visibility: hidden;
}

/* Period-over-period strip under the chart: one entry per series. */
.trend-compare {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px 16px;
  padding-top: 10px;
  border-top: 1px solid var(--paper-3);
  transition: opacity 0.15s ease;
}

.trend-compare-title {
  color: var(--faint);
  font-size: var(--fs-sub);
  letter-spacing: 0.04em;
}

.trend-compare-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 18px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.trend-compare-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--muted);
  font-size: var(--fs-sub);
}

.trend-compare-label {
  color: var(--text);
  font-weight: 600;
}

.trend-compare-value {
  color: var(--muted);
}

.trend-compare-delta {
  color: var(--faint);
}

/* Warm accent for growth, muted for decline; the dash (no baseline) stays faint. */
.trend-compare-delta.is-up {
  color: var(--rust-ink);
}

.trend-compare-delta.is-down {
  color: var(--muted);
}

@media (max-width: 720px) {
  .trend-panel {
    padding: 14px;
  }

  .trend-plot,
  .trend-ticks {
    gap: 8px;
  }

  .trend-compare-list {
    gap: 4px 14px;
  }
}

/* ---------- platform announcements ---------- */

.announcement-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 8px;
  padding: 16px 18px;
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  background: var(--paper-2);
}

.announcement-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.announcement-form .field {
  margin: 0;
}

.announcement-form-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.announcement-count {
  color: var(--muted);
}

.announcement-table {
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: var(--paper);
  overflow: hidden;
}

.announcement-row {
  display: grid;
  grid-template-columns: 124px minmax(0, 1fr) 110px 84px 148px;
  gap: 12px;
  align-items: center;
  padding: 10px 12px;
  border-bottom: 1px solid var(--line);
  font-size: 13px;
}

.announcement-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}

.announcement-row:last-child {
  border-bottom: none;
}

.announcement-row-head {
  background: var(--paper-3);
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.announcement-time,
.announcement-actor {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted);
}

.announcement-content {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
}

/* ---------- user detail drawer ---------- */

.detail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 18px;
}

.detail-title {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
}

.detail-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.detail-profile {
  display: flex;
  align-items: center;
  gap: 14px;
  min-width: 0;
}

.detail-profile .avatar {
  width: 52px;
  height: 52px;
  font-size: 18px;
}

.detail-profile-copy {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.detail-name {
  font-size: 16px;
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.detail-handle {
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  color: var(--muted);
}

.detail-tags {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
}

.detail-created {
  margin: 0;
  color: var(--muted);
}

.detail-stats {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}

.detail-stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: var(--paper-2);
}

.detail-stat-value {
  font-size: 18px;
  font-weight: 700;
}

.detail-stat-label {
  color: var(--muted);
  font-size: var(--fs-mono);
}

.detail-actions {
  display: flex;
  gap: 8px;
}

.detail-role {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: var(--paper-2);
}

.detail-role-copy {
  display: flex;
  align-items: center;
  gap: 8px;
}

.detail-role-label {
  color: var(--muted);
  font-size: var(--fs-mono);
}

.detail-section-title {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin: 4px 0 0;
  color: var(--muted);
  font-size: 13px;
  font-weight: 600;
}

.detail-rooms {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  background: var(--paper-2);
  overflow: hidden;
}

.detail-room {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--line);
}

.detail-room:last-child {
  border-bottom: none;
}

.detail-room-main {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.detail-room-name {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.detail-room-meta {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  color: var(--muted);
}

.detail-fields {
  display: flex;
  flex-direction: column;
  margin: 0;
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  background: var(--paper-2);
  overflow: hidden;
}

.detail-field {
  display: grid;
  grid-template-columns: 84px minmax(0, 1fr);
  gap: 12px;
  padding: 9px 12px;
  border-bottom: 1px solid var(--line);
  font-size: 13px;
}

.detail-field:last-child {
  border-bottom: none;
}

.detail-field dt {
  color: var(--muted);
}

.detail-field dd {
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
}

.detail-field-multiline {
  white-space: pre-wrap;
}

/* ---------- users table ---------- */

.user-table {
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  background: var(--paper-2);
  overflow: hidden;
}

.user-row {
  display: grid;
  grid-template-columns: 22px minmax(180px, 1.7fr) 84px 84px 96px 132px 88px;
  gap: 12px;
  align-items: center;
  padding: 10px 14px;
  border-bottom: 1px solid var(--line);
  font-size: 13px;
}

.user-row:last-child {
  border-bottom: none;
}

.user-row-clickable {
  cursor: pointer;
  transition: background 0.12s ease-out;
}

.user-row-clickable:hover {
  background: var(--paper-3);
}

.user-row-clickable:focus-visible {
  outline: 2px solid var(--lime);
  outline-offset: -2px;
}

.user-row-head {
  background: var(--paper-3);
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.col-check {
  display: flex;
  align-items: center;
  justify-content: center;
}

.col-check input {
  width: 14px;
  height: 14px;
  margin: 0;
  accent-color: var(--ink);
  cursor: pointer;
}

.col-check input:disabled {
  cursor: not-allowed;
}

.col-user {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.user-copy {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.user-name {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.user-handle {
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.col-time {
  color: var(--muted);
}

.col-action {
  display: flex;
  justify-content: flex-end;
}

.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
}

.status-pill .status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--line-strong);
}

.status-pill.active {
  color: var(--success);
}

.status-pill.active .status-dot {
  background: var(--success);
}

.status-pill.banned {
  color: var(--danger);
}

.status-pill.banned .status-dot {
  background: var(--danger);
}

.admin-empty {
  padding: 36px 14px;
  color: var(--muted);
  font-size: 13px;
  text-align: center;
}

.admin-pager {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  color: var(--muted);
  flex-wrap: wrap;
}

.pager-actions {
  display: flex;
  gap: 8px;
}

/* ---------- rooms table ---------- */

.room-table {
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  background: var(--paper-2);
  overflow: hidden;
}

.room-row {
  display: grid;
  grid-template-columns:
    22px minmax(150px, 1.6fr) minmax(110px, 1fr) 64px 64px 76px 132px 88px;
  gap: 12px;
  align-items: center;
  padding: 10px 14px;
  border-bottom: 1px solid var(--line);
  font-size: 13px;
}

.room-row:last-child {
  border-bottom: none;
}

.room-row-head {
  background: var(--paper-3);
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.room-row-click {
  cursor: pointer;
  transition: background 0.12s ease-out;
}

.room-row-click:hover {
  background: var(--paper-3);
}

.room-row-click:focus-visible {
  outline: 2px solid var(--lime);
  outline-offset: -2px;
}

.room-name,
.room-owner {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.room-name {
  font-weight: 600;
  color: var(--text);
}

.room-owner {
  color: var(--muted);
}

.col-num {
  text-align: right;
  color: var(--muted);
}

/* ---------- audit table ---------- */

.audit-filters {
  display: flex;
  flex: 1 1 auto;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.audit-filters .audit-filter {
  flex: 1 1 160px;
}

.audit-filter {
  max-width: 240px;
}

.audit-filter-actor {
  max-width: 220px;
}

/* Native date inputs are borderless inside the shared pill chrome. */
.audit-dates {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 36px;
  padding: 0 10px;
  border: 1px solid var(--line-strong);
  border-radius: var(--r-md);
  background: var(--paper-2);
  color: var(--muted);
  font-size: 12px;
}

.audit-dates input {
  width: 112px;
  border: none;
  background: transparent;
  color: var(--text);
  font-family: inherit;
  font-size: 12px;
  outline: none;
}

.audit-dates input::-webkit-calendar-picker-indicator {
  opacity: 0.55;
  cursor: pointer;
}

.audit-dates-sep {
  color: var(--faint);
}

.audit-quick {
  display: flex;
  align-items: center;
  gap: 4px;
}

.audit-quick .btn {
  white-space: nowrap;
}

.audit-quick .btn.active {
  border-color: var(--lime);
  color: var(--ink);
  background: var(--lime);
}

.audit-filter select {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  color: var(--text);
  font-size: 13px;
  outline: none;
  cursor: pointer;
}

.audit-table {
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  background: var(--paper-2);
  overflow: hidden;
}

.audit-row {
  display: grid;
  grid-template-columns: 132px minmax(100px, 0.9fr) 116px minmax(90px, 0.8fr) minmax(0, 2fr);
  gap: 12px;
  align-items: center;
  padding: 10px 14px;
  border-bottom: 1px solid var(--line);
  font-size: 13px;
}

.audit-row:last-child {
  border-bottom: none;
}

.audit-row-head {
  background: var(--paper-3);
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.audit-time {
  color: var(--muted);
  white-space: nowrap;
}

.audit-actor,
.audit-action,
.audit-target,
.audit-detail {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.audit-actor {
  font-weight: 600;
}

.audit-target,
.audit-detail {
  color: var(--muted);
}

/* ---------- reports table ---------- */

.report-table {
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  background: var(--paper-2);
  overflow: hidden;
}

.report-row {
  display: grid;
  grid-template-columns:
    28px 132px 96px minmax(80px, 0.7fr) minmax(0, 1.5fr)
    minmax(80px, 0.7fr) minmax(0, 1.3fr) 76px minmax(128px, auto);
  gap: 12px;
  align-items: center;
  padding: 10px 14px;
  border-bottom: 1px solid var(--line);
  font-size: 13px;
}

.report-row:last-child {
  border-bottom: none;
}

.report-row-head {
  background: var(--paper-3);
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.report-time {
  color: var(--muted);
  white-space: nowrap;
}

.report-room,
.report-person {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.report-person {
  font-weight: 600;
}

.report-message {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.report-message-text {
  min-width: 0;
  overflow: hidden;
  color: var(--muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.report-deleted {
  flex: none;
}

.report-reason {
  display: -webkit-box;
  min-width: 0;
  overflow: hidden;
  color: var(--muted);
  line-height: 1.45;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.report-status {
  justify-self: start;
}

.report-status.open {
  color: var(--rust);
}

.report-status.open .status-dot {
  background: var(--rust);
}

.report-status.resolved {
  color: var(--success);
}

.report-status.resolved .status-dot {
  background: var(--success);
}

.report-status.dismissed {
  color: var(--muted);
}

.report-status.dismissed .status-dot {
  background: var(--line-strong);
}

.report-row-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}

.report-handled {
  color: var(--faint);
}

/* ---------- bots ---------- */

.bot-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 12px;
}

.bot-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px;
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  background: var(--paper-2);
}

.bot-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.bot-card-name {
  font-size: 15px;
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bot-card-meta {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  color: var(--muted);
}

.bot-card-line {
  font-size: 12px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bot-card-actions {
  display: flex;
  gap: 8px;
  margin-top: 2px;
}

/* ---------- dialog form ---------- */

.bot-form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 12px;
}

.field-wide {
  grid-column: 1 / -1;
}

@media (max-width: 760px) {
  .admin-inner {
    padding: 20px 16px 40px;
  }

  .admin-title {
    font-size: 26px;
  }

  .user-row {
    grid-template-columns: 22px minmax(0, 1fr) 84px 84px;
    gap: 8px;
    padding: 10px 12px;
  }

  .user-row-head {
    display: none;
  }

  .user-row .col-type,
  .user-row .col-role,
  .user-row .col-time {
    display: none;
  }

  .audit-row {
    grid-template-columns: 112px minmax(0, 1fr) minmax(0, 1.2fr);
    gap: 8px;
    padding: 10px 12px;
  }

  .audit-row-head {
    display: none;
  }

  .room-row {
    grid-template-columns: 22px minmax(0, 1fr) 56px 56px 76px;
    gap: 8px;
    padding: 10px 12px;
  }

  .room-row-head {
    display: none;
  }

  .room-row .room-owner,
  .room-row .col-type,
  .room-row .col-time {
    display: none;
  }

  .audit-row .audit-actor,
  .audit-row .audit-target {
    display: none;
  }

  .report-row {
    grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr) 76px minmax(116px, auto);
    gap: 8px;
    padding: 10px 12px;
  }

  .report-row-head {
    display: none;
  }

  .report-row .report-time,
  .report-row .report-room,
  .report-row .report-person {
    display: none;
  }

  .announcement-panel {
    padding: 14px;
  }

  .announcement-row {
    grid-template-columns: minmax(0, 1fr) 84px 124px;
    gap: 8px;
    padding: 10px 12px;
  }

  .announcement-row-head {
    display: none;
  }

  .announcement-row .announcement-time,
  .announcement-row .announcement-actor {
    display: none;
  }

  .bot-form-grid {
    grid-template-columns: 1fr;
  }
}
</style>
