<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import http, { errorMessage } from '../api/http';
import { useAuthStore } from '../stores/auth';
import { useChatStore } from '../stores/chat';
import type { Message, Reaction } from '../types';
import { formatTime, plainPreview } from '../utils/format';
import Icon from './Icon.vue';
import MessageAttachments from './MessageAttachments.vue';
import MessageContextMenu from './MessageContextMenu.vue';
import PollCard from './PollCard.vue';
import UserAvatar from './UserAvatar.vue';

// Mirrors MessageContextMenu's item contract.
interface MenuItem {
  id: string;
  label: string;
  icon?: string;
  danger?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
}

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
  selectable?: boolean;
  selected?: boolean;
}>();
const emit = defineEmits<{
  reply: [message: Message];
  edit: [message: Message];
  delete: [message: Message];
  react: [message: Message, emoji: string];
  pin: [message: Message, pinned: boolean];
  forward: [message: Message];
  select: [message: Message];
  history: [message: Message];
  report: [message: Message];
  vote: [message: Message, optionIds: number[], done: (ok: boolean) => void];
  close: [message: Message, done: (ok: boolean) => void];
}>();

// Same shortlist as the composer picker: one vocabulary for reactions.
const EMOJI_LIST = ['😀', '😂', '👍', '🎉', '🤖', '🔥', '✅', '👀', '❤️', '🙏'];

// Recently typed reactions are personal shorthand, not message data: they live
// in this browser only, capped so the picker stays a one-glance grid.
const CUSTOM_STORAGE_KEY = 'bfa_custom_reactions';
const CUSTOM_LIMIT = 6;
const CUSTOM_MAX_LENGTH = 16;

