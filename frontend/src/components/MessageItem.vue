<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { useAuthStore } from '../stores/auth';
import { useChatStore } from '../stores/chat';
import type { Message } from '../types';
import { avatarClass, formatTime, initialOf, plainPreview } from '../utils/format';
import Icon from './Icon.vue';

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

const props = defineProps<{
  message: Message;
  compact?: boolean;
  highlight?: boolean;
  canModerate?: boolean;
}>();
const emit = defineEmits<{
  reply: [message: Message];
  edit: [message: Message];
  delete: [message: Message];
  react: [message: Message, emoji: string];
  pin: [message: Message, pinned: boolean];
}>();

// Same shortlist as the composer picker: one vocabulary for reactions.
const EMOJI_LIST = ['😀', '😂', '👍', '🎉', '🤖', '🔥', '✅', '👀', '❤️', '🙏'];

const auth = useAuthStore();
const chat = useChatStore();
const copied = ref(false);
const actionsOpen = ref(false);
const pickerOpen = ref(false);

const self = computed(() => props.message.senderId === auth.user?.id);
const bot = computed(() => props.message.senderType === 'bot');
const deleted = computed(() => Boolean(props.message.deleted));
const canEdit = computed(
  () => self.value && !bot.value && !deleted.value && props.message.status === 'done',
);
const canDelete = computed(() => !deleted.value && (self.value || Boolean(props.canModerate)));
const canPin = computed(() => Boolean(props.canModerate) && !deleted.value);
const avatar = computed(() => avatarClass(props.message.senderId));
const initial = computed(() => initialOf(props.message.senderName));
const time = computed(() => formatTime(props.message.createdAt));
const replyMessage = computed(() => {
  const replyToId = props.message.replyToId;
  if (!replyToId) {
    return null;
  }
  return chat.currentMessages.find((message) => message.id === replyToId) ?? null;
});
const replyPreview = computed(() =>
  replyMessage.value
    ? replyMessage.value.deleted
      ? '消息已撤回'
      : plainPreview(replyMessage.value.content).slice(0, 90)
    : '',
);
const rendered = computed(() =>
  deleted.value
    ? ''
    : DOMPurify.sanitize(
        marked.parse(props.message.content, {
          async: false,
          gfm: true,
          breaks: true,
        }) as string,
      ),
);
// Block-level markdown reads as a document, not as one spoken line.
const isRich = computed(
  () => !deleted.value && /<(pre|table|ul|ol|blockquote|h[1-6])[\s>]/.test(rendered.value),
);
const reactions = computed(() => props.message.reactions ?? []);

/* 刚发出的消息播放一次声纹涟漪（只依赖发送记录，不依赖系统时钟） */
const fresh = ref(false);
onMounted(() => {
  if (self.value && !bot.value && chat.lastSentId === props.message.id) {
    fresh.value = true;
    window.setTimeout(() => {
      fresh.value = false;
    }, 760);
  }
});

/* ---- 长消息折叠 ---- */
const expanded = ref(false);
const isLong = computed(
  () => props.message.content.length > 200 && !rendered.value.includes('<pre'),
);
const clamped = computed(() => isLong.value && !expanded.value);

/* ---- v-html 渲染后增强：代码块复制按钮 + @提及高亮 ---- */
const contentEl = ref<HTMLElement | null>(null);

async function copyText(text: string, button: HTMLButtonElement) {
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = '已复制';
  } catch {
    button.textContent = '复制失败';
  }
  window.setTimeout(() => {
    button.textContent = '复制';
  }, 1400);
}

