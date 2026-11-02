<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import http, { errorMessage } from '../api/http';
import { useAuthStore } from '../stores/auth';
import { useChatStore } from '../stores/chat';
import type { PublicRoomPage, RoomSummary } from '../types';
import { avatarClass, formatRelative, initialOf, plainPreview } from '../utils/format';
import Icon from './Icon.vue';
import BrandMark from './BrandMark.vue';
import MessageContextMenu from './MessageContextMenu.vue';
import NotificationPanel from './NotificationPanel.vue';
import ProfileDialog from './ProfileDialog.vue';
import UserAvatar from './UserAvatar.vue';
import GroupDialog from './GroupDialog.vue';

// Mirrors MessageContextMenu's item contract.
interface MenuItem {
  id: string;
  label: string;
  icon?: string;
  danger?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
}

const props = defineProps<{ activeRoomId?: number }>();
const emit = defineEmits<{ navigate: [] }>();

const router = useRouter();
const auth = useAuthStore();
const chat = useChatStore();

const query = ref('');
const tab = ref<'mine' | 'public'>('mine');

const filterOptions = [
  { value: 'all', label: '全部' },
  { value: 'unread', label: '未读' },
  { value: 'favorite', label: '收藏' },
  { value: 'archived', label: '归档' },
] as const;

type RoomFilter = (typeof filterOptions)[number]['value'];

// Only the "我的" tab filters; the selection survives a detour to 公开 so the
// list comes back as the reader left it.
const roomFilter = ref<RoomFilter>('all');
const createVisible = ref(false);
const joinVisible = ref(false);
const profileVisible = ref(false);
const busy = ref(false);
const createForm = reactive({ name: '', topic: '', isPublic: true });
const joinForm = reactive({ roomId: '', inviteCode: '' });
const groupVisible = ref(false);
const groupRoom = ref<RoomSummary | null>(null);
const notificationsOpen = ref(false);

interface RoomSection {
  key: string;
  label: string;
  rooms: RoomSummary[];
}

const COLLAPSED_KEY = 'bfa_room_groups_collapsed';

function readCollapsed(): string[] {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

const collapsed = ref<string[]>(readCollapsed());

function isCollapsed(key: string): boolean {
  return collapsed.value.includes(key);
}

function toggleSection(key: string) {
  collapsed.value = isCollapsed(key)
    ? collapsed.value.filter((item) => item !== key)
    : [...collapsed.value, key];
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(collapsed.value));
  } catch {
    // Storage can be unavailable (private mode); folding still works in memory.
  }
}

const PUBLIC_SEARCH_DEBOUNCE_MS = 300;
const PUBLIC_PAGE_SIZE = 20;

// The public tab is searched on the server: the store only carries the newest
// window, so a keyword cannot be applied locally without lying about matches
// outside it. `publicMoreRooms` holds pages the reader asked for beyond that
// window; search results keep their own list and total.
const publicSearchRooms = ref<RoomSummary[]>([]);
const publicSearchTotal = ref(0);
const publicSearchKeyword = ref('');
const publicSearchLoading = ref(false);
const publicMoreRooms = ref<RoomSummary[]>([]);
const publicMoreLoading = ref(false);
let publicSearchTimer: number | null = null;
// A slow response for an old keyword must never overwrite newer results.
let publicRequestSeq = 0;

function dedupeRooms(list: RoomSummary[]): RoomSummary[] {
  const seen = new Set<number>();
  return list.filter((room) => {
    if (seen.has(room.id)) {
      return false;
    }
    seen.add(room.id);
    return true;
  });
}

const publicKeyword = computed(() => query.value.trim());
const publicSearchActive = computed(
  () => tab.value === 'public' && publicKeyword.value !== '',
);

// The recent window plus any pages loaded past it. Window rows win on a
// duplicate so a refreshed window cannot show the same room twice.
const publicRooms = computed(() => {
  if (publicSearchActive.value) {
    return publicSearchRooms.value;
  }
  return dedupeRooms([...chat.rooms.public, ...publicMoreRooms.value]);
});