function readCustomReactions(): string[] {
  try {
    const raw = window.localStorage.getItem(CUSTOM_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    const seen = new Set<string>();
    const list: string[] = [];
    for (const entry of parsed) {
      if (typeof entry !== 'string') {
        continue;
      }
      const emoji = entry.trim().slice(0, CUSTOM_MAX_LENGTH);
      if (!emoji || seen.has(emoji)) {
        continue;
      }
      seen.add(emoji);
      list.push(emoji);
      if (list.length === CUSTOM_LIMIT) {
        break;
      }
    }
    return list;
  } catch {
    return [];
  }
}

function writeCustomReactions(list: string[]) {
  try {
    window.localStorage.setItem(CUSTOM_STORAGE_KEY, JSON.stringify(list));
  } catch {
    // Storage can be unavailable (private mode, quota); the session still works.
  }
}

const auth = useAuthStore();
const chat = useChatStore();
const copied = ref(false);
const actionsOpen = ref(false);
const pickerOpen = ref(false);
const customInput = ref('');
const customReactions = ref<string[]>([]);
const root = ref<HTMLElement | null>(null);
const menuOpen = ref(false);
const menuX = ref(0);
const menuY = ref(0);
// A translation is a reading aid for the current text, never message data:
// it lives in this row only and is dropped when the text changes or is
// retracted. `translateToken` retires in-flight responses that lost their text.
const translation = ref<string | null>(null);
const translating = ref(false);
let translateToken = 0;

// The target language is a reader preference, never message data: it outlives
// this row in localStorage. The shortlist is the only vocabulary the picker
// offers, so the server always receives a language it can name; a stored value
// is validated on read because another tab (or an older build) may have
// written anything.
const TRANSLATE_LANGS = [
  { value: 'zh-CN', label: '中文' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'fr', label: 'Français' },
  { value: 'de', label: 'Deutsch' },
  { value: 'es', label: 'Español' },
  { value: 'ru', label: 'Русский' },
] as const;
type TranslateLang = (typeof TRANSLATE_LANGS)[number]['value'];
const TRANSLATE_LANG_KEY = 'bfa_translate_lang';
const TRANSLATE_FALLBACK_LANG: TranslateLang = 'zh-CN';

// Exact match first, then the primary subtag: `navigator.language` may carry a
// region or script (en-GB, zh-Hans-CN, es-419) that no option spells out.
function matchTranslateLang(raw: string | null | undefined): TranslateLang | null {
  if (!raw) {
    return null;
  }
  const wanted = raw.trim().toLowerCase();
  if (!wanted) {
    return null;
  }
  for (const option of TRANSLATE_LANGS) {
    if (option.value.toLowerCase() === wanted) {
      return option.value;
    }
  }
  const primary = wanted.split(/[-_]/)[0];
  for (const option of TRANSLATE_LANGS) {
    if (option.value.toLowerCase().split('-')[0] === primary) {
      return option.value;
    }
  }
  return null;
}

function readStoredTranslateLang(): TranslateLang | null {
  try {
    return matchTranslateLang(window.localStorage.getItem(TRANSLATE_LANG_KEY));
  } catch {
    return null;
  }
}

function writeStoredTranslateLang(lang: TranslateLang) {
  try {
    window.localStorage.setItem(TRANSLATE_LANG_KEY, lang);
  } catch {
    // Storage can be unavailable (private mode, quota); translation still works.
  }
}

// Resolved on this row's first translation rather than at setup: a long list
// would otherwise hit localStorage once per message for a control that only
// exists after a translation. The stored preference wins over the browser's
// language, and an unrecognised one falls back to Chinese.
const translateLang = ref<TranslateLang | null>(null);
const activeTranslateLang = computed(() => translateLang.value ?? TRANSLATE_FALLBACK_LANG);

function currentTranslateLang(): TranslateLang {
  if (!translateLang.value) {
    translateLang.value =
      readStoredTranslateLang() ??
      matchTranslateLang(navigator.language) ??
      TRANSLATE_FALLBACK_LANG;
  }
  return translateLang.value;
}

const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP = 10;
let pressTimer: number | null = null;
let pressStartX = 0;
let pressStartY = 0;
let longPressed = false;

// Left swipe on a row is the touch shortcut for replying. It shares the
// pointer gesture space with the long-press menu: the first horizontal move
// cancels the press timer, so exactly one of the two can win a gesture.
const SWIPE_MAX_WIDTH = 860;
const SWIPE_REPLY_DISTANCE = 60;
const SWIPE_VERTICAL_SLOP = 30;
const SWIPE_DECIDE_SLOP = 10;
let swipeStartX = 0;
let swipeStartY = 0;
let swipeTracking = false;
let swipeHorizontal = false;
let swipeFired = false;

const self = computed(() => props.message.senderId === auth.user?.id);
const bot = computed(() => props.message.senderType === 'bot');
const deleted = computed(() => Boolean(props.message.deleted));
const poll = computed(() => props.message.poll);
const isPoll = computed(() => Boolean(poll.value));
// A poll's plain `content` is the question: editing it through the composer
// would desync the message from the poll payload, so it stays read-only.
const canEdit = computed(
  () =>
    self.value &&
    !bot.value &&
    !deleted.value &&
    !isPoll.value &&
    props.message.status === 'done',
);
const canDelete = computed(() => !deleted.value && (self.value || Boolean(props.canModerate)));
const canPin = computed(() => Boolean(props.canModerate) && !deleted.value);
// Ending someone else's poll is a moderator action; the author can always end
// their own. PollCard hides the button once the deadline passes.
const canClosePoll = computed(
  () => isPoll.value && !deleted.value && (self.value || Boolean(props.canModerate)),
);
// Every live message is forwardable, attachments and polls included: the
// server copies each attachment file into the target room under the forwarder's
// quota, and a forwarded poll becomes a fresh poll (options copied, no votes).
// Withdrawn rows stay rejected with FORWARD_UNSUPPORTED.
const canForward = computed(() => !deleted.value);
// Only text can be translated: a retracted row has none, and an attachment-only
// message would send the server an empty string it rejects with 400.
const canTranslate = computed(
  () => !deleted.value && props.message.content.trim().length > 0,
);
const menuItems = computed<MenuItem[]>(() => {
  if (deleted.value) {
    return [];
  }
  const items: MenuItem[] = [
    { id: 'reply', label: '回复', icon: 'reply' },
  ];
  if (canForward.value) {
    items.push({ id: 'forward', label: '转发', icon: 'forward' });
  }
  items.push(
    { id: 'copy', label: '复制文本', icon: 'copy' },
    { id: 'copy-link', label: '复制链接', icon: 'link' },
    // Translating is a view action: the server forwards the text to the
    // configured model and returns a rendering, nothing is stored.
    ...(canTranslate.value ? [{ id: 'translate', label: '翻译' }] : []),
    // Bookmarking is offered on every live message, own or not; the server
    // keeps it idempotent, so a second save simply confirms again.
    { id: 'save-message', label: '保存消息' },
  );
  // Reporting is for other people's live messages: the server rejects both
  // own and withdrawn rows, so the menu never offers a request it would 400.
  if (!self.value) {
    items.push({ id: 'report', label: '举报', icon: 'megaphone' });
  }
  items.push({ id: 'react', label: '添加表情', icon: 'smile' });
  if (canEdit.value) {
    items.push({ id: 'edit', label: '编辑', icon: 'edit' });
  }
  if (canPin.value) {
    items.push({
      id: 'pin',
      label: props.message.pinned ? '取消置顶' : '置顶',
      icon: 'pin',
    });
  }
  if (canDelete.value) {
    items.push({
      id: 'delete',
      label: '删除',
      icon: 'trash',
      danger: true,
      separatorBefore: true,
    });
  }
  return items;
});
const time = computed(() => formatTime(props.message.createdAt));
const replyMessage = computed(() => {
  const replyToId = props.message.replyToId;
  if (!replyToId) {
    return null;
  }
  return chat.currentMessages.find((message) => message.id === replyToId) ?? null;
});
// Retracted rows keep no files on screen: the rows survive server-side, but a
// withdrawn bubble must not advertise a download the reader can no longer see.
const attachments = computed(() =>
  deleted.value ? [] : (props.message.attachments ?? []),
);
const replyPreview = computed(() => {
  const target = replyMessage.value;
  if (!target) {
    return '';
  }
  if (target.deleted) {
    return '消息已撤回';
  }
  return plainPreview(target.content).slice(0, 90) || (target.attachments?.length ? '[附件]' : '');
});
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
// A chip's tooltip doubles as the voter list, so reaction ids are resolved
// against the room roster. Someone who has left the room is still shown, by id,
// rather than silently disappearing from the tally.
function reactionTitle(reaction: Reaction): string {
  const base = `${reaction.emoji} ${reaction.count}`;
  if (reaction.userIds.length === 0) {
    return base;
  }
  const names = reaction.userIds.map((userId) => {
    const member = chat.currentMembers.find((item) => item.userId === userId);
    return member?.displayName ?? `用户#${userId}`;
  });
  return `${base} · ${names.join('、')}`;
}
// Receipts are for our own delivered messages only; bots and retracted rows
// never report. A member counts once their cursor passed this seq, and the
// reader list doubles as the tooltip so no extra UI is needed.
const readReceipt = computed(() => {
  if (!self.value || bot.value || deleted.value || props.message.status !== 'done') {
    return { count: 0, title: '' };
  }
  const readers = chat.currentMembers.filter(
    (member) =>
      member.userId !== auth.user?.id &&
      member.type !== 'bot' &&
      member.lastReadSeq >= props.message.seq,
  );
  return {
    count: readers.length,
    title: readers.map((member) => member.displayName).join('、'),
  };
});
// Retracted messages keep no card; the server may still carry stale fields.
const preview = computed(() => (deleted.value ? null : props.message.preview));
// The host is the card's identity line; fall back to the raw href if unparsable.
const previewHost = computed(() => {
  const url = preview.value?.url;
  if (!url) {
    return '';
  }
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
});

// The checkbox carries the row's identity: sender plus a short content
// summary, so a screen reader (or a test) can tell the rows apart.
const selectLabel = computed(() => {
  const summary = deleted.value
    ? '消息已撤回'
    : plainPreview(props.message.content).slice(0, 40) ||
      (attachments.value.length > 0 ? '[附件]' : '');
  return `选择 ${props.message.senderName}：${summary}`;
});

function hasReacted(userIds: number[]): boolean {
  return Boolean(auth.user && userIds.includes(auth.user.id));
}

async function copy() {
  actionsOpen.value = false;
  pickerOpen.value = false;
  try {
    await navigator.clipboard.writeText(props.message.content);
    copied.value = true;
    ElMessage.success('已复制');
    window.setTimeout(() => {
      copied.value = false;
    }, 1200);
  } catch {
    ElMessage.info(props.message.content);
  }
}

// The shareable permalink for this message: the room page scrolls to `seq`.
function messageLink(): string {
  return `${window.location.origin}/rooms/${props.message.roomId}?seq=${props.message.seq}`;
}

async function copyLink() {
  actionsOpen.value = false;
  pickerOpen.value = false;
  const url = messageLink();
  try {
    await navigator.clipboard.writeText(url);
    ElMessage.success('链接已复制');
  } catch {
    ElMessage.info(url);
  }
}

// Saving is a plain bookmark: the endpoint is idempotent, so the same toast
// covers both a fresh save and a repeat.
async function saveMessage() {
  actionsOpen.value = false;
  pickerOpen.value = false;
  try {
    await http.post(`/rooms/${props.message.roomId}/messages/${props.message.seq}/save`);
    ElMessage.success('消息已保存');
  } catch (error) {
    ElMessage.error(errorMessage(error));
  }
}

// Translation is scoped to this row: the server keeps nothing, so a reload or
// another viewer never sees this rendering. Only the newest request may land —
// a switch retires the one it replaced — and a failure never costs the reader
// the rendering they already had.
async function requestTranslation(lang: TranslateLang) {
  if (!canTranslate.value) {
    return;
  }
  const token = ++translateToken;
  translating.value = true;
  try {
    const response = await http.post<{ text?: string; targetLang?: string }>(
      `/rooms/${props.message.roomId}/messages/${props.message.seq}/translate`,
      { targetLang: lang },
    );
    if (token !== translateToken) {
      return;
    }
    const text = typeof response.data?.text === 'string' ? response.data.text.trim() : '';
    if (!text) {
      throw new Error('翻译失败');
    }
    translation.value = text;
  } catch (error) {
    if (token !== translateToken) {
      return;
    }
    ElMessage.error(errorMessage(error));
  } finally {
    if (token === translateToken) {
      translating.value = false;
    }
  }
}

async function translate() {
  if (!canTranslate.value || translating.value) {
    return;
  }
  actionsOpen.value = false;
  pickerOpen.value = false;
  await requestTranslation(currentTranslateLang());
}

// Switching languages re-requests the same text. The previous rendering stays
// on screen under the loading line until the new one lands. A value outside the
// shortlist (tampered DOM, stale option) is refused and the control snaps back
// to the current preference instead of sending it to the server.
function onTranslateLangChange(event: Event) {
  const target = event.target;
  if (!(target instanceof HTMLSelectElement)) {
    return;
  }
  const lang = matchTranslateLang(target.value);
  if (!lang) {
    target.value = currentTranslateLang();
    return;
  }
  if (lang === translateLang.value) {
    return;
  }
  translateLang.value = lang;
  writeStoredTranslateLang(lang);
  void requestTranslation(lang);
}

function hideTranslation() {
  // Hiding also vetoes a switch already in flight, so a late response cannot
  // repaint a dismissed block. The language preference survives untouched.
  translateToken += 1;
  translating.value = false;
  translation.value = null;
}

function startReply() {
  actionsOpen.value = false;
  emit('reply', props.message);
}

function startForward() {
  if (!canForward.value) {
    return;
  }
  actionsOpen.value = false;
  pickerOpen.value = false;
  emit('forward', props.message);
}

function startReport() {
  actionsOpen.value = false;
  pickerOpen.value = false;
  emit('report', props.message);
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

// The "已编辑" mark is the entry point to the edit trail; it stops the click
// so the row never treats it as a selection or a context-menu target.
function openHistory() {
  actionsOpen.value = false;
  pickerOpen.value = false;
  emit('history', props.message);
}

function toggleActions() {
  actionsOpen.value = !actionsOpen.value;
  pickerOpen.value = false;
}

// Selection mode turns the whole row into the control; the inline actions and
// links are inert while it is on (see the styles below).
function toggleSelection() {
  if (!props.selectable || deleted.value) {
    return;
  }
  emit('select', props.message);
}

function onSelectClick(event: MouseEvent) {
  if (!props.selectable) {
    return;
  }
  if (event.target instanceof Element && event.target.closest('.msg-select')) {
    return;
  }
  toggleSelection();
}

function togglePicker() {
  pickerOpen.value = !pickerOpen.value;
  if (!pickerOpen.value) {
    return;
  }
  // Read on open so a reaction added in another row (or tab) shows up here.
  customInput.value = '';
  customReactions.value = readCustomReactions();
}

function react(emoji: string) {
  actionsOpen.value = false;
  pickerOpen.value = false;
  emit('react', props.message, emoji);
}

// Poll votes travel with the message that owns them (room + seq), so the view
// can post without threading the poll id through the list.
function vote(optionIds: number[], done: (ok: boolean) => void) {
  emit('vote', props.message, optionIds, done);
}

function closePoll(done: (ok: boolean) => void) {
  emit('close', props.message, done);
}

// A typed reaction is used immediately and remembered as the newest shortcut.
function addCustomReaction() {
  const emoji = customInput.value.trim().slice(0, CUSTOM_MAX_LENGTH);
  if (!emoji) {
    return;
  }
  customInput.value = '';
  const recent = [emoji, ...customReactions.value.filter((item) => item !== emoji)].slice(
    0,
    CUSTOM_LIMIT,
  );
  customReactions.value = recent;
  writeCustomReactions(recent);
  react(emoji);
}

function onCustomEnter(event: KeyboardEvent) {
  // Enter that commits an IME candidate belongs to the IME, not to us.
  if (event.isComposing) {
    return;
  }
  event.preventDefault();
  addCustomReaction();
}

function scrollToReply() {
  if (!replyMessage.value) {
    return;
  }
  const element = document.querySelector(`[data-seq="${replyMessage.value.seq}"]`);
  element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function insideLink(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('a'));
}

function openMenu(x: number, y: number) {
  if (deleted.value || !menuItems.value.length) {
    return;
  }
  actionsOpen.value = false;
  pickerOpen.value = false;
  menuX.value = x;
  menuY.value = y;
  menuOpen.value = true;
}

function onContextMenu(event: MouseEvent) {
  // Selection mode owns the click: no menu (ours or the browser's).
  if (props.selectable) {
    event.preventDefault();
    return;
  }
  // Links keep the native menu; retracted rows have no actions at all.
  if (deleted.value || insideLink(event.target)) {
    return;
  }
  event.preventDefault();
  openMenu(event.clientX, event.clientY);
}

function cancelLongPress() {
  if (pressTimer !== null) {
    window.clearTimeout(pressTimer);
    pressTimer = null;
  }
}

function isSwipeBlockedTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  if (target.closest('a, button, input, textarea, select, [contenteditable="true"]')) {
    return true;
  }
  // Code blocks (and wide tables) scroll sideways inside the bubble; a drag
  // that starts there is that scroll, not a reply gesture.
  let node: Element | null = target;
  while (node && node !== root.value) {
    const style = window.getComputedStyle(node);
    if (
      (style.overflowX === 'auto' || style.overflowX === 'scroll') &&
      node.scrollWidth > node.clientWidth
    ) {
      return true;
    }
    node = node.parentElement;
  }
  return false;
}

function resetSwipe() {
  swipeTracking = false;
  swipeHorizontal = false;
  swipeFired = false;
}

function onSwipeTouchStart(event: TouchEvent) {
  resetSwipe();
  if (
    event.touches.length !== 1 ||
    window.innerWidth > SWIPE_MAX_WIDTH ||
    props.selectable ||
    deleted.value ||
    menuOpen.value ||
    isSwipeBlockedTarget(event.target)
  ) {
    return;
  }
  const touch = event.touches[0];
  swipeStartX = touch.clientX;
  swipeStartY = touch.clientY;
  swipeTracking = true;
}

function onSwipeTouchMove(event: TouchEvent) {
  if (!swipeTracking) {
    return;
  }
  if (event.touches.length !== 1) {
    resetSwipe();
    return;
  }
  const touch = event.touches[0];
  const dx = touch.clientX - swipeStartX;
  const dy = touch.clientY - swipeStartY;
  // Vertical drift belongs to the list's scroll; a row only takes a leftward
  // drag, and only while it stays roughly horizontal.
  if (Math.abs(dy) >= SWIPE_VERTICAL_SLOP) {
    resetSwipe();
    return;
  }
  if (!swipeHorizontal) {
    if (Math.abs(dx) < SWIPE_DECIDE_SLOP && Math.abs(dy) < SWIPE_DECIDE_SLOP) {
      return;
    }
    if (dx >= 0 || Math.abs(dy) >= -dx) {
      resetSwipe();
      return;
    }
    swipeHorizontal = true;
    // A horizontal drag can never become a long press.
    cancelLongPress();
  }
  // Only a recognised swipe is suppressed; vertical scrolling already kept
  // its native behaviour because nothing was prevented before this point.
  event.preventDefault();
  if (dx <= -SWIPE_REPLY_DISTANCE && !swipeFired) {
    swipeFired = true;
    startReply();
  }
}

function onSwipeTouchEnd() {
  resetSwipe();
}

function onPointerDown(event: PointerEvent) {
  longPressed = false;
  cancelLongPress();
  if (
    props.selectable ||
    event.pointerType === 'mouse' ||
    deleted.value ||
    insideLink(event.target) ||
    // A press on the language picker belongs to the native control.
    (event.target instanceof Element && Boolean(event.target.closest('select')))
  ) {
    return;
  }
  pressStartX = event.clientX;
  pressStartY = event.clientY;
  pressTimer = window.setTimeout(() => {
    pressTimer = null;
    longPressed = true;
    openMenu(pressStartX, pressStartY);
  }, LONG_PRESS_MS);
}

function onPointerMove(event: PointerEvent) {
  if (pressTimer === null) {
    return;
  }
  const moved = Math.hypot(event.clientX - pressStartX, event.clientY - pressStartY);
  if (moved > LONG_PRESS_SLOP) {
    cancelLongPress();
  }
}

// A long press must not also activate whatever sits under the finger.
function onClickCapture(event: MouseEvent) {
  if (!longPressed) {
    return;
  }
  longPressed = false;
  event.preventDefault();
  event.stopPropagation();
}

function onKeydown(event: KeyboardEvent) {
  if (props.selectable) {
    // The checkbox handles its own Space/Enter; the row handles the rest.
    if (event.target instanceof HTMLInputElement) {
      return;
    }
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault();
      toggleSelection();
    }
    return;
  }
  if (deleted.value) {
    return;
  }
  if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) {
    return;
  }
  event.preventDefault();
  const rect = root.value?.getBoundingClientRect();
  if (!rect) {
    return;
  }
  openMenu(rect.left + 12, rect.top + 12);
}

