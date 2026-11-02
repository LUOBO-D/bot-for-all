<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import http, { errorMessage } from '../api/http';
import { useAuthStore } from '../stores/auth';
import { useChatStore } from '../stores/chat';
import type { Message, Poll, PollOption } from '../types';
import Icon from './Icon.vue';

// `canClose` is the server-side author/moderator rule computed by the parent;
// the card only adds the `closed` half so the button disappears the moment the
// deadline passes, even before the next poll refresh from the server.
const props = defineProps<{ poll: Poll; canClose?: boolean }>();
const emit = defineEmits<{
  vote: [optionIds: number[], done: (ok: boolean) => void];
  close: [done: (ok: boolean) => void];
}>();

const auth = useAuthStore();
const chat = useChatStore();
// Pending ballot for this card. It starts as the viewer's recorded votes and
// only leaves that state once they pick something (`dirty`), so a vote pushed
// by another member never wipes a choice in progress.
const selection = ref<number[]>([]);
const dirty = ref(false);
const submitting = ref(false);
const closing = ref(false);
const exporting = ref(false);
const now = ref(Date.now());
// Anonymous polls carry no voters in the message row, so the viewer's own
// ballot is loaded from `poll/my-votes`. `myVotes` mirrors the last known
// server ballot for this card; `votesLoading` only drives the button label.
const anonymous = computed(() => Boolean(props.poll.anonymous));
const myVotes = ref<number[]>([]);
const votesLoading = ref(false);
// Guards the asynchronous my-votes load: a response that started before a
// vote (or before the poll changed) must never overwrite the current ballot.
let votesToken = 0;
let clock: number | undefined;

const deadline = computed(() => {
  const raw = props.poll.closesAt;
  if (!raw) {
    return null;
  }
  const ts = Date.parse(raw);
  return Number.isFinite(ts) ? ts : null;
});
// `closed` is authoritative from the server, but a card left open on screen
// must flip on its own the moment the deadline passes.
const closed = computed(
  () => props.poll.closed || (deadline.value != null && deadline.value <= now.value),
);
const deadlineText = computed(() => {
  const ts = deadline.value;
  if (ts == null) {
    return '';
  }
  const date = new Date(ts);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
});
const votedIds = computed(() => {
  const userId = auth.user?.id;
  if (userId == null) {
    return [];
  }
  return props.poll.options
    .filter((option) => option.userIds.includes(userId))
    .map((option) => option.id);
});
// Who the viewer voted for: the server row for normal polls, the cached
// my-votes ballot for anonymous ones (whose `userIds` is always empty).
const ownIds = computed(() => (anonymous.value ? myVotes.value : votedIds.value));
const votedKey = computed(() => [...ownIds.value].sort((a, b) => a - b).join(','));
const selectedKey = computed(() => [...selection.value].sort((a, b) => a - b).join(','));
const submitLabel = computed(() => {
  if (submitting.value) {
    return '提交中…';
  }
  if (closed.value) {
    return '已截止';
  }
  if (anonymous.value && votesLoading.value && selection.value.length === 0) {
    return '加载中…';
  }
  if (!dirty.value && ownIds.value.length > 0) {
    return '已投票';
  }
  return ownIds.value.length > 0 ? '更新投票' : '投票';
});
const canSubmit = computed(
  () =>
    !closed.value &&
    !submitting.value &&
    selection.value.length > 0 &&
    selection.value.length <= 10 &&
    (dirty.value || ownIds.value.length === 0),
);
// Early closing is a destructive, irreversible action, so it is offered only
// before the deadline and only to the author/moderators.
const showClose = computed(() => Boolean(props.canClose) && !closed.value);

// The option tooltip lists who picked it. Anonymous polls never carry voters
// (`userIds` is empty for everyone), so those options stay anonymous instead of
// implying an empty ballot. A voter who left the room is shown by id.
function optionTitle(option: PollOption): string {
  if (anonymous.value) {
    return '匿名投票';
  }
  if (option.userIds.length === 0) {
    return '投票人：暂无';
  }
  const names = option.userIds.map((userId) => {
    const member = chat.currentMembers.find((item) => item.userId === userId);
    return member?.displayName ?? `用户#${userId}`;
  });
  return `投票人：${names.join('、')}`;
}

function resetSelection() {
  selection.value = [...ownIds.value];
  dirty.value = false;
}

// Anonymous polls have no voter list to start from, so the ballot is fetched
// once per poll id. A response that arrives after the viewer started picking
// (or after a successful vote) is dropped: their intent is newer than the
// snapshot the server sent.
async function loadMyVotes() {
  if (!anonymous.value) {
    return;
  }
  const token = ++votesToken;
  votesLoading.value = true;
  try {
    const ids = await chat.loadPollMyVotes(props.poll.id);
    if (token !== votesToken || dirty.value || submitting.value) {
      return;
    }
    myVotes.value = [...ids];
    selection.value = [...ids];
  } catch {
    // A vanished or inaccessible poll simply leaves the ballot unknown; the
    // card keeps working and the viewer starts from an empty selection.
  } finally {
    if (token === votesToken) {
      votesLoading.value = false;
    }
  }
}

