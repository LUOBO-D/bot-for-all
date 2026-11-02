<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { avatarClass, initialOf } from '../utils/format';

const props = withDefaults(
  defineProps<{
    // Avatar URL from the API (`/api/users/<id>/avatar?v=<token>`), or null.
    avatar?: string | null;
    id?: number | null;
    name?: string | null;
    size?: 'sm' | 'md' | 'lg';
    // Bots keep the rust-hairline treatment when the letter has to show.
    bot?: boolean;
  }>(),
  { avatar: null, id: null, name: null, size: 'md', bot: false },
);

// Only a URL can become an <img src>. A legacy row may still hold a bare
// filename or an old token; that must never be glued onto an API path.
const src = computed(() => {
  const value = props.avatar?.trim();
  return value && /^(?:\/|https?:\/\/)/.test(value) ? value : null;
});

// A broken image falls back to the letter for the rest of this URL's life. A
// new upload carries a new URL, so the latch resets and it gets a fresh try.
const failed = ref(false);
watch(src, () => {
  failed.value = false;
});

const showImage = computed(() => src.value !== null && !failed.value);
const initial = computed(() => initialOf(props.name ?? ''));
const classes = computed(() => [
  props.size === 'sm' ? 'avatar-sm' : props.size === 'lg' ? 'avatar-lg' : '',
  props.bot ? 'bot-avatar' : '',
  showImage.value ? 'has-image' : avatarClass(props.id ?? 0),
]);
</script>

<template>
  <span class="avatar" :class="classes">
    <img
      v-if="showImage"
      class="avatar-img"
      :src="src ?? undefined"
      alt=""
      decoding="async"
      loading="lazy"
      draggable="false"
      @error="failed = true"
    />
    <template v-else>{{ initial }}</template>
  </span>
</template>

<style scoped>
/* An image owns the whole box: no thick ink fill and no hairline peeking out
   around the bitmap (the palette classes are skipped while an image shows).
   `span` in the selector outranks `.msg.bot > .avatar`, which paints its own
   bot background and border onto the same element. */
span.avatar.has-image {
  background: transparent;
  border: none;
  overflow: hidden;
}

.avatar-img {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: inherit;
  object-fit: cover;
}
</style>
