<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AnnouncementBanner from './components/AnnouncementBanner.vue';
import CommandPalette from './components/CommandPalette.vue';
import DraftsDialog from './components/DraftsDialog.vue';
import SavedMessagesDialog from './components/SavedMessagesDialog.vue';
import ShortcutsDialog from './components/ShortcutsDialog.vue';
import SkyField from './components/SkyField.vue';
import OfflineGate from './components/OfflineGate.vue';
import { useAuthStore } from './stores/auth';
import { useChatStore } from './stores/chat';
import type { RoomSummary } from './types';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

// A boot-time /auth/me failure keeps the token and flags the session offline;
// until a retry succeeds there is no user and nothing renders behind the gate.
const offlineBlocked = computed(() => auth.offline && !!auth.token);
const chat = useChatStore();

const paletteOpen = ref(false);
const shortcutsOpen = ref(false);
const savedOpen = ref(false);
const draftsOpen = ref(false);

// Joined rooms in sidebar order. Public rooms only join the ring when the
// server already counts them as joined, so Alt+↑/↓ never drags the user into
// a room that still needs an explicit join.
const joinedRooms = computed<RoomSummary[]>(() => {
  const seen = new Set<number>();
  const list: RoomSummary[] = [];
  for (const room of chat.rooms.mine) {
    if (seen.has(room.id)) {
      continue;
    }
    seen.add(room.id);
    list.push(room);
  }
  for (const room of chat.rooms.public) {
    if (!room.joined || seen.has(room.id)) {
      continue;
    }
    seen.add(room.id);
    list.push(room);
  }
  return list;
});

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';
}

function isHelpShortcut(event: KeyboardEvent): boolean {
  if (event.key === '?') {
    return true;
  }
  return (event.metaKey || event.ctrlKey) && (event.key === '/' || event.code === 'Slash');
}

function switchRoom(delta: number) {
  if (!route.path.startsWith('/rooms/')) {
    return;
  }
  const raw = route.params.id;
  const current = Number(Array.isArray(raw) ? raw[0] : raw);
  if (!Number.isInteger(current) || current <= 0) {
    return;
  }
  const rooms = joinedRooms.value;
  if (rooms.length < 2) {
    return;
  }
  const index = rooms.findIndex((room) => room.id === current);
  if (index === -1) {
    return;
  }
  const next = rooms[(index + delta + rooms.length) % rooms.length];
  if (next.id === current) {
    return;
  }
  void router.push(`/rooms/${next.id}`);
}

function onKeydown(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    // The saved list and draft box are modal sheets; Ctrl+K swaps either for
    // the command palette instead of stacking a second dialog on top.
    if (savedOpen.value || draftsOpen.value) {
      savedOpen.value = false;
      draftsOpen.value = false;
      paletteOpen.value = true;
      return;
    }
    shortcutsOpen.value = false;
    paletteOpen.value = !paletteOpen.value;
    return;
  }
  if (event.key === 'Escape' && shortcutsOpen.value) {
    event.preventDefault();
    shortcutsOpen.value = false;
    return;
  }
  if (event.key === 'Escape' && savedOpen.value) {
    event.preventDefault();
    savedOpen.value = false;
    return;
  }
  if (event.key === 'Escape' && draftsOpen.value) {
    event.preventDefault();
    draftsOpen.value = false;
    return;
  }
  // Modals own their keyboard while open; only the palette's own Esc handling
  // and the help sheet's Esc above stay reachable.
  if (paletteOpen.value || shortcutsOpen.value || savedOpen.value || draftsOpen.value) {
    return;
  }
  if (
    event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    (event.key === 'ArrowUp' || event.key === 'ArrowDown')
  ) {
    event.preventDefault();
    switchRoom(event.key === 'ArrowUp' ? -1 : 1);
    return;
  }
  // Help never steals keys from a field the user is typing in.
  if (isTypingTarget(event.target)) {
    return;
  }
  if (isHelpShortcut(event)) {
    event.preventDefault();
    shortcutsOpen.value = true;
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown));
onUnmounted(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <SkyField />
  <div class="app-shell">
    <OfflineGate v-if="offlineBlocked" />
    <template v-else>
      <AnnouncementBanner />
      <div class="app-body">
        <router-view />
      </div>
      <CommandPalette
        v-model="paletteOpen"
        @shortcuts="shortcutsOpen = true"
        @saved="savedOpen = true"
        @drafts="draftsOpen = true"
      />
      <SavedMessagesDialog v-model="savedOpen" />
      <DraftsDialog v-model="draftsOpen" />
      <ShortcutsDialog v-model="shortcutsOpen" />
    </template>
  </div>
</template>

<style scoped>
/* The banner is a layout row, so it shortens the app instead of covering it:
   the second row is the only thing that scrolls, exactly as before. */
.app-shell {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  height: 100%;
  /* 进房首帧星幕亮起: one-shot 400ms reveal on app mount — CSS only,
     plays once, never on route changes (the shell never remounts).
     SkyField rises in step behind it (.sky's own sky-rise). */
  animation: app-rise 0.4s ease-out both;
}

@keyframes app-rise {
  from {
    opacity: 0;
  }
}

.app-body {
  min-height: 0;
}

@media (prefers-reduced-motion: reduce) {
  .app-shell {
    animation: none;
  }
}
</style>