const rooms = computed(() => {
  if (tab.value === 'public') {
    return publicRooms.value;
  }
  const keyword = publicKeyword.value.toLowerCase();
  return chat.rooms.mine.filter((room) => {
    // 归档 is its own slice; every other chip is the default rail, which hides
    // archived rooms so they cannot be mistaken for active ones.
    if (roomFilter.value === 'archived') {
      if (!room.archived) {
        return false;
      }
    } else if (room.archived) {
      return false;
    }
    if (roomFilter.value === 'unread' && room.unreadCount <= 0) {
      return false;
    }
    if (roomFilter.value === 'favorite' && !room.favorite) {
      return false;
    }
    if (!keyword) {
      return true;
    }
    return (
      room.name.toLowerCase().includes(keyword) ||
      room.topic.toLowerCase().includes(keyword)
    );
  });
});

// While a search is pending the badge keeps the last known total; the search
// row below the tabs carries the "searching" state.
const publicTabCount = computed(() => {
  if (publicSearchActive.value && !publicSearchLoading.value) {
    return publicSearchTotal.value;
  }
  return chat.publicTotal;
});

function resetPublicSearch() {
  if (publicSearchTimer !== null) {
    window.clearTimeout(publicSearchTimer);
    publicSearchTimer = null;
  }
  publicRequestSeq += 1;
  publicSearchRooms.value = [];
  publicSearchTotal.value = 0;
  publicSearchKeyword.value = '';
  publicSearchLoading.value = false;
  publicMoreRooms.value = [];
  publicMoreLoading.value = false;
}

async function fetchPublicPage(keyword: string, offset: number) {
  const seq = ++publicRequestSeq;
  if (offset === 0) {
    publicSearchLoading.value = true;
  } else {
    publicMoreLoading.value = true;
  }
  try {
    const { data } = await http.get<PublicRoomPage>('/rooms/public', {
      params: { q: keyword || undefined, limit: PUBLIC_PAGE_SIZE, offset },
    });
    if (seq !== publicRequestSeq) {
      return;
    }
    const page = dedupeRooms(data.rooms);
    if (keyword) {
      publicSearchKeyword.value = keyword;
      publicSearchRooms.value =
        offset === 0 ? page : dedupeRooms([...publicSearchRooms.value, ...page]);
      publicSearchTotal.value = data.total;
    } else {
      publicMoreRooms.value =
        offset === 0 ? page : dedupeRooms([...publicMoreRooms.value, ...page]);
    }
  } catch (error) {
    if (seq === publicRequestSeq) {
      ElMessage.error(errorMessage(error));
    }
  } finally {
    if (seq === publicRequestSeq) {
      publicSearchLoading.value = false;
      publicMoreLoading.value = false;
    }
  }
}

function schedulePublicSearch() {
  if (publicSearchTimer !== null) {
    window.clearTimeout(publicSearchTimer);
    publicSearchTimer = null;
  }
  // Drop any page request still in flight for the previous keyword.
  publicRequestSeq += 1;
  const keyword = publicKeyword.value;
  if (!keyword) {
    publicSearchRooms.value = [];
    publicSearchTotal.value = 0;
    publicSearchKeyword.value = '';
    publicSearchLoading.value = false;
    publicMoreRooms.value = [];
    publicMoreLoading.value = false;
    return;
  }
  publicSearchLoading.value = true;
  publicSearchTimer = window.setTimeout(() => {
    publicSearchTimer = null;
    void fetchPublicPage(keyword, 0);
  }, PUBLIC_SEARCH_DEBOUNCE_MS);
}

// The public list is paged: the store's recent window may be shorter than the
// server total, and search results page the same way.
const publicHasMore = computed(() => {
  if (tab.value !== 'public' || publicSearchLoading.value) {
    return false;
  }
  const total = publicSearchActive.value ? publicSearchTotal.value : chat.publicTotal;
  return publicRooms.value.length < total;
});