function isSelected(optionId: number): boolean {
  return selection.value.includes(optionId);
}

function isVoted(optionId: number): boolean {
  return ownIds.value.includes(optionId);
}

function percent(count: number): number {
  if (props.poll.totalVotes <= 0) {
    return 0;
  }
  return Math.min(100, Math.round((count / props.poll.totalVotes) * 100));
}

function toggle(optionId: number) {
  if (closed.value || submitting.value) {
    return;
  }
  if (props.poll.multiple) {
    if (selection.value.includes(optionId)) {
      selection.value = selection.value.filter((id) => id !== optionId);
    } else if (selection.value.length < 10) {
      selection.value = [...selection.value, optionId];
    }
  } else {
    selection.value = [optionId];
  }
  dirty.value = selectedKey.value !== votedKey.value;
}

function submitVote() {
  if (!canSubmit.value) {
    return;
  }
  submitting.value = true;
  // Any my-votes request already in flight describes the pre-vote ballot.
  votesToken += 1;
  votesLoading.value = false;
  const done = (ok: boolean) => {
    submitting.value = false;
    if (!ok) {
      return;
    }
    if (anonymous.value) {
      // The server hides voters even from the response, so the submitted
      // ballot is the new truth for this viewer until a reload says otherwise.
      myVotes.value = [...selection.value];
    }
    dirty.value = false;
  };
  try {
    emit('vote', [...selection.value], done);
  } catch {
    // A throwing listener must never leave the card stuck in "submitting".
    done(false);
  }
}

async function closePoll() {
  if (!showClose.value || closing.value) {
    return;
  }
  try {
    await ElMessageBox.confirm(
      `确定提前截止「${props.poll.question}」？截止后成员将无法继续投票。`,
      '截止投票',
      { confirmButtonText: '截止', cancelButtonText: '取消', type: 'warning' },
    );
  } catch {
    return;
  }
  closing.value = true;
  const done = () => {
    closing.value = false;
  };
  try {
    emit('close', done);
  } catch {
    // A throwing listener must never leave the button stuck in "closing".
    done();
  }
}

// The export route is keyed by room + seq, but the card only knows the poll
// id, so the message is resolved from the loaded room cache (the same lookup
// `loadPollMyVotes` does). A poll rendered from a list that is no longer in
// the cache cannot be exported and says so instead of guessing a URL.
function findPollMessage(): Message | undefined {
  for (const list of Object.values(chat.messages)) {
    const target = list.find((message) => message.poll?.id === props.poll.id);
    if (target) {
      return target;
    }
  }
  return undefined;
}

