<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import http from '../api/http';
import Icon from './Icon.vue';
import { useAuthStore } from '../stores/auth';
import { formatRelative } from '../utils/format';
import type { Announcement } from '../types';

/**
 * Dismissals are stored per account (`{ "u7": [12] }`) so a second person on
 * the same browser still sees the notice, while a refresh keeps it hidden for
 * the person who closed it. Only the newest ids are kept — the server never
 * serves an older active post, so anything older is dead weight.
 */
const DISMISS_KEY = 'bfa_announcement_dismissed';
const DISMISS_KEEP = 20;

const auth = useAuthStore();

const announcement = ref<Announcement | null>(null);
const dismissed = ref<Set<number>>(new Set());
// Bumped on every load so a slow reply for the previous account cannot paint
// over the banner the current account is looking at.
let requestSeq = 0;

const scope = computed(() => `u${auth.user?.id ?? 0}`);

const current = computed<Announcement | null>(() => {
  const item = announcement.value;
  if (!item || dismissed.value.has(item.id)) {
    return null;
  }
  return item;
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readDismissals(key: string): Set<number> {
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    if (!raw) {
      return new Set();
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return new Set();
    }
    const list = parsed[key];
    if (!Array.isArray(list)) {
      return new Set();
    }
    return new Set(
      list.filter((id): id is number => typeof id === 'number' && Number.isInteger(id)),
    );
  } catch {
    return new Set();
  }
}

function writeDismissals(key: string, ids: Set<number>) {
  try {
    const map: Record<string, number[]> = {};
    const raw = localStorage.getItem(DISMISS_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (isRecord(parsed)) {
        for (const [bucket, value] of Object.entries(parsed)) {
          if (Array.isArray(value)) {
            map[bucket] = value.filter(
              (id): id is number => typeof id === 'number' && Number.isInteger(id),
            );
          }
        }
      }
    }
    map[key] = [...ids].slice(-DISMISS_KEEP);
    localStorage.setItem(DISMISS_KEY, JSON.stringify(map));
  } catch {
    /* Storage blocked: the dismissal still holds for this session. */
  }
}

async function load() {
  const seq = ++requestSeq;
  try {
    const { data } = await http.get<{ announcement: Announcement | null }>(
      '/announcements/current',
    );
    if (seq !== requestSeq) {
      return;
    }
    announcement.value = data.announcement ?? null;
  } catch {
    // A notice that cannot load is not worth an error toast; the next login or
    // reload retries it.
    if (seq === requestSeq) {
      announcement.value = null;
    }
  }
}

function dismiss() {
  const item = announcement.value;
  if (!item) {
    return;
  }
  const next = new Set(dismissed.value);
  next.add(item.id);
  dismissed.value = next;
  writeDismissals(scope.value, next);
}

// Login, logout and token rotation all land here: the banner is reloaded for
// the account that is signed in now, and a fresh post shows again because its
// id was never dismissed.
watch(
  [() => auth.token, scope],
  ([token]) => {
    dismissed.value = readDismissals(scope.value);
    if (!token) {
      requestSeq += 1;
      announcement.value = null;
      return;
    }
    void load();
  },
  { immediate: true },
);
</script>

<template>
  <div
    v-if="current"
    class="announcement-bar"
    data-testid="announcement-banner"
    role="status"
  >
    <span class="announcement-tag">
      <Icon name="megaphone" :size="14" />
      平台公告
    </span>
    <p class="announcement-body" :title="current.body">{{ current.body }}</p>
    <span class="announcement-meta mono">
      {{ current.actorName }} · {{ formatRelative(current.createdAt) }}
    </span>
    <button
      class="icon-btn announcement-close"
      data-testid="announcement-close"
      title="关闭公告"
      aria-label="关闭公告"
      @click="dismiss"
    >
      <Icon name="close" :size="14" />
    </button>
  </div>
</template>

<style scoped>
/* Layout row, not an overlay: it pushes the app down instead of covering it,
   so the chat topbar, composer and scroll positions stay untouched. */
.announcement-bar {
  display: flex;
  flex: none;
  align-items: center;
  gap: 10px;
  padding: 8px 18px;
  border-bottom: 1px solid var(--line);
  background: var(--paper);
  background: var(--glass-bar);
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-sat));
  backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-sat));
  box-shadow: inset 0 1px 0 var(--glass-hi);
  color: var(--text);
  font-size: var(--fs-sub);
}

.announcement-tag {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 5px;
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  font-weight: 700;
  letter-spacing: 0.08em;
  white-space: nowrap;
}

.announcement-body {
  flex: 1;
  min-width: 0;
  margin: 0;
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  line-height: 1.45;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.announcement-meta {
  flex: none;
  color: var(--muted);
  white-space: nowrap;
}

.announcement-close {
  flex: none;
}

@media (max-width: 640px) {
  .announcement-bar {
    padding: 8px 12px;
    gap: 8px;
  }

  .announcement-meta {
    display: none;
  }
}
</style>