async function loadMorePublic() {
  if (publicMoreLoading.value || publicSearchLoading.value) {
    return;
  }
  if (publicSearchActive.value) {
    await fetchPublicPage(publicSearchKeyword.value, publicSearchRooms.value.length);
  } else {
    await fetchPublicPage('', publicRooms.value.length);
  }
}

// The keyword is shared by both tabs (mine filters locally, public searches
// the server), so leaving 公开 drops its results and entering it starts over.
watch([query, tab], () => {
  if (tab.value !== 'public') {
    resetPublicSearch();
    return;
  }
  schedulePublicSearch();
});

// A chip narrows the list to one slice, so group headers would only repeat the
// same label; the filtered views stay flat in the store's activity order.
const isFlat = computed(
  () => tab.value !== 'mine' || roomFilter.value !== 'all' || query.value.trim() !== '',
);

// Doubles as the visibility rule for the 全部已读 action: no badge, no button.
// Archived rooms are hidden from 全部/未读, so their unread must not summon it.
const unreadRoomCount = computed(
  () => chat.rooms.mine.filter((room) => room.unreadCount > 0 && !room.archived).length,
);

// Search, the public tab and the 未读/收藏 filters stay flat: a filtered slice
// carries one meaning already. "我的" with no keyword and no filter folds into
// 收藏 → named groups (alphabetical) → 其他.
const sections = computed<RoomSection[]>(() => {
  if (isFlat.value) {
    return [{ key: 'flat', label: '', rooms: rooms.value }];
  }
  const favorites: RoomSummary[] = [];
  const grouped = new Map<string, RoomSummary[]>();
  const other: RoomSummary[] = [];
  for (const room of rooms.value) {
    if (room.favorite) {
      favorites.push(room);
      continue;
    }
    const name = room.group?.trim();
    if (!name) {
      other.push(room);
      continue;
    }
    const bucket = grouped.get(name);
    if (bucket) {
      bucket.push(room);
    } else {
      grouped.set(name, [room]);
    }
  }
  const list: RoomSection[] = [];
  if (favorites.length) {
    list.push({ key: 'favorite', label: '收藏', rooms: favorites });
  }
  for (const name of [...grouped.keys()].sort((left, right) => left.localeCompare(right, 'zh'))) {
    list.push({ key: `group:${name}`, label: name, rooms: grouped.get(name) ?? [] });
  }
  if (other.length) {
    list.push({ key: 'other', label: '其他', rooms: other });
  }
  return list;
});

const emptyLabel = computed(() => {
  if (tab.value === 'public') {
    if (publicKeyword.value) {
      return publicSearchLoading.value ? '正在搜索…' : '没有匹配的公开房间';
    }
    return '还没有公开房间';
  }
  if (query.value.trim()) {
    return '没有匹配的房间';
  }
  if (tab.value === 'mine' && roomFilter.value === 'unread') {
    return '没有未读房间';
  }
  if (tab.value === 'mine' && roomFilter.value === 'favorite') {
    return '还没有收藏';
  }
  if (tab.value === 'mine' && roomFilter.value === 'archived') {
    return '还没有归档的房间';
  }
  return '还没有房间';
});

const isAdmin = computed(() => auth.user?.role === 'admin');
// The badge is a narrow rail element; cap the label so three digits cannot
// widen it past the icon.
const unreadLabel = computed(() =>
  chat.notificationsUnread > 99 ? '99+' : String(chat.notificationsUnread),
);

const menuOpen = ref(false);
const menuX = ref(0);
const menuY = ref(0);
const menuRoom = ref<RoomSummary | null>(null);

const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP = 10;
let pressTimer: number | null = null;
let pressStartX = 0;
let pressStartY = 0;
// A long press ends with a click on the same card; swallow it so the menu is
// the only result.
let suppressClick = false;

