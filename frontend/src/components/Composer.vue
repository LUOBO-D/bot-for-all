<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { Member, Message } from '../types';
import { avatarClass, initialOf, plainPreview } from '../utils/format';
import Icon from './Icon.vue';

const props = defineProps<{
  disabled?: boolean;
  roomId: number;
  members: Member[];
  replyTo?: Message | null;
  editing?: Message | null;
}>();
const emit = defineEmits<{
  send: [content: string, done: (ok: boolean) => void];
  typing: [isTyping: boolean];
  'cancel-reply': [];
  'cancel-edit': [];
}>();

const content = ref('');
const textarea = ref<HTMLTextAreaElement | null>(null);
const sending = ref(false);
const composing = ref(false);
const mentionOpen = ref(false);
const mentionQuery = ref('');
const mentionIndex = ref(0);
const emojiOpen = ref(false);
const emojiList = ['😀', '😂', '👍', '🎉', '🤖', '🔥', '✅', '👀', '❤️', '🙏'];
const draftKey = computed(() => `bfa_draft_${props.roomId}`);
let lastTypingAt = 0;
let stopTimer: number | undefined;

onMounted(() => {
  content.value = localStorage.getItem(draftKey.value) ?? '';
  nextTick(resize);
});

watch(
  () => props.roomId,
  () => {
    content.value = localStorage.getItem(draftKey.value) ?? '';
    mentionOpen.value = false;
    nextTick(resize);
  },
);

// Editing borrows the composer: the text comes from the message, the draft
// stays untouched until the edit is committed or cancelled.
watch(
  () => props.editing,
  (message) => {
    mentionOpen.value = false;
    emojiOpen.value = false;
    if (message) {
      content.value = message.content;
      nextTick(() => {
        resize();
        textarea.value?.focus();
      });
      return;
    }
    content.value = localStorage.getItem(draftKey.value) ?? '';
    nextTick(resize);
  },
);

const mentionCandidates = computed(() => {
  const query = mentionQuery.value.toLowerCase();
  return props.members
    .filter(
      (member) =>
        !query ||
        member.username.toLowerCase().includes(query) ||
        member.displayName.toLowerCase().includes(query),
    )
    .slice(0, 6);
});

function resize() {
  const element = textarea.value;
  if (!element) {
    return;
  }
  element.style.height = 'auto';
  element.style.height = `${Math.min(element.scrollHeight, 140)}px`;
}

watch(content, async (value) => {
  // Draft state is captured at trigger time: a pending edit must never
  // overwrite (or delete) the saved draft of the room.
  const isEdit = Boolean(props.editing);
  await nextTick();
  resize();
  if (!isEdit) {
    if (value.trim()) {
      localStorage.setItem(draftKey.value, value);
    } else {
      localStorage.removeItem(draftKey.value);
    }
  }
  if (!value) {
    return;
  }
  const now = Date.now();
  if (now - lastTypingAt > 1000) {
    emit('typing', true);
    lastTypingAt = now;
  }
  window.clearTimeout(stopTimer);
  stopTimer = window.setTimeout(() => emit('typing', false), 2000);
});

onBeforeUnmount(() => {
  window.clearTimeout(stopTimer);
  emit('typing', false);
});

function detectMention() {
  const element = textarea.value;
  if (!element) {
    return;
  }
  const position = element.selectionStart ?? 0;
  const before = content.value.slice(0, position);
  const match = before.match(/(?:^|\s)@([a-zA-Z0-9_-]*)$/);
  if (!match) {
    mentionOpen.value = false;
    return;
  }
  mentionQuery.value = match[1];
  mentionIndex.value = 0;
  emojiOpen.value = false;
  mentionOpen.value = mentionCandidates.value.length > 0;
}

function selectMention(member: Member) {
  const element = textarea.value;
  if (!element) {
    return;
  }
  const position = element.selectionStart ?? content.value.length;
  const before = content.value.slice(0, position);
  const after = content.value.slice(position);
  const replaced = before.replace(/@([a-zA-Z0-9_-]*)$/, `@${member.username} `);
  content.value = replaced + after;
  mentionOpen.value = false;
  nextTick(() => {
    element.focus();
    const next = replaced.length;
    element.setSelectionRange(next, next);
    resize();
  });
}

function insertAtCursor(text: string) {
  const element = textarea.value;
  if (!element) {
    return;
  }
  const start = element.selectionStart ?? content.value.length;
  const end = element.selectionEnd ?? start;
  content.value = content.value.slice(0, start) + text + content.value.slice(end);
  nextTick(() => {
    element.focus();
    const next = start + text.length;
    element.setSelectionRange(next, next);
    resize();
  });
}

function wrapSelection(before: string, after: string) {
  const element = textarea.value;
  if (!element) {
    return;
  }
  const start = element.selectionStart ?? content.value.length;
  const end = element.selectionEnd ?? start;
  const selected = content.value.slice(start, end) || '文本';
  content.value =
    content.value.slice(0, start) + before + selected + after + content.value.slice(end);
  nextTick(() => {
    element.focus();
    const next = start + before.length + selected.length;
    element.setSelectionRange(next, next);
    resize();
  });
}

