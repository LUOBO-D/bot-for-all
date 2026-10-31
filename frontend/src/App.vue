<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import CommandPalette from './components/CommandPalette.vue';

const paletteOpen = ref(false);

function onKeydown(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    paletteOpen.value = !paletteOpen.value;
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown));
onUnmounted(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <router-view v-slot="{ Component }">
    <transition name="page" mode="out-in">
      <component :is="Component" />
    </transition>
  </router-view>
  <CommandPalette v-model="paletteOpen" />
</template>