function enhanceBlocks() {
  const root = contentEl.value;
  if (!root) {
    return;
  }
  root.querySelectorAll('pre').forEach((pre) => {
    if (pre.closest('.code-block')) {
      return;
    }
    const code = pre.querySelector('code');
    const wrapper = document.createElement('div');
    wrapper.className = 'code-block';
    const head = document.createElement('div');
    head.className = 'code-head';
    const lang = document.createElement('span');
    lang.className = 'code-lang';
    const cls = code?.className ?? '';
    lang.textContent = cls.match(/language-(\w+)/)?.[1] ?? 'code';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'code-copy';
    button.textContent = '复制';
    button.addEventListener('click', () => {
      void copyText(code?.textContent ?? pre.textContent ?? '', button);
    });
    head.append(lang, button);
    pre.parentNode?.insertBefore(wrapper, pre);
    wrapper.append(head, pre);
  });

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || parent.closest('pre,code,a,.mention')) {
        return NodeFilter.FILTER_REJECT;
      }
      return /@[\w一-龥.-]+/.test(node.nodeValue ?? '')
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_SKIP;
    },
  });
  const targets: Text[] = [];
  while (walker.nextNode()) {
    targets.push(walker.currentNode as Text);
  }
  for (const textNode of targets) {
    const source = textNode.nodeValue ?? '';
    const fragment = document.createDocumentFragment();
    const pattern = /@[\w一-龥.-]+/g;
    let cursor = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source))) {
      if (match.index > cursor) {
        fragment.append(source.slice(cursor, match.index));
      }
      const span = document.createElement('span');
      span.className = 'mention';
      span.textContent = match[0];
      fragment.append(span);
      cursor = match.index + match[0].length;
    }
    if (cursor < source.length) {
      fragment.append(source.slice(cursor));
    }
    textNode.replaceWith(fragment);
  }
}

onMounted(() => nextTick(enhanceBlocks));
watch(rendered, () => nextTick(enhanceBlocks));

function hasReacted(userIds: number[]): boolean {
  return Boolean(auth.user && userIds.includes(auth.user.id));
}

async function copy() {
  actionsOpen.value = false;
  pickerOpen.value = false;
  try {
    await navigator.clipboard.writeText(props.message.content);
    copied.value = true;
    window.setTimeout(() => {
      copied.value = false;
    }, 1200);
  } catch {
    ElMessage.info(props.message.content);
  }
}

function startReply() {
  actionsOpen.value = false;
  emit('reply', props.message);
}

function startEdit() {
  actionsOpen.value = false;
  emit('edit', props.message);
}

function remove() {
  actionsOpen.value = false;
  emit('delete', props.message);
}

function togglePin() {
  actionsOpen.value = false;
  emit('pin', props.message, !props.message.pinned);
}

function toggleActions() {
  actionsOpen.value = !actionsOpen.value;
  pickerOpen.value = false;
}

function togglePicker() {
  pickerOpen.value = !pickerOpen.value;
}

function react(emoji: string) {
  actionsOpen.value = false;
  pickerOpen.value = false;
  emit('react', props.message, emoji);
}