function onMenuSelect(id: string) {
  switch (id) {
    case 'reply':
      startReply();
      break;
    case 'forward':
      startForward();
      break;
    case 'copy':
      void copy();
      break;
    case 'copy-link':
      void copyLink();
      break;
    case 'translate':
      void translate();
      break;
    case 'save-message':
      void saveMessage();
      break;
    case 'report':
      startReport();
      break;
    case 'react':
      actionsOpen.value = false;
      togglePicker();
      break;
    case 'edit':
      startEdit();
      break;
    case 'pin':
      togglePin();
      break;
    case 'delete':
      remove();
      break;
  }
}

function onMenuClose() {
  menuOpen.value = false;
}

// Entering selection mode must not leave a context menu, action strip or
// emoji picker floating over the row it is about to toggle.
watch(
  () => props.selectable,
  (on) => {
    if (!on) {
      return;
    }
    actionsOpen.value = false;
    pickerOpen.value = false;
    menuOpen.value = false;
  },
);

// Editing or retracting the message invalidates the rendering it came from;
// retiring the token also keeps a late response from landing on new text.
watch(
  () => [props.message.content, props.message.deleted] as const,
  () => {
    translateToken += 1;
    translation.value = null;
    translating.value = false;
  },
);

onBeforeUnmount(() => {
  cancelLongPress();
  resetSwipe();
  // A row that scrolled out of the list must not toast into the next view.
  translateToken += 1;
});
</script>