// In the mobile drawer, a leftward drag closes the rail. The gesture is bound
// to the rail itself, so the desktop copy (hidden at this width) and the fixed
// sidebar never see it.
const root = ref<HTMLElement | null>(null);
const MOBILE_BREAKPOINT = 860;
const CLOSE_SWIPE_DISTANCE = 60;
const CLOSE_SWIPE_VERTICAL_SLOP = 40;
const CLOSE_SWIPE_DECIDE_SLOP = 10;
let closeStartX = 0;
let closeStartY = 0;
let closeTracking = false;
let closeHorizontal = false;

// Membership gates every menu action: the server rejects them for rooms the
// viewer has not joined.
const menuItems = computed<MenuItem[]>(() => {
  const room = menuRoom.value;
  if (!room || !room.joined) {
    return [];
  }
  const items: MenuItem[] = [
    {
      id: 'room-menu-favorite',
      label: room.favorite ? '取消收藏' : '收藏',
      icon: 'pin',
    },
    {
      id: 'room-menu-mute',
      label: room.muted ? '取消免打扰' : '消息免打扰',
      icon: room.muted ? 'bell' : 'bellOff',
    },
    {
      id: 'room-menu-group',
      label: '移动到分组…',
      icon: 'hash',
    },
    {
      id: 'room-menu-archive',
      label: room.archived ? '取消归档' : '归档',
      icon: 'arrowDown',
    },
  ];
  if (room.unreadCount > 0) {
    items.push({
      id: 'room-menu-read',
      label: '标记已读',
      icon: 'check',
      separatorBefore: true,
    });
  }
  return items;
});

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
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  try {
    if (!room.joined) {
      busy.value = true;
      await http.post(`/rooms/${room.id}/join`, {});
      await chat.loadRooms();
      // The joined room leaves the public lists; drop paged copies of it and
      // let an active keyword search again.
      resetPublicSearch();
      schedulePublicSearch();
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

// Private rooms accept a request without an invite code; the owner approves it
// from the room settings dialog.
async function requestJoin() {
  const roomId = Number(joinForm.roomId);
  if (!Number.isInteger(roomId) || roomId <= 0) {
    ElMessage.warning('请输入房间 ID');
    return;
  }
  try {
    busy.value = true;
    await http.post(`/rooms/${roomId}/request`);
    joinVisible.value = false;
    joinForm.roomId = '';
    joinForm.inviteCode = '';
    ElMessage.success('已提交申请');
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    busy.value = false;
  }
}

function openMenuAt(x: number, y: number, room: RoomSummary) {
  // Every action is member-only, so unjoined public rooms have no menu.
  if (!room.joined) {
    return;
  }
  menuRoom.value = room;
  menuX.value = x;
  menuY.value = y;
  menuOpen.value = true;
}

function openMenu(event: MouseEvent, room: RoomSummary) {
  openMenuAt(event.clientX, event.clientY, room);
}

function closeMenu() {
  menuOpen.value = false;
  suppressClick = false;
}

function clearPress() {
  if (pressTimer !== null) {
    window.clearTimeout(pressTimer);
    pressTimer = null;
  }
  if (suppressClick) {
    // The click that closes out this gesture is dispatched before the next
    // task, so clear the flag right after it.
    window.setTimeout(() => {
      suppressClick = false;
    }, 0);
  }
}

// Touch/pen long press opens the same menu as right click.
function startPress(event: PointerEvent, room: RoomSummary) {
  if (event.pointerType === 'mouse') {
    return;
  }
  pressStartX = event.clientX;
  pressStartY = event.clientY;
  clearPress();
  pressTimer = window.setTimeout(() => {
    pressTimer = null;
    suppressClick = true;
    openMenuAt(pressStartX, pressStartY, room);
  }, LONG_PRESS_MS);
}

function movePress(event: PointerEvent) {
  if (pressTimer === null) {
    return;
  }
  if (
    Math.abs(event.clientX - pressStartX) > LONG_PRESS_SLOP ||
    Math.abs(event.clientY - pressStartY) > LONG_PRESS_SLOP
  ) {
    clearPress();
  }
}

function isCloseSwipeBlockedTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  if (target.closest('input, textarea, select, [contenteditable="true"]')) {
    return true;
  }
  // The filter chips scroll sideways on their own; a drag that starts there
  // is a list scroll, not a drawer-close request.
  let node: Element | null = target;
  while (node && node !== root.value) {
    const style = window.getComputedStyle(node);
    if (
      (style.overflowX === 'auto' || style.overflowX === 'scroll') &&
      node.scrollWidth > node.clientWidth
    ) {
      return true;
    }
    node = node.parentElement;
  }
  return false;
}

function resetCloseSwipe() {
  closeTracking = false;
  closeHorizontal = false;
}

function onCloseSwipeStart(event: TouchEvent) {
  resetCloseSwipe();
  if (
    event.touches.length !== 1 ||
    window.innerWidth > MOBILE_BREAKPOINT ||
    menuOpen.value ||
    isCloseSwipeBlockedTarget(event.target)
  ) {
    return;
  }
  const touch = event.touches[0];
  closeStartX = touch.clientX;
  closeStartY = touch.clientY;
  closeTracking = true;
}

function onCloseSwipeMove(event: TouchEvent) {
  if (!closeTracking) {
    return;
  }
  if (event.touches.length !== 1) {
    resetCloseSwipe();
    return;
  }
  const touch = event.touches[0];
  const dx = touch.clientX - closeStartX;
  const dy = touch.clientY - closeStartY;
  if (Math.abs(dy) >= CLOSE_SWIPE_VERTICAL_SLOP) {
    resetCloseSwipe();
    return;
  }
  if (!closeHorizontal) {
    if (Math.abs(dx) < CLOSE_SWIPE_DECIDE_SLOP && Math.abs(dy) < CLOSE_SWIPE_DECIDE_SLOP) {
      return;
    }
    // Rightward drags are not ours; the rail is on the left edge already.
    if (dx >= 0 || Math.abs(dy) >= -dx) {
      resetCloseSwipe();
      return;
    }
    closeHorizontal = true;
    // A swipe and a long-press menu cannot be the same gesture.
    clearPress();
  }
  event.preventDefault();
  if (dx <= -CLOSE_SWIPE_DISTANCE) {
    resetCloseSwipe();
    emit('navigate');
  }
}

function onCloseSwipeEnd() {
  resetCloseSwipe();
}

async function toggleFavorite(room: RoomSummary) {
  try {
    await chat.setRoomFavorite(room.id, !room.favorite);
  } catch (error) {
    ElMessage.error(errorMessage(error));
  }
}

async function toggleMute(room: RoomSummary) {
  try {
    await chat.setRoomMuted(room.id, !room.muted);
  } catch (error) {
    ElMessage.error(errorMessage(error));
  }
}

// No toast: the room leaving (or returning to) the rail is the feedback, and
// the 归档 chip makes the move reversible from the same menu.
async function toggleArchive(room: RoomSummary) {
  try {
    await chat.setRoomArchived(room.id, !room.archived);
  } catch (error) {
    ElMessage.error(errorMessage(error));
  }
}

function markRoomRead(room: RoomSummary) {
  chat.markRead(room.id, room.lastMessage?.seq ?? 0);
  chat.markRoomRead(room.id);
}

const markAllBusy = ref(false);

async function markAllRead() {
  if (markAllBusy.value || unreadRoomCount.value === 0) {
    return;
  }
  markAllBusy.value = true;
  try {
    await chat.markAllRead();
    ElMessage.success('已全部标记为已读');
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    markAllBusy.value = false;
  }
}

function onMenuSelect(id: string) {
  const room = menuRoom.value;
  menuOpen.value = false;
  if (!room) {
    return;
  }
  if (id === 'room-menu-favorite') {
    void toggleFavorite(room);
    return;
  }
  if (id === 'room-menu-mute') {
    void toggleMute(room);
    return;
  }
  if (id === 'room-menu-group') {
    groupRoom.value = room;
    groupVisible.value = true;
    return;
  }
  if (id === 'room-menu-archive') {
    void toggleArchive(room);
    return;
  }
  if (id === 'room-menu-read') {
    markRoomRead(room);
  }
}

onBeforeUnmount(() => {
  clearPress();
  resetCloseSwipe();
  if (publicSearchTimer !== null) {
    window.clearTimeout(publicSearchTimer);
    publicSearchTimer = null;
  }
});
</script>

<template>
  <aside
    ref="root"
    class="sidebar"
    @touchstart="onCloseSwipeStart"
    @touchmove="onCloseSwipeMove"
    @touchend="onCloseSwipeEnd"
    @touchcancel="onCloseSwipeEnd"
  >
    <div class="sidebar-brand">
      <span class="brand-logo"><BrandMark :size="22" /></span>
      <div class="brand-copy">
        <div class="brand-name">bot-for-all</div>
        <div class="brand-sub">群聊 · AI 机器人</div>
      </div>
      <button
        class="icon-btn notif-bell"
        data-testid="notifications-bell"
        title="通知"
        aria-label="通知"
        :aria-expanded="notificationsOpen"
        @click="notificationsOpen = !notificationsOpen"
      >
        <Icon name="bell" :size="16" />
        <span
          v-if="chat.notificationsUnread > 0"
          class="notif-badge"
          data-testid="notifications-badge"
        >
          {{ unreadLabel }}
        </span>
      </button>
      <button class="icon-btn" title="个人设置" @click="profileVisible = true">
        <UserAvatar
          size="sm"
          :avatar="auth.user?.avatar ?? null"
          :id="auth.user?.id ?? null"
          :name="auth.user?.displayName ?? null"
        />
      </button>
    </div>

    <div class="sidebar-search">
      <Icon name="search" :size="16" />
      <input v-model="query" aria-label="搜索房间" placeholder="搜索房间" />
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
        公开 <span>{{ publicTabCount }}</span>
      </button>
    </div>

    <div v-if="tab === 'mine'" class="room-filter-row">
      <div class="room-filters" role="group" aria-label="筛选房间">
        <button
          v-for="option in filterOptions"
          :key="option.value"
          type="button"
          class="filter-chip"
          :class="{ active: roomFilter === option.value }"
          :data-testid="`room-filter-${option.value}`"
          :aria-pressed="roomFilter === option.value"
          @click="roomFilter = option.value"
        >
          {{ option.label }}
        </button>
      </div>
      <button
        v-if="unreadRoomCount > 0"
        type="button"
        class="mark-all-read"
        data-testid="mark-all-read"
        :disabled="markAllBusy"
        @click="markAllRead"
      >
        {{ markAllBusy ? '处理中…' : '全部已读' }}
      </button>
    </div>

    <div
      v-if="tab === 'public' && publicKeyword"
      class="room-search-summary"
      data-testid="public-search-summary"
    >
      <span v-if="publicSearchLoading">搜索中…</span>
      <span v-else>共 {{ publicSearchTotal }} 个公开房间</span>
    </div>

    <div class="room-list">
      <div v-for="section in sections" :key="section.key" class="room-section">
        <button
          v-if="section.label"
          type="button"
          class="room-section-head"
          data-testid="room-section"
          :data-section="section.key"
          :aria-expanded="!isCollapsed(section.key)"
          @click="toggleSection(section.key)"
        >
          <span class="room-section-caret">{{ isCollapsed(section.key) ? '▸' : '▾' }}</span>
          <span class="room-section-name">{{ section.label }}</span>
          <span class="room-section-count">{{ section.rooms.length }}</span>
        </button>
        <div v-show="!section.label || !isCollapsed(section.key)" class="room-section-rooms">
          <button
            v-for="room in section.rooms"
            :key="room.id"
            class="room-card"
            data-testid="room-item"
            :class="{ active: room.id === props.activeRoomId }"
            @click="selectRoom(room)"
            @contextmenu.prevent="openMenu($event, room)"
            @pointerdown="startPress($event, room)"
            @pointermove="movePress"
            @pointerup="clearPress"
            @pointercancel="clearPress"
            @pointerleave="clearPress"
          >
            <span class="avatar room-avatar" :class="avatarClass(room.id)">
              {{ initialOf(room.name) }}
            </span>
            <span class="room-info">
              <span class="room-name">
                {{ room.name }}
                <span
                  v-if="room.favorite"
                  class="room-favorite"
                  data-testid="room-favorite"
                  title="已收藏"
                >
                  <Icon name="pin" :size="13" />
                </span>
                <span v-if="room.muted" class="room-muted" data-testid="room-muted">
                  <Icon name="bellOff" :size="13" />
                </span>
                <span v-if="room.unreadCount && !room.muted" class="unread">
                  {{ room.unreadCount }}
                </span>
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
        </div>
      </div>
      <button
        v-if="tab === 'public' && publicHasMore"
        type="button"
        class="room-load-more"
        data-testid="public-load-more"
        :disabled="publicMoreLoading"
        @click="loadMorePublic"
      >
        {{ publicMoreLoading ? '加载中…' : '加载更多' }}
      </button>
      <div v-if="rooms.length === 0" class="sidebar-empty">
        <Icon name="chat" :size="22" />
        <span>{{ emptyLabel }}</span>
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
      v-if="isAdmin"
      class="sidebar-admin"
      data-testid="sidebar-admin"
      title="管理后台"
      @click="router.push('/admin')"
    >
      <Icon name="users" :size="16" />
      <span>管理后台</span>
      <span class="admin-badge">ADMIN</span>
    </button>

    <button class="sidebar-user" @click="profileVisible = true">
      <UserAvatar
        size="sm"
        :avatar="auth.user?.avatar ?? null"
        :id="auth.user?.id ?? null"
        :name="auth.user?.displayName ?? null"
      />
      <span class="sidebar-user-copy">
        <span class="sidebar-user-name">{{ auth.user?.displayName }}</span>
        <span class="sidebar-user-sub">@{{ auth.user?.username }}</span>
      </span>
      <Icon name="settings" :size="16" />
    </button>

    <el-dialog v-model="createVisible" title="创建房间" width="420px" append-to-body>
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

    <el-dialog v-model="joinVisible" title="加入私密房" width="420px" append-to-body>
      <label class="field">
        <span>房间 ID</span>
        <input v-model="joinForm.roomId" placeholder="例如 1" />
      </label>
      <label class="field">
        <span>邀请码</span>
        <input v-model="joinForm.inviteCode" placeholder="8 位邀请码" />
      </label>
      <p class="settings-hint">没有邀请码？提交申请，房主批准后即可加入。</p>
      <template #footer>
        <button class="btn ghost" @click="joinVisible = false">取消</button>
        <button
          class="btn ghost"
          data-testid="join-request-submit"
          :disabled="busy"
          @click="requestJoin"
        >
          申请加入
        </button>
        <button class="btn primary" :disabled="busy" @click="joinRoom">加入</button>
      </template>
    </el-dialog>

    <MessageContextMenu
      :open="menuOpen"
      :x="menuX"
      :y="menuY"
      :items="menuItems"
      @select="onMenuSelect"
      @close="closeMenu"
    />

    <NotificationPanel v-model="notificationsOpen" @navigate="emit('navigate')" />
    <ProfileDialog v-model="profileVisible" />
    <GroupDialog v-model="groupVisible" :room="groupRoom" />
  </aside>
</template>

<style scoped>
/* Filter chips sit under the tabs and only exist on 我的. The chips scroll
   sideways instead of wrapping so three chips cannot push the list down or
   overflow a narrow drawer; 全部已读 keeps a fixed slot on the right. */
.room-filter-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: -4px 12px 8px;
}

