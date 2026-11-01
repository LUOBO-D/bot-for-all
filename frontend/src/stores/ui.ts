import { ref, watch } from 'vue';
import { defineStore } from 'pinia';

export type Density = 'comfort' | 'compact';

const STORAGE_KEY = 'bfa-density';

export const useUiStore = defineStore('ui', () => {
  const density = ref<Density>(
    localStorage.getItem(STORAGE_KEY) === 'compact' ? 'compact' : 'comfort',
  );

  watch(
    density,
    (value) => {
      document.documentElement.dataset.density = value;
      localStorage.setItem(STORAGE_KEY, value);
    },
    { immediate: true },
  );

  function toggle() {
    density.value = density.value === 'compact' ? 'comfort' : 'compact';
  }

  return { density, toggle };
});