<template>
  <div
    ref="root"
    class="msg"
    :class="{
      self,
      bot,
      compact,
      rich: isRich,
      poll: isPoll,
      highlight: props.highlight,
      deleted,
      selectable: props.selectable,
      selected: Boolean(props.selected) && !deleted,
    }"
    data-testid="message"
    :data-seq="message.seq"
    :tabindex="deleted ? undefined : 0"
    @contextmenu="onContextMenu"
    @keydown="onKeydown"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="cancelLongPress"
    @pointercancel="cancelLongPress"
    @pointerleave="cancelLongPress"
    @touchstart="onSwipeTouchStart"
    @touchmove="onSwipeTouchMove"
    @touchend="onSwipeTouchEnd"
    @touchcancel="onSwipeTouchEnd"
    @click.capture="onClickCapture"
    @click="onSelectClick"
  >
    <label v-if="selectable" class="msg-select" @click.stop>
      <input
        type="checkbox"
        data-testid="message-select"
        :checked="Boolean(selected) && !deleted"
        :disabled="deleted"
        :aria-label="selectLabel"
        @change="toggleSelection"
      />
    </label>
    <UserAvatar
      v-if="!self && !compact"
      :avatar="message.senderAvatar"
      :id="message.senderId"
      :name="message.senderName"
    />
    <span v-else-if="!self" class="avatar-spacer"></span>

    <div class="msg-body">
      <div v-if="!compact" class="msg-meta">
        <span v-if="!self" class="msg-sender">{{ message.senderName }}</span>
        <span v-if="bot" class="bot-tag">BOT</span>
        <span class="msg-time">{{ time }}</span>
        <button
          v-if="message.editedAt && !deleted"
          type="button"
          class="msg-mark edited-marker"
          data-testid="edited-marker"
          title="查看编辑历史"
          aria-label="查看编辑历史"
          :disabled="selectable"
          @click.stop="openHistory"
        >已编辑</button>
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
        <div class="bubble" :class="{ 'bubble-deleted': deleted, 'bubble-poll': poll }">
          <div v-if="deleted" class="bubble-content msg-deleted">消息已撤回</div>
          <template v-else>
            <div v-if="message.forwardedFrom" class="forward-tag">
              <Icon name="forward" :size="11" />
              <span class="forward-tag-text">
                转发自 {{ message.forwardedFrom.roomName }} ·
                {{ message.forwardedFrom.senderName }}
              </span>
            </div>
            <PollCard
              v-if="poll"
              :poll="poll"
              :can-close="canClosePoll"
              @vote="vote"
              @close="closePoll"
            />
            <template v-else>
              <div
                v-if="message.content.trim()"
                class="bubble-content"
                v-html="rendered"
              ></div>
              <MessageAttachments
                v-if="attachments.length > 0"
                :room-id="message.roomId"
                :attachments="attachments"
              />
              <a
                v-if="preview"
                class="link-preview"
                data-testid="link-preview"
                :href="preview.url"
                target="_blank"
                rel="noopener noreferrer"
              >
                <span v-if="preview.site" class="link-preview-site">{{ preview.site }}</span>
                <span v-if="preview.title" class="link-preview-title">{{ preview.title }}</span>
                <span v-if="preview.description" class="link-preview-desc">
                  {{ preview.description }}
                </span>
                <span class="link-preview-host">{{ previewHost }}</span>
              </a>
            </template>
            <span v-if="message.status === 'streaming'" class="cursor"></span>
            <span v-if="message.status === 'error'" class="msg-error">生成失败</span>
          </template>
        </div>
        <div v-if="translating || translation" class="translation" data-testid="translation">
          <div class="translation-head">
            <select
              class="translation-lang"
              data-testid="translation-lang"
              aria-label="翻译目标语言"
              :value="activeTranslateLang"
              @change="onTranslateLangChange"
            >
              <option v-for="option in TRANSLATE_LANGS" :key="option.value" :value="option.value">
                {{ option.label }}
              </option>
            </select>
            <span
              v-if="translating"
              class="translation-loading"
              data-testid="translation-loading"
            >翻译中…</span>
            <button
              v-if="translation"
              class="translation-hide"
              data-testid="translation-hide"
              type="button"
              title="隐藏翻译"
              aria-label="隐藏翻译"
              @click.stop="hideTranslation"
            >隐藏</button>
          </div>
          <span v-if="translation" class="translation-text" data-testid="translation-text">
            {{ translation }}
          </span>
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
            v-if="canForward"
            class="msg-action"
            type="button"
            title="转发"
            aria-label="转发"
            @click="startForward"
          >
            <Icon name="forward" :size="14" />
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
            v-for="emoji in customReactions"
            :key="`custom-${emoji}`"
            class="msg-emoji-item msg-emoji-recent"
            type="button"
            :aria-label="`自定义表情 ${emoji}`"
            :title="`最近使用 ${emoji}`"
            @click="react(emoji)"
          >
            {{ emoji }}
          </button>
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
          <div
            class="msg-emoji-custom"
            @pointerdown.stop
            @contextmenu.stop.prevent
          >
            <input
              v-model="customInput"
              class="msg-emoji-input"
              data-testid="custom-emoji-input"
              type="text"
              maxlength="16"
              placeholder="自定义表情"
              aria-label="自定义表情"
              enterkeyhint="done"
              autocomplete="off"
              @keydown.enter="onCustomEnter"
            />
            <button
              class="msg-emoji-add"
              data-testid="custom-emoji-add"
              type="button"
              :disabled="!customInput.trim()"
              @click="addCustomReaction"
            >添加</button>
          </div>
        </div>
        <div
          v-if="!deleted && (reactions.length || (compact && (message.editedAt || message.pinned)))"
          class="msg-reactions"
        >
          <button
            v-if="compact && message.editedAt && !deleted"
            type="button"
            class="msg-mark edited-marker"
            data-testid="edited-marker"
            title="查看编辑历史"
            aria-label="查看编辑历史"
            :disabled="selectable"
            @click.stop="openHistory"
          >已编辑</button>
          <span v-if="compact && message.pinned" class="msg-mark pin-mark" title="已置顶">
            <Icon name="pin" :size="12" />
          </span>
          <button
            v-for="reaction in reactions"
            :key="reaction.emoji"
            class="reaction-chip"
            :class="{ mine: hasReacted(reaction.userIds) }"
            type="button"
            :title="reactionTitle(reaction)"
            @click="react(reaction.emoji)"
          >
            <span class="reaction-emoji">{{ reaction.emoji }}</span>
            <span class="reaction-count">{{ reaction.count }}</span>
          </button>
        </div>
        <span
          v-if="readReceipt.count > 0"
          class="msg-read-receipt"
          data-testid="read-receipt"
          :title="readReceipt.title"
        >已读 {{ readReceipt.count }}</span>
      </div>
    </div>

    <UserAvatar
      v-if="self && !compact"
      :avatar="message.senderAvatar"
      :id="message.senderId"
      :name="message.senderName"
    />

    <MessageContextMenu
      :open="menuOpen"
      :x="menuX"
      :y="menuY"
      :items="menuItems"
      @select="onMenuSelect"
      @close="onMenuClose"
    />
  </div>