.room-filters {
  display: flex;
  flex: 1 1 auto;
  gap: 6px;
  min-width: 0;
  overflow-x: auto;
  overscroll-behavior-x: contain;
  scrollbar-width: none;
}

.room-filters::-webkit-scrollbar {
  display: none;
}

/* Reads as the fourth chip but is an action, so it stays outside the scroll
   area and never pushes the chips out of reach. */
.mark-all-read {
  flex: none;
  height: 24px;
  padding: 0 8px;
  border: none;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--lime);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  transition: background 0.12s ease-out, color 0.12s ease-out;
}

.mark-all-read:hover {
  background: rgba(216, 242, 74, 0.14);
}

.mark-all-read:disabled {
  color: var(--on-ink-dim);
  cursor: default;
}

.filter-chip {
  position: relative;
  flex: none;
  height: 24px;
  padding: 0 10px;
  border: none;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--on-ink-dim);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  transition: background 0.12s ease-out, color 0.12s ease-out;
}

.filter-chip:hover {
  background: rgba(246, 244, 236, 0.07);
  color: var(--on-ink);
}

.filter-chip.active {
  background: rgba(216, 242, 74, 0.14);
  color: var(--lime);
}

/* The underline reads the selection at a glance even when the tint is faint on
   a dark panel. */
