<script setup lang="ts">
withDefaults(defineProps<{ size?: number }>(), { size: 22 });
</script>

<template>
  <svg
    class="brand-mark"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden="true"
  >
    <!-- room -->
    <rect x="3.5" y="4.5" width="14" height="14" rx="1.5" stroke="currentColor" stroke-width="2" />
    <!-- member joining the room, lime dot on the corner -->
    <circle cx="19.5" cy="5.5" r="3.1" class="mark-dot" />
  </svg>
</template>