</template>

<style scoped>
/* "已编辑" is a control, not a stamp: it keeps the mono ramp of the other
   micro-labels but drops every button affordance until it is hovered. */
.edited-marker {
  padding: 0;
  border: 0;
  background: none;
  font-weight: inherit;
  line-height: inherit;
  cursor: pointer;
  text-decoration: underline dotted transparent;
  text-underline-offset: 2px;
  transition: color 0.12s ease-out, text-decoration-color 0.12s ease-out;
}

.edited-marker:hover,
.edited-marker:focus-visible {
  color: var(--text);
  text-decoration-color: currentColor;
}

.edited-marker:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: 2px;
}

.edited-marker:disabled {
  color: var(--faint);
  cursor: default;
}

/* Selection mode owns the row click; the marker must not open a dialog. */
.msg.selectable .edited-marker {
  pointer-events: none;
}

/* Own-message receipt: quiet mono tail under the bubble, right-aligned by the
   bubble-wrap's self alignment — it never shares a line with time/marks. */
.msg-read-receipt {
  margin-top: 2px;
  padding: 0 2px;
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  line-height: 1.4;
  letter-spacing: 0.02em;
  white-space: nowrap;
}

/* Translation: a reading aid under the bubble, not a second utterance. The
   left rule marks it as derived text; the head carries the target-language
   picker and the hide control, so the block stays retargetable and dismissible
   without a reload — nothing about it is stored server-side. */