function scrollToReply() {
  if (!replyMessage.value) {
    return;
  }
  const element = document.querySelector(`[data-seq="${replyMessage.value.seq}"]`);
  element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
</script>

<template>
  <div
    class="msg"
    :class="{
      self,
      bot,
      compact,
      rich: isRich,
      highlight: props.highlight,
      deleted,
      streaming: message.status === 'streaming',
      failed: message.status === 'error',
      fresh,
    }"
    data-testid="message"
    :data-seq="message.seq"
  >
    <span v-if="!self && !compact" class="avatar" :class="avatar">{{ initial }}</span>
    <span v-else-if="!self" class="avatar-spacer"></span>

    <div class="msg-body">
      <div v-if="!compact" class="msg-meta">
        <span v-if="!self" class="msg-sender">{{ message.senderName }}</span>
        <span v-if="bot" class="bot-tag">BOT</span>
        <span class="msg-time">{{ time }}</span>
        <span v-if="message.editedAt && !deleted" class="msg-mark">已编辑</span>
        <span v-if="message.pinned && !deleted" class="msg-mark pin-mark" title="已置顶">
          <Icon name="pin" :size="12" />
          已置顶
        </span>
      </div>
      <div class="bubble-wrap">
        <button v-if="replyMessage && !deleted" class="reply-quote" @click="scrollToReply">
          <span class="reply-quote-name">{{ replyMessage.senderName }}</span>
          <span class="reply-quote-text">{{ replyPreview }}</span>
        </button>
        <div class="bubble" :class="{ 'bubble-deleted': deleted }">
          <div v-if="deleted" class="bubble-content msg-deleted">消息已撤回</div>
          <template v-else>
            <div ref="contentEl" class="bubble-content" :class="{ clamped }" v-html="rendered"></div>
            <span v-if="message.status === 'streaming'" class="cursor"></span>
            <span v-if="message.status === 'error'" class="msg-error">
              生成失败<span class="msg-error-hint">再次 @ 机器人可重试</span>
            </span>
            <button
              v-if="isLong"
              class="collapse-toggle"
              type="button"
              @click="expanded = !expanded"
            >
              {{ expanded ? '收起' : `展开全文（${message.content.length} 字）` }}
            </button>
          </template>
        </div>
        <button
          v-if="!deleted"
          class="msg-more"
          type="button"
          title="消息操作"
          aria-label="消息操作"
          @click.stop="toggleActions"
        >
          <Icon name="more" :size="16" />
        </button>
        <div v-if="!deleted" class="msg-actions" :class="{ open: actionsOpen }">
          <button
            class="msg-action"
            type="button"
            title="回复"
            aria-label="回复"
            @click="startReply"
          >
            <Icon name="reply" :size="14" />
          </button>
          <button
            class="msg-action"
            type="button"
            :title="copied ? '已复制' : '复制'"
            :aria-label="copied ? '已复制' : '复制'"
            @click="copy"
          >
            <Icon :name="copied ? 'check' : 'copy'" :size="14" />
          </button>
          <button
            class="msg-action"
            type="button"
            title="表情"
            aria-label="表情"
            :aria-expanded="pickerOpen"
            @click="togglePicker"
          >
            <Icon name="smile" :size="14" />
          </button>
          <button
            v-if="canEdit"
            class="msg-action"
            type="button"
            title="编辑"
            aria-label="编辑"
            @click="startEdit"
          >
            <Icon name="edit" :size="14" />
          </button>
          <button
            v-if="canDelete"
            class="msg-action"
            type="button"
            title="删除"
            aria-label="删除"
            @click="remove"
          >
            <Icon name="trash" :size="14" />
          </button>
          <button
            v-if="canPin"
            class="msg-action"
            type="button"
            :title="message.pinned ? '取消置顶' : '置顶'"
            :aria-label="message.pinned ? '取消置顶' : '置顶'"
            @click="togglePin"
          >
            <Icon name="pin" :size="14" />
          </button>
        </div>
        <div v-if="pickerOpen && !deleted" class="msg-emoji-pop" role="listbox" aria-label="添加表情">
          <button
            v-for="emoji in EMOJI_LIST"
            :key="emoji"
            class="msg-emoji-item"
            type="button"
            :aria-label="`表情 ${emoji}`"
            @click="react(emoji)"
          >
            {{ emoji }}
          </button>
        </div>
        <div
          v-if="!deleted && (reactions.length || (compact && (message.editedAt || message.pinned)))"
          class="msg-reactions"
        >
          <span v-if="compact && message.editedAt && !deleted" class="msg-mark">已编辑</span>
          <span v-if="compact && message.pinned" class="msg-mark pin-mark" title="已置顶">
            <Icon name="pin" :size="12" />
          </span>
          <button
            v-for="reaction in reactions"
            :key="reaction.emoji"
            class="reaction-chip"
            :class="{ mine: hasReacted(reaction.userIds) }"
            type="button"
            :title="`${reaction.emoji} ${reaction.count}`"
            @click="react(reaction.emoji)"
          >
            <span class="reaction-emoji">{{ reaction.emoji }}</span>
            <span class="reaction-count">{{ reaction.count }}</span>
          </button>
        </div>
      </div>
    </div>

    <span v-if="self && !compact" class="avatar" :class="avatar">{{ initial }}</span>
  </div>
</template>
