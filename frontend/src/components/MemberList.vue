<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useAuthStore } from '../stores/auth';
import type { Member } from '../types';
import MessageContextMenu from './MessageContextMenu.vue';
import UserAvatar from './UserAvatar.vue';

// Mirrors MessageContextMenu's item contract.
interface MenuItem {
  id: string;
  label: string;
  icon?: string;
  danger?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
}

const props = defineProps<{ members: Member[]; roomId?: number }>();
const emit = defineEmits<{
  kick: [member: Member];
  'set-role': [member: Member, role: 'admin' | 'member'];
  // The batch is applied by the parent; `done` reports the outcome so the
  // selection survives a failed request and clears after a successful one.
  'set-roles': [userIds: number[], role: 'admin' | 'member', done: (ok: boolean) => void];
  'remove-members': [userIds: number[], done: (ok: boolean) => void];
  profile: [member: Member];
}>();

const auth = useAuthStore();
const humans = computed(() => props.members.filter((member) => member.type === 'human'));
const bots = computed(() => props.members.filter((member) => member.type === 'bot'));

// The filter is view-only: selection, bulk actions and the context menu keep
// operating on the full roster, so narrowing the list never silently drops a
// member that is already queued for a role change or removal.
const filter = ref('');
const filterQuery = computed(() => filter.value.trim().toLowerCase());

function matchesFilter(member: Member): boolean {
  const query = filterQuery.value;
  if (!query) {
    return true;
  }
  return (
    member.displayName.toLowerCase().includes(query) ||
    member.username.toLowerCase().includes(query)
  );
}

const visibleHumans = computed(() => humans.value.filter(matchesFilter));
const visibleBots = computed(() => bots.value.filter(matchesFilter));

// While a search narrows the roster the heading reads `matched/total`; with an
// empty query the total alone is shown, so the common case stays unchanged.
function headingCount(matched: number, total: number): string {
  return filterQuery.value ? `${matched}/${total}` : `${total}`;
}

// The viewer's own room role decides which member actions are offered; the
// server re-checks every one of them.
const selfRole = computed(
  () => props.members.find((member) => member.userId === auth.user?.id)?.role ?? null,
);
const isOwner = computed(() => selfRole.value === 'owner');
const isRoomAdmin = computed(() => selfRole.value === 'admin');
const isGlobalAdmin = computed(() => auth.user?.role === 'admin');
const canAssignRoles = computed(() => isOwner.value || isGlobalAdmin.value);

// Bulk role assignment: only the roles a single setMemberRole call accepts are
// selectable, so the owner and bots never enter a batch the server rejects.
const selectedIds = ref<number[]>([]);
const bulkBusy = ref(false);

function isSelectable(member: Member): boolean {
  return (
    canAssignRoles.value &&
    member.type === 'human' &&
    (member.role === 'member' || member.role === 'admin')
  );
}

const selectableMembers = computed(() => humans.value.filter(isSelectable));
const showRoleTools = computed(() => selectableMembers.value.length > 0);
const allSelected = computed(
  () =>
    selectableMembers.value.length > 0 &&
    selectableMembers.value.every((member) => selectedIds.value.includes(member.userId)),
);

function isSelected(userId: number): boolean {
  return selectedIds.value.includes(userId);
}

function toggleSelect(userId: number) {
  selectedIds.value = isSelected(userId)
    ? selectedIds.value.filter((id) => id !== userId)
    : [...selectedIds.value, userId];
}

function toggleSelectAll() {
  selectedIds.value = allSelected.value
    ? []
    : selectableMembers.value.map((member) => member.userId);
}

// A member who leaves, loses the room, or becomes a bot must not stay in a
// pending batch.
watch(
  () => props.members,
  (members) => {
    const allowed = new Set(members.filter(isSelectable).map((member) => member.userId));
    const kept = selectedIds.value.filter((id) => allowed.has(id));
    if (kept.length !== selectedIds.value.length) {
      selectedIds.value = kept;
    }
  },
);