.translation {
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-width: min(560px, 100%);
  margin-top: 2px;
  padding: 5px 9px;
  border-left: 2px solid var(--rust);
  border-radius: 0 var(--r-sm) var(--r-sm) 0;
  background: var(--paper-3);
  color: var(--text);
  font-size: var(--fs-sub);
  line-height: 1.5;
  white-space: normal;
}

.translation-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}

/* The picker reads as a quiet mono label, not as a form field: the bubble's
   paper well already carries the surface, so only a hairline underlines it. */
.translation-lang {
  flex: none;
  max-width: 100%;
  padding: 0 2px;
  border: 0;
  border-bottom: 1px solid var(--line-strong);
  border-radius: 0;
  background: none;
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  line-height: 1.5;
  letter-spacing: 0.02em;
  cursor: pointer;
}

.translation-lang:hover,
.translation-lang:focus-visible {
  color: var(--text);
  border-bottom-color: var(--rust);
}

.translation-lang:focus-visible {
  outline: 2px solid var(--rust);
  outline-offset: 1px;
}

.translation-loading {
  flex: none;
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  letter-spacing: 0.02em;
}

.translation-text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.translation-hide {
  flex: none;
  padding: 0;
  border: 0;
  background: none;
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  line-height: 1.5;
  cursor: pointer;
}