.filter-chip.active::after {
  position: absolute;
  left: 10px;
  right: 10px;
  bottom: 2px;
  height: 2px;
  border-radius: 1px;
  background: var(--lime);
  content: '';
}

.room-section + .room-section {
  margin-top: 2px;
}

.room-section-head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 7px 10px 4px;
  border: none;
  background: transparent;
  color: var(--on-ink-dim);
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  font-weight: 700;
  letter-spacing: 0.06em;
  text-align: left;
  cursor: pointer;
  transition: color 0.12s ease-out;
}

.room-section-head:hover {
  color: var(--on-ink-muted);
}

.room-section-caret {
  flex: none;
  width: 10px;
  font-size: 10px;
  line-height: 1;
}

.room-section-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.room-section-count {
  flex: none;
  font-size: var(--fs-mono);
  color: var(--on-ink-dim);
}

/* Server-side search reports its total above the rows; the tab badge keeps
   showing the server's overall public count while the field is empty. */
.room-search-summary {
  margin: 0 12px 6px;
  color: var(--on-ink-dim);
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  letter-spacing: 0.04em;
}

.room-load-more {
  display: block;
  width: calc(100% - 20px);
  margin: 6px 10px 2px;
  padding: 7px 10px;
  border: 1px dashed var(--line-on-ink);
  border-radius: var(--r-md);
  background: transparent;
  color: var(--on-ink-muted);
  font-size: 12px;
  font-weight: 600;
  transition: background 0.12s ease-out, color 0.12s ease-out;
}

