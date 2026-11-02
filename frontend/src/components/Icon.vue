<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{ name: string; size?: number }>();

const paths: Record<string, string> = {
  menu: 'M4 6h16M4 12h16M4 18h16',
  users:
    'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  bot: 'M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8L12 3zM5 19l1-2.4L8.4 16 6 15l-1-2.4L4 15l-2.4 1L4 16.6 5 19z',
  settings: 'M4 7h10M18 7h2M4 17h2M10 17h10M15 4v6M9 14v6',
  send: 'M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35',
  plus: 'M12 5v14M5 12h14',
  close: 'M18 6L6 18M6 6l12 12',
  copy: 'M8 8h12v12H8zM16 8V4H4v12h4',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  arrowDown: 'M12 5v14M19 12l-7 7-7-7',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z',
  check: 'M20 6L9 17l-5-5',
  link: 'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1',
  reply: 'M9 17l-5-5 5-5M4 12h10a6 6 0 0 1 6 6v1',
  forward: 'M15 7l5 5-5 5M20 12H10a6 6 0 0 0-6 6v1',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  pin: 'M12 17v5M9 3h6l-1 6 3 3v2H7v-2l3-3-1-6z',
  trash: 'M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v5M14 11v5',
  smile:
    'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M8.5 14a4 4 0 0 0 7 0M9 9h.01M15 9h.01',
  hash: 'M4 9h16M4 15h16M10 3L8 21M16 3l-2 18',
  bell: 'M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0',
  bellOff:
    'M13.7 21a2 2 0 0 1-3.4 0M18.6 13A17 17 0 0 0 18 8M6.3 6.3A6 6 0 0 0 6 8c0 7-3 9-3 9h14M3 3l18 18',
  megaphone:
    'M3 10v4a1 1 0 0 0 1 1h3l5 4V5L7 9H4a1 1 0 0 0-1 1zM16 8a4 4 0 0 1 0 8M19 5a8 8 0 0 1 0 14',
  chat: 'M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M12 7v5l3 2',
};

const d = computed(() => paths[props.name] ?? paths.chat);
const dimension = computed(() => props.size ?? 18);
</script>

<template>
  <svg
    :width="dimension"
    :height="dimension"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path :d="d" />
  </svg>
</template>