.translation-hide:hover,
.translation-hide:focus-visible {
  color: var(--text);
  text-decoration: underline;
}

.translation-hide:focus-visible {
  outline: 2px solid var(--rust);
  outline-offset: 1px;
}

/* Gold self bubbles keep their sub-cards as ink tints, not paper wells. */
.msg.self .translation {
  border-left-color: var(--ink-2);
  background: rgba(22, 28, 54, 0.08);
  color: var(--ink);
}

.msg.self .translation-loading,
.msg.self .translation-hide,
.msg.self .translation-lang {
  color: var(--ink-2);
}

.msg.self .translation-lang {
  border-bottom-color: var(--ink-2);
}

.msg.self .translation-hide:hover,
.msg.self .translation-hide:focus-visible,
.msg.self .translation-lang:hover,
.msg.self .translation-lang:focus-visible {
  color: var(--ink);
}

/* Origin label for a forwarded copy: quiet, left-ruled, inside the bubble. */
.forward-tag {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 6px;
  padding: 1px 8px 1px 6px;
  border-left: 2px solid var(--rust);
  border-radius: 0 var(--r-sm) var(--r-sm) 0;
  background: var(--paper-3);
  color: var(--muted);
  font-size: var(--fs-mono);
  font-family: var(--font-mono);
  line-height: 1.7;
  letter-spacing: 0.02em;
  white-space: normal;
}