// The panel stays mounted across room switches; a selection made in one room
// must not leak into the next.
watch(
  () => props.roomId,
  () => {
    selectedIds.value = [];
  },
);

async function applyRole(role: 'admin' | 'member') {
  const userIds = [...selectedIds.value];
  if (userIds.length === 0 || bulkBusy.value) {
    return;
  }
  const label = role === 'admin' ? '管理员' : '普通成员';
  try {
    await ElMessageBox.confirm(
      `确定将选中的 ${userIds.length} 名成员设为${label}？`,
      '批量调整角色',
      { confirmButtonText: '确定', cancelButtonText: '取消', type: 'warning' },
    );
  } catch {
    return;
  }
  bulkBusy.value = true;
  try {
    const applied = await new Promise<boolean>((resolve) => {
      emit('set-roles', userIds, role, resolve);
    });
    if (applied) {
      selectedIds.value = [];
    }
  } finally {
    bulkBusy.value = false;
  }
}

// Bulk removal runs through the parent too: a failed request keeps the
// selection so the owner can retry without re-picking members.
async function applyRemove() {
  const userIds = [...selectedIds.value];
  if (userIds.length === 0 || bulkBusy.value) {
    return;
  }
  try {
    await ElMessageBox.confirm(
      `确定将选中的 ${userIds.length} 名成员移出房间？`,
      '批量移出成员',
      { confirmButtonText: '确定', cancelButtonText: '取消', type: 'warning' },
    );
  } catch {
    return;
  }
  bulkBusy.value = true;
  try {
    const applied = await new Promise<boolean>((resolve) => {
      emit('remove-members', userIds, resolve);
    });
    if (applied) {
      selectedIds.value = [];
    }
  } finally {
    bulkBusy.value = false;
  }
}

const menuOpen = ref(false);
const menuX = ref(0);
const menuY = ref(0);
const menuMember = ref<Member | null>(null);

const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP = 10;
let pressTimer: number | null = null;
let pressStartX = 0;
let pressStartY = 0;
// A long press opens the menu; the click that follows pointerup must not also
// open the profile card. A timestamp self-heals when no click follows.
let longPressAt = 0;
const LONG_PRESS_GUARD_MS = 700;

function canChangeRole(member: Member): boolean {
  return canAssignRoles.value && (member.role === 'member' || member.role === 'admin');
}

function canKick(member: Member): boolean {
  if (member.userId === auth.user?.id || member.role === 'owner') {
    return false;
  }
  if (isOwner.value || isGlobalAdmin.value) {
    return true;
  }
  return isRoomAdmin.value && member.role === 'member';
}

const menuItems = computed<MenuItem[]>(() => {
  const member = menuMember.value;
  if (!member) {
    return [];
  }
  const items: MenuItem[] = [{ id: 'member-copy', label: '复制用户名', icon: 'copy' }];
  if (canChangeRole(member)) {
    items.push({
      id: 'member-role',
      label: member.role === 'admin' ? '取消管理员' : '设为管理员',
      icon: 'users',
    });
  }
  if (canKick(member)) {
    items.push({
      id: 'member-kick',
      label: '移出房间',
      icon: 'trash',
      danger: true,
      separatorBefore: true,
    });
  }
  return items;
});

function openMenuAt(x: number, y: number, member: Member) {
  menuMember.value = member;
  menuX.value = x;
  menuY.value = y;
  menuOpen.value = true;
}

function openMenu(event: MouseEvent, member: Member) {
  openMenuAt(event.clientX, event.clientY, member);
}

function closeMenu() {
  menuOpen.value = false;
}

// Row click / Enter / Space opens the member profile card. A click that ends a
// long press (which already opened the menu) is swallowed.
function openProfile(member: Member) {
  if (Date.now() - longPressAt < LONG_PRESS_GUARD_MS) {
    return;
  }
  if (menuOpen.value) {
    return;
  }
  emit('profile', member);
}

function clearPress() {
  if (pressTimer !== null) {
    window.clearTimeout(pressTimer);
    pressTimer = null;
  }
}

