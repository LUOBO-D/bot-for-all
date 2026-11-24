<script setup lang="ts">
import { ref } from 'vue';
import { useAuthStore } from '../stores/auth';

// The only surface the `offline` flag has: a boot-time /auth/me failure (the
// server unreachable, a 5xx) kept the token but produced no user, so the
// sessions cannot render anything meaningful yet. A retry re-runs the same
// fetchMe boot step in main.ts; success clears `offline` and the app mounts
// behind this gate as normal, an explicit auth rejection logs out instead.
const auth = useAuthStore();
const retrying = ref(false);

async function retryBoot() {
  if (retrying.value) {
    return;
  }
  retrying.value = true;
  try {
    await auth.fetchMe();
  } finally {
    retrying.value = false;
  }
}
</script>

<template>
  <div class="offline-gate" role="alert" data-testid="offline-gate">
    <div class="offline-card">
      <p class="offline-title">无法连接服务器</p>
      <p class="offline-text">登录状态已保留，请检查网络后重试。</p>
      <button
        class="btn primary"
        type="button"
        data-testid="offline-retry"
        :disabled="retrying"
        :aria-busy="retrying"
        @click="retryBoot"
      >
        {{ retrying ? '正在重试…' : '重试' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.offline-gate {
  /* The gate replaces the whole app shell content, so it owns the screen. */
  grid-row: 1 / -1;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 0;
  padding: 24px;
  background: var(--paper);
}

.offline-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 360px;
  width: 100%;
  padding: 24px 20px;
  text-align: center;
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  background: var(--paper);
}

.offline-title {
  margin: 0;
  color: var(--danger);
  font-weight: 700;
}

.offline-text {
  margin: 0;
  color: var(--muted);
  font-size: var(--fs-sub);
}
</style>