.room-load-more:hover {
  background: var(--ink-2);
  color: var(--on-ink);
}

.room-load-more:disabled {
  color: var(--on-ink-dim);
  cursor: default;
}

.room-name > .room-muted {
  display: inline-flex;
  flex: none;
  align-items: center;
  color: var(--on-ink-muted);
}

.room-name > .room-favorite {
  display: inline-flex;
  flex: none;
  align-items: center;
  color: var(--lime);
}

.sidebar-admin {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 16px;
  border: none;
  border-top: 1px solid var(--line-on-ink);
  background: transparent;
  color: var(--on-ink-muted);
  font-size: 13px;
  font-weight: 600;
  text-align: left;
  transition: background 0.12s ease-out, color 0.12s ease-out;
}

.sidebar-admin:hover {
  background: var(--ink-2);
  color: var(--on-ink);
}

.admin-badge {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  font-weight: 700;
  letter-spacing: 0.08em;
  color: var(--lime);
}

/* The brand row keeps the bell on every width: it is the only entry point to
   the mention centre, and the narrow drawer has no topbar copy of it. */
.notif-bell {
  position: relative;
}

.notif-badge {
  position: absolute;
  top: 1px;
  right: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 3px;
  border-radius: var(--r-sm);
  background: var(--lime);
  color: var(--ink);
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  font-weight: 700;
  line-height: 1;
  pointer-events: none;
}
</style>