.forward-tag-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Gold self bubbles need the ink tint to keep the label legible. */
.msg.self .forward-tag {
  background: rgba(22, 28, 54, 0.1);
  color: var(--ink-2);
  border-left-color: var(--ink-2);
}

/* Link preview: a quiet well inside the bubble — no external media, ever. */
.link-preview {
  display: flex;
  flex-direction: column;
  gap: 2px;
  box-sizing: border-box;
  max-width: 320px;
  margin-top: 7px;
  padding: 7px 9px;
  border: 1px solid var(--line);
  border-left: 2px solid var(--rust);
  border-radius: 0 var(--r-sm) var(--r-sm) 0;
  background: var(--paper-3);
  color: var(--text);
  font-size: var(--fs-mono);
  line-height: 1.5;
  text-decoration: none;
  white-space: normal;
}

.link-preview:focus-visible {
  outline: 2px solid var(--rust);
  outline-offset: 1px;
}

.link-preview-site {
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  overflow-wrap: anywhere;
}

.link-preview-title {
  color: var(--text);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.4;
  overflow-wrap: anywhere;
}

.link-preview-desc {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  color: var(--muted);
  overflow-wrap: anywhere;
}

.link-preview-host {
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.link-preview:hover .link-preview-title {
  color: var(--rust);
}

/* Gold self bubbles: the paper well would glare, so tint the ink instead. */
.msg.self .link-preview {
  border-color: rgba(22, 28, 54, 0.28);
  border-left-color: var(--ink-2);
  background: rgba(22, 28, 54, 0.08);
  color: var(--ink);
}

.msg.self .link-preview-site,
.msg.self .link-preview-host,
.msg.self .link-preview-desc {
  color: var(--ink-2);
}

.msg.self .link-preview-title {
  color: var(--ink);
}

.msg.self .link-preview:hover .link-preview-title {
  color: var(--ink);
  text-decoration: underline;
}

/* Selection mode: the row is the toggle. Inline actions and links step aside
   so a click can never navigate, react or open a menu mid-selection. */
.msg.selectable {
  border-radius: var(--r-md);
  cursor: pointer;
  transition: background 0.12s ease-out;
}

.msg.selectable:not(.selected):hover {
  background: var(--paper-2);
}

.msg.selected {
  background: var(--paper-3);
  box-shadow: inset 2px 0 0 var(--rust);
}

.msg.selectable .msg-more,
.msg.selectable .msg-actions,
.msg.selectable .msg-emoji-pop {
  display: none;
}

/* The bubble can hold sanitized markdown (rendered with v-html, so no scope
   attribute): disable the whole surface instead of its links, and let the
   click fall through to the row toggle. */
.msg.selectable .bubble,
.msg.selectable .reply-quote,
.msg.selectable .reaction-chip,
.msg.selectable .translation {
  pointer-events: none;
}

/* Checkbox sits in the avatar gutter, level with the meta line. */
.msg-select {
  display: flex;
  flex: none;
  align-items: flex-start;
  padding-top: 3px;
  cursor: pointer;
}

.msg-select input {
  width: 16px;
  height: 16px;
  margin: 0;
  accent-color: var(--rust);
  cursor: pointer;
}

.msg-select input:disabled {
  cursor: not-allowed;
  opacity: 0.4;
}

/* Custom reactions: remembered shortcuts sit ahead of the fixed shortlist and
   are underlined, so the extra row still reads as one grid. */
.msg-emoji-recent {
  box-shadow: inset 0 -2px 0 var(--rust);
}

.msg-emoji-custom {
  display: flex;
  grid-column: 1 / -1;
  gap: 4px;
  align-items: center;
  margin-top: 2px;
  padding-top: 4px;
  border-top: 1px solid var(--line);
}

.msg-emoji-input {
  flex: 1;
  min-width: 0;
  height: 26px;
  padding: 0 6px;
  border: 1px solid var(--line-strong);
  border-radius: var(--r-sm);
  background: var(--paper);
  color: var(--text);
  font-family: inherit;
  font-size: 12px;
}

.msg-emoji-input::placeholder {
  color: var(--muted);
}

.msg-emoji-input:focus {
  outline: none;
  border-color: var(--rust);
}

.msg-emoji-add {
  flex: none;
  height: 26px;
  padding: 0 8px;
  border: none;
  border-radius: var(--r-sm);
  background: var(--ink);
  color: var(--paper);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}

.msg-emoji-add:disabled {
  cursor: not-allowed;
  opacity: 0.4;
}

/* Polls are cards, not utterances: the bubble becomes a neutral surface for
   both own and bot rows, and the card gets the row's full width so long
   options and tallies stay readable. */
.msg.poll .msg-body {
  width: 100%;
  max-width: min(480px, 84%);
}

.msg.poll .bubble-wrap {
  display: block;
  width: 100%;
}

.bubble.bubble-poll,
.msg.self .bubble.bubble-poll {
  width: 100%;
  padding: 10px 12px;
  border-color: var(--line-strong);
  border-radius: var(--r-md);
  background: var(--paper-2);
  color: var(--text);
  font-weight: 400;
}

.msg.bot .bubble.bubble-poll {
  border-left: 1px solid var(--line-strong);
}
</style>