// Touch/pen long press opens the same menu as right click.
function startPress(event: PointerEvent, member: Member) {
  if (event.pointerType === 'mouse') {
    return;
  }
  pressStartX = event.clientX;
  pressStartY = event.clientY;
  clearPress();
  pressTimer = window.setTimeout(() => {
    pressTimer = null;
    longPressAt = Date.now();
    openMenuAt(pressStartX, pressStartY, member);
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

async function copyUsername(member: Member) {
  try {
    await navigator.clipboard.writeText(member.username);
    ElMessage.success('已复制用户名');
  } catch {
    ElMessage.info(member.username);
  }
}

function onMenuSelect(id: string) {
  const member = menuMember.value;
  menuOpen.value = false;
  if (!member) {
    return;
  }
  if (id === 'member-copy') {
    void copyUsername(member);
    return;
  }
  if (id === 'member-role') {
    emit('set-role', member, member.role === 'admin' ? 'member' : 'admin');
    return;
  }
  if (id === 'member-kick') {
    emit('kick', member);
  }
}

onBeforeUnmount(clearPress);
</script>

<template>
  <div class="member-list">
    <div class="member-filter-bar">
      <input
        v-model="filter"
        type="search"
        class="member-filter"
        data-testid="member-filter"
        placeholder="搜索成员"
        aria-label="按名称或用户名搜索成员"
        autocomplete="off"
      />
    </div>
    <div v-if="showRoleTools" class="member-role-tools" data-testid="member-role-tools">
      <label class="member-select-all">
        <input
          type="checkbox"
          data-testid="member-select-all"
          :checked="allSelected"
          aria-label="全选可调整角色的成员"
          @change="toggleSelectAll"
        />
        <span>全选</span>
      </label>
      <div class="member-role-buttons">
        <button
          type="button"
          class="member-role-button"
          data-testid="member-bulk-admin"
          :disabled="selectedIds.length === 0 || bulkBusy"
          @click="applyRole('admin')"
        >
          设为管理员
        </button>
        <button
          type="button"
          class="member-role-button"
          data-testid="member-bulk-member"
          :disabled="selectedIds.length === 0 || bulkBusy"
          @click="applyRole('member')"
        >
          取消管理员
        </button>
        <button
          type="button"
          class="member-role-button member-remove-button"
          data-testid="member-bulk-remove"
          :disabled="selectedIds.length === 0 || bulkBusy"
          @click="applyRemove"
        >
          移出选中
        </button>
      </div>
    </div>
    <div class="member-section">
      <div class="member-heading">
        人类
        <span>{{ headingCount(visibleHumans.length, humans.length) }}</span>
      </div>
      <div
        v-for="member in visibleHumans"
        :key="member.userId"
        class="member-row"
        :class="{ online: member.online }"
        data-testid="member-row"
        role="button"
        tabindex="0"
        :aria-label="`查看 ${member.displayName} 的资料`"
        @click="openProfile(member)"
        @keydown.enter.prevent="openProfile(member)"
        @keydown.space.prevent="openProfile(member)"
        @contextmenu.prevent="openMenu($event, member)"
        @pointerdown="startPress($event, member)"
        @pointermove="movePress"
        @pointerup="clearPress"
        @pointercancel="clearPress"
        @pointerleave="clearPress"
      >
        <label
          v-if="isSelectable(member)"
          class="member-select-wrap"
          @click.stop
          @keydown.stop
          @pointerdown.stop
          @pointermove.stop
          @pointerup.stop
        >
          <input
            type="checkbox"
            class="member-select"
            data-testid="member-select"
            :checked="isSelected(member.userId)"
            :aria-label="`选择 ${member.displayName}`"
            @change="toggleSelect(member.userId)"
          />
        </label>
        <UserAvatar
          size="sm"
          :avatar="member.avatar"
          :id="member.userId"
          :name="member.displayName"
        />
        <span class="member-copy">
          <span class="member-name">
            {{ member.displayName }}
            <span v-if="member.role === 'owner'" class="role-tag">房主</span>
            <span v-else-if="member.role === 'admin'" class="role-tag">管理员</span>
          </span>
          <span class="member-sub">@{{ member.username }}</span>
          <span
            v-if="member.statusEmoji || member.statusText"
            class="member-status"
            :title="[member.statusEmoji, member.statusText].filter(Boolean).join(' ')"
          >
            <span v-if="member.statusEmoji" class="member-status-emoji">{{ member.statusEmoji }}</span>
            <span v-if="member.statusText" class="member-status-text">{{ member.statusText }}</span>
          </span>
        </span>
        <span
          class="presence-dot"
          :class="{ online: member.online }"
          role="img"
          :aria-label="member.online ? '在线' : '离线'"
        ></span>
      </div>
      <div v-if="visibleHumans.length === 0" class="member-empty">
        {{ filterQuery ? '没有匹配的成员' : '暂无人类成员' }}
      </div>
    </div>

    <div class="member-section">
      <div class="member-heading">
        机器人
        <span>{{ headingCount(visibleBots.length, bots.length) }}</span>
      </div>
      <div
        v-for="member in visibleBots"
        :key="member.userId"
        class="member-row"
        :class="{ online: member.online }"
        data-testid="member-row"
        role="button"
        tabindex="0"
        :aria-label="`查看 ${member.displayName} 的资料`"
        @click="openProfile(member)"
        @keydown.enter.prevent="openProfile(member)"
        @keydown.space.prevent="openProfile(member)"
      >
        <UserAvatar
          size="sm"
          bot
          :avatar="member.avatar"
          :id="member.userId"
          :name="member.displayName"
        />
        <span class="member-copy">
          <span class="member-name">
            {{ member.displayName }}
            <span class="bot-tag">BOT</span>
          </span>
          <span class="member-sub">@{{ member.username }}</span>
        </span>
        <span
          class="presence-dot"
          :class="{ online: member.online }"
          role="img"
          :aria-label="member.online ? '在线' : '离线'"
        ></span>
      </div>
      <div v-if="visibleBots.length === 0" class="member-empty">
        {{ filterQuery ? '没有匹配的成员' : '还没有机器人' }}
      </div>
    </div>

    <MessageContextMenu
      :open="menuOpen"
      :x="menuX"
      :y="menuY"
      :items="menuItems"
      @select="onMenuSelect"
      @close="closeMenu"
    />
  </div>
</template>

<style scoped>
.member-filter-bar {
  margin-bottom: 10px;
}

.member-filter {
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--line-strong);
  border-radius: var(--r-sm);
  background: var(--paper);
  color: var(--text);
  font-size: var(--fs-sub);
  outline: none;
  transition: border-color 0.12s ease-out, background 0.12s ease-out;
}

.member-filter:focus {
  border-color: var(--ink);
  background: var(--paper-2);
}

.member-filter::placeholder {
  color: var(--faint);
}

.member-role-tools {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 12px;
  padding: 8px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--paper-2);
}

.member-select-all {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  color: var(--muted);
  cursor: pointer;
}

.member-select-wrap {
  display: flex;
  align-items: center;
  flex: none;
  cursor: pointer;
}

.member-select,
.member-select-all input {
  width: 14px;
  height: 14px;
  margin: 0;
  accent-color: var(--ink);
  cursor: pointer;
}

.member-role-buttons {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
  min-width: 0;
}

.member-role-button {
  padding: 3px 8px;
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  color: var(--text);
  background: var(--paper);
  border: 1px solid var(--line-strong);
  border-radius: var(--r-sm);
  cursor: pointer;
}

.member-role-button:hover:not(:disabled) {
  background: var(--paper-3);
}

.member-role-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.member-remove-button {
  color: var(--danger);
  border-color: var(--danger);
}

.member-remove-button:hover:not(:disabled) {
  background: var(--danger-soft);
}

.member-row {
  cursor: pointer;
}

.member-row:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: -1px;
}

.member-status {
  display: flex;
  align-items: baseline;
  gap: 4px;
  min-width: 0;
  font-size: var(--fs-mono);
  line-height: 1.45;
  color: var(--muted);
}

.member-status-emoji {
  flex: none;
}

.member-status-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