// Downloading needs the bearer token, so the CSV is fetched as a blob and
// handed to the browser through a transient object URL. Exporting is
// independent of voting and closing: it works before and after the deadline.
async function exportResults() {
  if (exporting.value) {
    return;
  }
  const target = findPollMessage();
  if (!target) {
    ElMessage.error('找不到投票所在的消息');
    return;
  }
  exporting.value = true;
  try {
    const { data } = await http.get<Blob>(
      `/rooms/${target.roomId}/messages/${target.seq}/poll/export`,
      { responseType: 'blob' },
    );
    const url = URL.createObjectURL(data);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `poll-${target.seq}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // The save starts synchronously; revoking on the next macrotask keeps the
    // blob alive long enough without leaking it for the page's lifetime.
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    exporting.value = false;
  }
}

// A new poll reuses nothing from the previous one; anonymous polls then fetch
// the viewer's ballot (normal polls already have it in `userIds`).
watch(
  () => props.poll.id,
  () => {
    votesToken += 1;
    votesLoading.value = false;
    myVotes.value = [];
    resetSelection();
    void loadMyVotes();
  },
  { immediate: true },
);
// The viewer's own recorded votes changed (their request landed, or another
// tab voted). If nothing is pending, follow the server; if the pending ballot
// is exactly what the server now holds, the submission succeeded.
watch(votedKey, () => {
  if (!dirty.value) {
    resetSelection();
    return;
  }
  if (selectedKey.value === votedKey.value) {
    resetSelection();
  }
});

onMounted(() => {
  clock = window.setInterval(() => {
    if (deadline.value != null) {
      now.value = Date.now();
    }
  }, 30_000);
});

onBeforeUnmount(() => {
  if (clock !== undefined) {
    window.clearInterval(clock);
  }
});
</script>

<template>
  <section class="poll-card" :class="{ closed }" data-testid="poll-card">
    <header class="poll-head">
      <span class="poll-kicker">投票 · {{ poll.multiple ? '多选' : '单选' }}</span>
      <span
        v-if="poll.anonymous"
        class="poll-anon"
        data-testid="poll-anonymous-tag"
        title="匿名投票：不公开投票人"
      >匿名</span>
      <span v-if="closed" class="poll-state poll-state-closed">已截止</span>
      <span v-else-if="deadlineText" class="poll-state">截止 {{ deadlineText }}</span>
    </header>

    <h3 class="poll-question">{{ poll.question }}</h3>

    <div class="poll-options" role="group" :aria-label="poll.question">
      <button
        v-for="option in poll.options"
        :key="option.id"
        class="poll-option"
        :class="{ selected: isSelected(option.id), voted: isVoted(option.id) }"
        type="button"
        data-testid="poll-option"
        :data-option-id="option.id"
        :title="optionTitle(option)"
        :aria-pressed="isSelected(option.id)"
        :disabled="closed || submitting"
        @click="toggle(option.id)"
      >
        <span class="poll-option-top">
          <span
            class="poll-bullet"
            :class="{ on: isSelected(option.id), radio: !poll.multiple }"
            aria-hidden="true"
          >
            <Icon v-if="isSelected(option.id)" name="check" :size="10" />
          </span>
          <span class="poll-option-label">{{ option.label }}</span>
          <span v-if="isVoted(option.id)" class="poll-voted-tag">已投</span>
          <span class="poll-option-count mono">{{ option.count }}</span>
        </span>
        <span class="poll-bar" aria-hidden="true">
          <span class="poll-bar-fill" :style="{ width: `${percent(option.count)}%` }"></span>
        </span>
      </button>
    </div>

    <footer class="poll-foot">
      <span class="poll-total mono" aria-live="polite">
        {{ poll.totalVotes }} 人参与
      </span>
      <button
        v-if="showClose"
        class="btn ghost small poll-close"
        type="button"
        data-testid="poll-close"
        :disabled="closing"
        :aria-busy="closing"
        @click="closePoll"
      >
        {{ closing ? '截止中…' : '提前截止' }}
      </button>
      <button
        class="btn ghost small poll-export"
        type="button"
        data-testid="poll-export"
        :disabled="exporting"
        :aria-busy="exporting"
        @click="exportResults"
      >
        {{ exporting ? '导出中…' : '导出结果' }}
      </button>
      <button
        class="btn primary small poll-submit"
        type="button"
        data-testid="poll-submit"
        :disabled="!canSubmit"
        :aria-busy="submitting"
        @click="submitVote"
      >
        {{ submitLabel }}
      </button>
    </footer>
  </section>
</template>

<style scoped>
.poll-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
  min-width: 0;
  padding: 1px 0;
  color: var(--text);
  text-align: left;
}

.poll-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.poll-kicker {
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  font-weight: 700;
  letter-spacing: 0.06em;
}

.poll-state {
  color: var(--faint);
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  letter-spacing: 0.03em;
}

.poll-anon {
  margin-left: auto;
  padding: 1px 6px;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  font-weight: 700;
  letter-spacing: 0.03em;
}

.poll-state-closed {
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--danger-soft);
  color: var(--rust-ink);
  font-weight: 700;
}

.poll-question {
  margin: 0;
  color: var(--text);
  font-size: var(--fs-body);
  font-weight: 700;
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.poll-options {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.poll-option {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--paper-3);
  color: var(--text);
  cursor: pointer;
  text-align: left;
  transition: border-color 0.12s ease-out, background 0.12s ease-out;
}

.poll-option:hover:not(:disabled) {
  border-color: var(--line-strong);
}

.poll-option.selected {
  border-color: var(--ink);
  background: var(--paper-2);
  box-shadow: inset 0 0 0 1px var(--ink);
}

.poll-option.voted:not(.selected) {
  border-color: var(--line-strong);
}

.poll-option:disabled {
  cursor: default;
}

.poll-option:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: 1px;
}

.poll-card.closed .poll-option {
  opacity: 0.72;
}

.poll-option-top {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.poll-bullet {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  border: 1px solid var(--line-strong);
  border-radius: 3px;
  background: transparent;
  color: var(--paper);
}

.poll-bullet.radio {
  border-radius: 50%;
}

.poll-bullet.on {
  border-color: var(--ink);
  background: var(--ink);
}

.poll-option-label {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-sub);
  line-height: 1.4;
  overflow-wrap: anywhere;
}

.poll-voted-tag {
  flex: none;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--lime);
  color: var(--ink);
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.02em;
}

.poll-option-count {
  flex: none;
  color: var(--muted);
  font-size: var(--fs-mono);
}

.poll-bar {
  display: block;
  height: 3px;
  overflow: hidden;
  border-radius: 2px;
  background: var(--line);
}

.poll-bar-fill {
  display: block;
  height: 100%;
  border-radius: 2px;
  background: var(--ink);
  opacity: 0.26;
  transition: width 0.18s ease-out;
}

.poll-option.voted .poll-bar-fill {
  opacity: 0.46;
}

.poll-option.selected .poll-bar-fill {
  opacity: 0.55;
}

.poll-foot {
  display: flex;
  align-items: center;
  gap: 8px;
}

.poll-total {
  flex: 1;
  color: var(--muted);
}

.poll-submit {
  flex: none;
}

.poll-close {
  flex: none;
}

.poll-export {
  flex: none;
}
</style>