function insertLink() {
  wrapSelection('[', '](https://)');
}

function toggleBold() {
  wrapSelection('**', '**');
}

function toggleCode() {
  wrapSelection('`', '`');
}

function toggleEmoji() {
  emojiOpen.value = !emojiOpen.value;
  mentionOpen.value = false;
}

function addEmoji(emoji: string) {
  insertAtCursor(emoji);
  emojiOpen.value = false;
}

function submit() {
  if (sending.value || props.disabled) {
    return;
  }
  const value = content.value.trim();
  if (!value) {
    return;
  }
  sending.value = true;
  const done = (ok: boolean) => {
    sending.value = false;
    if (!ok || content.value.trim() !== value) {
      return;
    }
    // While editing, the parent clears `editing` and the watcher above
    // restores the room draft — touching the field here would race it.
    if (props.editing) {
      return;
    }
    content.value = '';
    localStorage.removeItem(draftKey.value);
    nextTick(resize);
  };
  try {
    emit('send', value, done);
  } catch {
    // A throwing listener must never leave the composer stuck in "sending".
    done(false);
  }
}

function onKeydown(event: KeyboardEvent) {
  if (event.isComposing || composing.value || event.keyCode === 229) {
    return;
  }
  if (mentionOpen.value) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      mentionIndex.value = (mentionIndex.value + 1) % mentionCandidates.value.length;
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      mentionIndex.value =
        (mentionIndex.value - 1 + mentionCandidates.value.length) %
        mentionCandidates.value.length;
      return;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      const member = mentionCandidates.value[mentionIndex.value];
      if (member) {
        selectMention(member);
      }
      return;
    }
    if (event.key === 'Escape') {
      mentionOpen.value = false;
      return;
    }
  }
  if (event.key === 'Escape' && props.editing) {
    event.preventDefault();
    emit('cancel-edit');
    return;
  }
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    submit();
  }
}
</script>

<template>
  <div class="composer-shell">
    <div v-if="editing" class="edit-bar">
      <div class="reply-copy">
        <span class="reply-label">编辑消息</span>
        <span class="reply-text">{{ plainPreview(editing.content).slice(0, 100) }}</span>
      </div>
      <button class="icon-btn small-icon" title="取消编辑" @click="emit('cancel-edit')">
        <Icon name="close" :size="14" />
      </button>
    </div>

    <div v-if="replyTo && !editing" class="reply-bar">
      <div class="reply-copy">
        <span class="reply-label">回复 {{ replyTo.senderName }}</span>
        <span class="reply-text">{{ plainPreview(replyTo.content).slice(0, 100) }}</span>
      </div>
      <button class="icon-btn small-icon" title="取消回复" @click="emit('cancel-reply')">
        <Icon name="close" :size="14" />
      </button>
    </div>

    <div v-if="mentionOpen" class="mention-pop" role="listbox" aria-label="提及成员">
      <button
        v-for="(member, index) in mentionCandidates"
        :key="member.userId"
        class="mention-item"
        role="option"
        :aria-selected="index === mentionIndex"
        :class="{ active: index === mentionIndex }"
        @mousedown.prevent="selectMention(member)"
      >
        <span class="avatar avatar-xs" :class="avatarClass(member.userId)">
          {{ initialOf(member.displayName) }}
        </span>
        <span class="mention-name">{{ member.displayName }}</span>
        <span class="mention-handle">@{{ member.username }}</span>
        <span v-if="member.type === 'bot'" class="bot-tag">BOT</span>
      </button>
    </div>

    <div v-if="emojiOpen" class="emoji-pop" role="listbox" aria-label="表情">
      <button
        v-for="emoji in emojiList"
        :key="emoji"
        class="emoji-item"
        type="button"
        @mousedown.prevent="addEmoji(emoji)"
      >
        {{ emoji }}
      </button>
    </div>

    <div class="composer-tools">
      <button class="composer-tool" type="button" title="加粗" @mousedown.prevent="toggleBold">
        B
      </button>
      <button class="composer-tool" type="button" title="行内代码" @mousedown.prevent="toggleCode">
        &lt;/&gt;
      </button>
      <button class="composer-tool" type="button" title="链接" @mousedown.prevent="insertLink">
        link
      </button>
      <button class="composer-tool" type="button" title="表情" @mousedown.prevent="toggleEmoji">
        ☺
      </button>
    </div>

    <div class="composer" :class="{ disabled: props.disabled }">
      <textarea
        ref="textarea"
        v-model="content"
        data-testid="composer"
        rows="1"
        :disabled="props.disabled"
        :placeholder="editing ? '编辑消息，Enter 保存 · Esc 取消' : '发消息，@ 提及成员'"
        @input="detectMention"
        @click="detectMention"
        @keydown="onKeydown"
        @compositionstart="composing = true"
        @compositionend="composing = false; detectMention()"
      ></textarea>
      <button
        class="send-btn"
        data-testid="send"
        :disabled="props.disabled || sending || !content.trim()"
        title="发送"
        @click="submit"
      >
        <Icon name="send" :size="18" />
      </button>
    </div>
    <div class="composer-hint">Enter 发送 · Shift+Enter 换行 · @ 提及</div>
  </div>
</template>
