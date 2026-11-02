<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import http, { errorMessage } from '../api/http';
import { useAuthStore } from '../stores/auth';
import { useChatStore } from '../stores/chat';
import type { Attachment, Member, Message } from '../types';
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
  send: [content: string, attachmentIds: number[], done: (ok: boolean) => void];
  schedule: [content: string, done: (ok: boolean) => void];
  typing: [isTyping: boolean];
  'cancel-reply': [];
  'cancel-edit': [];
  'edit-last': [];
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
const auth = useAuthStore();
const chat = useChatStore();
// Files upload the moment they are picked, so the message itself stays a small
// socket payload. Until the ack binds them the rows are unbound on the server:
// a failed send keeps the chips, and only a confirmed send releases them.
const attachInput = ref<HTMLInputElement | null>(null);
const pendingAttachments = ref<Attachment[]>([]);
const uploadingCount = ref(0);

// --- Voice notes ---------------------------------------------------------
// Recording stays in memory as chunks, then becomes a File and rides the same
// upload path as a picked file: the message itself remains a small socket
// payload, and the empty-body send case is covered by the attachment tray.
const RECORD_LIMIT_SECONDS = 120;
// WebM/Opus is the one container every Chromium and Firefox build encodes;
// Safari falls back to whatever it supports (and may reject the type even
// after advertising it, hence the retry without options).
const RECORD_MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'];
const RECORD_EXTENSIONS: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
};
const recording = ref(false);
const recordStarting = ref(false);
const recordSeconds = ref(0);
let recorder: MediaRecorder | null = null;
let recordStream: MediaStream | null = null;
let recordTimer: number | undefined;
// Set by every teardown that is not the user pressing stop twice; the stop
// handler reads it before it turns the chunks into an upload.
let discardOnStop = false;
let disposed = false;

const ATTACH_LIMIT = 10;
const ATTACH_MAX_BYTES = 10 * 1024 * 1024;
// Mirrors the server's allow-list; the `accept` hint is only a filter, the
// upload route is the authority.
const ATTACH_ACCEPT = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'video/mp4',
  'video/webm',
  'application/pdf',
  'text/plain',
  'application/zip',
  'audio/mpeg',
  'audio/ogg',
  'audio/webm',
].join(',');
// Drafts are per account *and* per room: a shared browser must never hand
// one user's unsent text to the next, and two rooms must not share a key.
const draftKey = computed(
  () => `bfa_draft_${auth.user?.id ?? 'anon'}_${props.roomId}`,
);

// --- Server draft sync ----------------------------------------------------
// localStorage stays the instant, offline-safe copy: it paints the field
// before the network answers and survives a failed request. The server row is
// the account-wide copy that makes the draft follow the user to another
// device; it is only ever read and written for the caller's own (user, room).
const DRAFT_SAVE_DELAY_MS = 800;
// Mirrors the API cap. A longer body is rejected with 400, so the request is
// skipped instead; localStorage still holds the full text.
const DRAFT_CONTENT_MAX = 4000;

interface DraftDTO {
  content: string;
  updatedAt: string;
}

// Only the newest GET may touch the field. A slow answer for a room the user
// already left — or one issued before a send cleared the draft — is dropped.
let draftLoadSeq = 0;
let draftTimer: number | undefined;
// True once the user changed the field in this room. A server draft is only
// adopted while the composer is untouched and still empty.
let draftTouched = false;
// Server writes are chained: the PUT is an unconditional last-write-wins
// upsert, so an older debounce must never land after a newer one.
let draftSaveQueue: Promise<void> = Promise.resolve();

function queueDraftSave(room: number, value: string) {
  if (value.length > DRAFT_CONTENT_MAX) {
    return;
  }
  draftSaveQueue = draftSaveQueue
    .then(async () => {
      try {
        await http.put(`/rooms/${room}/draft`, { content: value });
      } catch {
        // Offline, rate limited or no longer a member: localStorage still has
        // the text, and the next edit or room entry retries the server copy.
      }
    })
    .catch(() => undefined);
}

function scheduleDraftSave(room: number) {
  if (disposed || props.roomId !== room) {
    return;
  }
  window.clearTimeout(draftTimer);
  draftTimer = window.setTimeout(() => {
    draftTimer = undefined;
    if (disposed || props.roomId !== room) {
      return;
    }
    const value = content.value;
    // Whitespace-only means "no draft", matching the localStorage rule and
    // the API's single empty representation (the row is deleted).
    queueDraftSave(room, value.trim() ? value : '');
  }, DRAFT_SAVE_DELAY_MS);
}

function clearServerDraft(room: number) {
  if (props.roomId === room) {
    window.clearTimeout(draftTimer);
    draftTimer = undefined;
    // A GET issued before the clear could still carry the row that was just
    // deleted; invalidate it so the empty composer is not refilled.
    draftLoadSeq += 1;
    // The user acted on this room's draft (sent or scheduled it), so a later
    // GET in the same visit must not put the cleared text back either.
    draftTouched = true;
  }
  queueDraftSave(room, '');
}

async function loadServerDraft(room: number) {
  const seq = ++draftLoadSeq;
  let draft: DraftDTO | null = null;
  try {
    const { data } = await http.get<{ draft: DraftDTO | null }>(
      `/rooms/${room}/draft`,
    );
    draft = data.draft;
  } catch {
    // Offline, rate limited or no longer a member: keep the local copy and
    // never clear the field because the request failed.
    return;
  }
  if (disposed || seq !== draftLoadSeq || props.roomId !== room) {
    return;
  }
  // Editing borrows the field; its text belongs to a message, not the draft.
  if (props.editing) {
    return;
  }
  if (content.value.trim()) {
    // This device already has text, so it wins: push it after the debounce so
    // the other devices converge on the same last-write-wins value.
    scheduleDraftSave(room);
    return;
  }
  if (draftTouched) {
    // The user emptied the field while the request was in flight; the clear
    // it scheduled is newer than this response, so do not resurrect the row.
    return;
  }
  if (!draft?.content) {
    return;
  }
  // Untouched and empty: adopt the account's draft and persist it through the
  // content watcher, without scheduling a write of the value just read.
  content.value = draft.content;
  nextTick(resize);
}

// Every edit path calls this: the textarea's input event plus the toolbar
// helpers that assign `content` directly. It is the only place that arms a
// server write, so programmatic restores (room load, adoption, cancel edit)
// never echo a value back.
function markDraftInput(value: string) {
  if (props.editing) {
    return;
  }
  draftTouched = true;
  if (!value.trim()) {
    // Emptying the field is a delete, not a debounced save: queue it at once
    // so leaving the room in the next tick cannot cancel the clear and let
    // another device resurrect the row this user just removed.
    window.clearTimeout(draftTimer);
    draftTimer = undefined;
    queueDraftSave(props.roomId, '');
    return;
  }
  scheduleDraftSave(props.roomId);
}
const attachmentsBusy = computed(() => uploadingCount.value > 0);
// Recording shares the picker's exclusions; while it is running the button
// must stay live so it can stop, so only the idle state is disabled.
const recordDisabled = computed(
  () =>
    !recording.value &&
    (recordStarting.value ||
      Boolean(props.disabled) ||
      sending.value ||
      Boolean(props.editing) ||
      uploadingCount.value > 0),
);
const recordTimerText = computed(() => {
  const total = Math.min(recordSeconds.value, RECORD_LIMIT_SECONDS);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
});
// Attachment-only sends are valid, but never while an upload is still in the
// air: clicking send then would silently drop the file the user just picked.
const canSend = computed(
  () =>
    !props.disabled &&
    !sending.value &&
    !attachmentsBusy.value &&
    (content.value.trim().length > 0 || pendingAttachments.value.length > 0),
);
let lastTypingAt = 0;
let stopTimer: number | undefined;

onMounted(() => {
  content.value = localStorage.getItem(draftKey.value) ?? '';
  nextTick(resize);
  const room = props.roomId;
  // A local draft is the newer state of this device; push it while the GET
  // below checks whether the account has anything else.
  if (content.value.trim()) {
    scheduleDraftSave(room);
  }
  void loadServerDraft(room);
});

watch(
  () => props.roomId,
  () => {
    // A capture belongs to the composer that started it; the new room never
    // sees a half-recorded note the user cannot cancel any more.
    cancelRecording();
    // Drop every pending draft write and invalidate the outgoing room's GET:
    // the incoming room's field must never receive the old room's text.
    draftLoadSeq += 1;
    draftTouched = false;
    window.clearTimeout(draftTimer);
    draftTimer = undefined;
    window.clearTimeout(stopTimer);
    emit('typing', false);
    content.value = localStorage.getItem(draftKey.value) ?? '';
    // Unbound rows belong to the outgoing room; they can never be claimed by a
    // message in the new one, and the chips must not imply otherwise.
    pendingAttachments.value = [];
    mentionOpen.value = false;
    nextTick(resize);
    const room = props.roomId;
    if (content.value.trim()) {
      scheduleDraftSave(room);
    }
    void loadServerDraft(room);
  },
);

// Editing borrows the composer: the text comes from the message, the draft
// stays untouched until the edit is committed or cancelled.
watch(
  () => props.editing,
  (message) => {
    // Editing borrows the composer and sends text only: an in-flight capture
    // would be unreachable behind the edit bar.
    cancelRecording();
    mentionOpen.value = false;
    emojiOpen.value = false;
    // Editing must never overwrite the room draft: cancel the debounce armed
    // for the draft so it cannot fire later with the message text, and do not
    // adopt a server draft into a field that is showing a message.
    window.clearTimeout(draftTimer);
    draftTimer = undefined;
    if (message) {
      content.value = message.content;
      // An edit only carries text; a pending upload would be stranded if the
      // user could still see it next to an edit box.
      pendingAttachments.value = [];
      nextTick(() => {
        resize();
        textarea.value?.focus();
      });
      return;
    }
    content.value = localStorage.getItem(draftKey.value) ?? '';
    // The edit is over and the room draft is back. Its debounce was cancelled
    // above, so push the restored text once more if it has content. An empty
    // field either re-checks the account draft (untouched composer) or
    // re-issues the clear the edit cancelled (the user had emptied it).
    if (content.value.trim()) {
      scheduleDraftSave(props.roomId);
    } else if (draftTouched) {
      queueDraftSave(props.roomId, '');
    } else {
      void loadServerDraft(props.roomId);
    }
    nextTick(resize);
  },
);

// A composer that became read-only cannot finish a voice note: close the mic
// instead of leaving it open behind a disabled send button.
watch(
  () => props.disabled,
  (disabled) => {
    if (disabled) {
      cancelRecording();
    }
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
  // overwrite (or delete) the saved draft of the room. The key is read
  // before the await too — switching rooms mid-tick must not write the
  // outgoing room's text under the incoming room's key.
  const isEdit = Boolean(props.editing);
  const key = draftKey.value;
  const room = props.roomId;
  await nextTick();
  resize();
  if (!isEdit) {
    if (value.trim()) {
      localStorage.setItem(key, value);
    } else {
      localStorage.removeItem(key);
    }
  }
  // Restoring a draft (room load, edit cancel, server adoption) is not the
  // user typing; only a real input arms the indicator and its expiry.
  if (!value || isEdit || !draftTouched || props.roomId !== room) {
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
  disposed = true;
  // A debounce that outlives the composer could write another room's field
  // after navigation; localStorage already holds the text.
  draftLoadSeq += 1;
  window.clearTimeout(draftTimer);
  draftTimer = undefined;
  cancelRecording();
  window.clearTimeout(stopTimer);
  emit('typing', false);
});

function onInput(event: Event) {
  detectMention();
  markDraftInput((event.target as HTMLTextAreaElement).value);
}

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
  markDraftInput(content.value);
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
  markDraftInput(content.value);
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
  markDraftInput(content.value);
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

function openAttachPicker() {
  if (props.disabled || props.editing || sending.value) {
    return;
  }
  attachInput.value?.click();
}

function onAttachPicked(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  // Reset first: picking the same file twice must fire `change` again.
  input.value = '';
  void uploadFiles(files);
}

// Uploads run one at a time so the tray keeps its pick order and a burst of
// large files cannot stack requests against the same rate limiter. The room is
// captured up front: switching rooms mid-upload discards the late result
// instead of parking another room's file in this composer.
async function uploadFiles(files: File[]) {
  if (files.length === 0) {
    return;
  }
  const slots = ATTACH_LIMIT - pendingAttachments.value.length - uploadingCount.value;
  if (slots <= 0) {
    ElMessage.warning(`最多添加 ${ATTACH_LIMIT} 个附件`);
    return;
  }
  const room = props.roomId;
  for (const file of files.slice(0, slots)) {
    if (file.size > ATTACH_MAX_BYTES) {
      ElMessage.error(`${file.name} 超过 10MB`);
      continue;
    }
    uploadingCount.value += 1;
    try {
      const attachment = await chat.uploadAttachment(room, file);
      if (props.roomId === room) {
        pendingAttachments.value = [...pendingAttachments.value, attachment];
      }
    } catch (error) {
      ElMessage.error(`${file.name}：${errorMessage(error)}`);
    } finally {
      uploadingCount.value -= 1;
    }
  }
  if (files.length > slots) {
    ElMessage.warning(`最多添加 ${ATTACH_LIMIT} 个附件`);
  }
}

function removeAttachment(id: number) {
  pendingAttachments.value = pendingAttachments.value.filter((file) => file.id !== id);
}

function canStartRecording(): boolean {
  return (
    !props.disabled && !sending.value && !props.editing && uploadingCount.value === 0
  );
}

// The recorder picks the first type the build can actually encode; an empty
// answer means "let the browser choose", whose default is still audio/*.
function pickRecordMime(): string {
  if (typeof MediaRecorder.isTypeSupported !== 'function') {
    return '';
  }
  return (
    RECORD_MIME_CANDIDATES.find((type) => {
      try {
        return MediaRecorder.isTypeSupported(type);
      } catch {
        return false;
      }
    }) ?? ''
  );
}

function baseRecordMime(type: string): string {
  const base = type.split(';')[0]?.trim().toLowerCase() ?? '';
  return base.startsWith('audio/') ? base : 'audio/webm';
}

function recordTimestamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

function recordErrorMessage(error: unknown): string {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return '麦克风权限被拒绝，请在浏览器设置中允许录音';
  }
  if (name === 'NotFoundError') {
    return '没有找到可用的麦克风';
  }
  if (name === 'NotReadableError') {
    return '麦克风被其他应用占用，请稍后重试';
  }
  if (name === 'NotSupportedError') {
    return '当前浏览器不支持录音';
  }
  return errorMessage(error);
}

function clearRecordTimer() {
  if (recordTimer !== undefined) {
    window.clearInterval(recordTimer);
    recordTimer = undefined;
  }
}

function stopRecordTracks() {
  recordStream?.getTracks().forEach((track) => track.stop());
  recordStream = null;
}

// `keep` is true only for the two ways a capture is meant to be sent (the
// stop click and the 120s cap); every other teardown discards the chunks.
function stopRecording(keep: boolean) {
  const active = recorder;
  if (!active) {
    return;
  }
  discardOnStop = !keep;
  recording.value = false;
  clearRecordTimer();
  try {
    if (active.state !== 'inactive') {
      active.stop();
      if (!keep) {
        // Discarding: close the device in this task rather than trusting the
        // asynchronous `stop` event, so an unmount or room switch can never
        // leave the microphone open. `onstop` still runs and drops the chunks.
        stopRecordTracks();
      }
      return;
    }
  } catch {
    // `stop()` can throw when the recorder is already torn down; the
    // synchronous cleanup below still runs.
  }
  recorder = null;
  // `stop` never fired: finish here, without an upload.
  discardOnStop = false;
  stopRecordTracks();
}

function cancelRecording() {
  // Only an *active* capture is cancelled. Once the user stopped it, the
  // recorder is still winding down but the note is already theirs to send,
  // so a room switch or unmount must not silently flip it to "discard".
  if (recording.value && recorder) {
    stopRecording(false);
  }
}

function toggleRecording() {
  if (recording.value) {
    stopRecording(true);
    return;
  }
  void startRecording();
}

async function startRecording() {
  if (recording.value || recordStarting.value || recorder || !canStartRecording()) {
    return;
  }
  const devices = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices;
  if (!devices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    ElMessage.warning('当前浏览器不支持录音');
    return;
  }
  const room = props.roomId;
  recordStarting.value = true;
  let stream: MediaStream | null = null;
  try {
    stream = await devices.getUserMedia({ audio: true });
    // The permission prompt can outlive the composer: a room switch, an edit,
    // a read-only room or an unmount must not leave the microphone open.
    if (disposed || props.roomId !== room || !canStartRecording()) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    const preferred = pickRecordMime();
    let active: MediaRecorder;
    try {
      active = preferred
        ? new MediaRecorder(stream, { mimeType: preferred })
        : new MediaRecorder(stream);
    } catch {
      // Advertised but rejected on construction (older Safari): fall back to
      // the browser default instead of failing the whole recording.
      active = new MediaRecorder(stream);
    }
    const chunks: Blob[] = [];
    recordStream = stream;
    recorder = active;
    discardOnStop = false;
    active.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
      }
    };
    active.onstop = () => {
      // No newer capture can exist while this recorder is alive, so this
      // teardown always owns the current stream and timer.
      if (recorder !== active) {
        return;
      }
      recorder = null;
      recording.value = false;
      clearRecordTimer();
      stopRecordTracks();
      if (discardOnStop || disposed || props.roomId !== room) {
        discardOnStop = false;
        return;
      }
      void uploadRecording(chunks, baseRecordMime(active.mimeType || preferred));
    };
    active.onerror = () => {
      ElMessage.error('录音失败，请重试');
      stopRecording(false);
    };
    active.start();
    recording.value = true;
    recordSeconds.value = 0;
    recordTimer = window.setInterval(() => {
      recordSeconds.value += 1;
      if (recordSeconds.value >= RECORD_LIMIT_SECONDS) {
        // Hitting the cap is a normal stop: the note is kept and uploaded.
        stopRecording(true);
      }
    }, 1000);
  } catch (error) {
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
    }
    // A throw from `start()` or the constructor must not leave a half-built
    // recorder behind: it would block every later attempt in this composer.
    recordStream = null;
    recorder = null;
    recording.value = false;
    clearRecordTimer();
    if (!disposed) {
      ElMessage.error(recordErrorMessage(error));
    }
  } finally {
    recordStarting.value = false;
  }
}

async function uploadRecording(chunks: Blob[], mime: string) {
  if (chunks.length === 0) {
    return;
  }
  const extension = RECORD_EXTENSIONS[mime] ?? 'webm';
  const blob = new Blob(chunks, { type: mime });
  const file = new File([blob], `voice-${recordTimestamp()}.${extension}`, {
    type: mime,
  });
  await uploadFiles([file]);
}

function submit() {
  if (!canSend.value) {
    return;
  }
  const value = content.value.trim();
  const ids = pendingAttachments.value.map((file) => file.id);
  sending.value = true;
  // The ack can land after the user switched rooms; keep the key of the
  // room this text belongs to instead of re-reading the current one.
  const key = draftKey.value;
  const room = props.roomId;
  const sent = new Set(ids);
  const done = (ok: boolean) => {
    sending.value = false;
    if (!ok) {
      // The message row was never created, so the uploaded rows are still
      // unbound: keeping the chips lets the user retry without re-uploading.
      return;
    }
    pendingAttachments.value = pendingAttachments.value.filter(
      (file) => !sent.has(file.id),
    );
    // While editing, the parent clears `editing` and the watcher above
    // restores the room draft — touching the field here would race it.
    if (props.editing) {
      return;
    }
    // The ack outlived the room (or the field moved on). Only drop the
    // outgoing room's stored copy when it still holds exactly the text that
    // was sent; text typed after coming back is a newer draft and must win.
    if (props.roomId !== room) {
      const stored = localStorage.getItem(key);
      if (stored === null || stored.trim() === value) {
        localStorage.removeItem(key);
        if (value) {
          clearServerDraft(room);
        }
      }
      return;
    }
    if (content.value.trim() !== value) {
      return;
    }
    content.value = '';
    localStorage.removeItem(key);
    // The text became a message, so no device should keep offering it as a
    // draft. The clear is queued behind any save already in flight, so an
    // older PUT cannot resurrect the row after this one. An attachment-only
    // send carried no text, so it must not erase a draft this device never
    // had (for example one another device wrote while this GET was in flight).
    if (value) {
      clearServerDraft(room);
    }
    nextTick(resize);
  };
  try {
    emit('send', value, ids, done);
  } catch {
    // A throwing listener must never leave the composer stuck in "sending".
    done(false);
  }
}

// The dialog owns the queue call; the composer only clears its own text once
// the server confirmed the row. A pending edit borrows the field, so it never
// offers the clock — that text belongs to a message, not to a draft. Scheduled
// delivery carries text only, so it stays off while files wait in the tray.
function openSchedule() {
  if (
    sending.value ||
    props.disabled ||
    props.editing ||
    attachmentsBusy.value ||
    pendingAttachments.value.length > 0
  ) {
    return;
  }
  const value = content.value.trim();
  if (!value) {
    return;
  }
  const key = draftKey.value;
  const room = props.roomId;
  const done = (ok: boolean) => {
    // Only the text that was actually scheduled may be cleared: typing while
    // the dialog is open (or switching rooms mid-request) must survive, and a
    // failed request keeps the draft.
    if (!ok) {
      return;
    }
    if (props.roomId !== room) {
      const stored = localStorage.getItem(key);
      if (stored === null || stored.trim() === value) {
        localStorage.removeItem(key);
        clearServerDraft(room);
      }
      return;
    }
    if (content.value.trim() !== value) {
      return;
    }
    content.value = '';
    localStorage.removeItem(key);
    // The queued message owns this text now; clear the account draft too so
    // another device does not reopen the same composer content.
    clearServerDraft(room);
    nextTick(resize);
  };
  try {
    emit('schedule', value, done);
  } catch {
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
  if (
    event.key === 'Escape' &&
    !event.shiftKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey
  ) {
    // Shift+Esc belongs to the global "mark room read" shortcut, so the
    // cancel branches stay bare-key only.
    if (props.editing) {
      event.preventDefault();
      emit('cancel-edit');
      return;
    }
    if (props.replyTo) {
      event.preventDefault();
      emit('cancel-reply');
      return;
    }
    if (emojiOpen.value) {
      emojiOpen.value = false;
      return;
    }
  }
  if (
    event.key === 'ArrowUp' &&
    !event.shiftKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !content.value.trim() &&
    !props.replyTo &&
    !props.editing &&
    !emojiOpen.value
  ) {
    event.preventDefault();
    emit('edit-last');
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
      <input
        ref="attachInput"
        class="attach-input"
        data-testid="attach-input"
        type="file"
        multiple
        :accept="ATTACH_ACCEPT"
        @change="onAttachPicked"
      />
      <button
        class="composer-tool"
        type="button"
        title="添加附件"
        aria-label="添加附件"
        data-testid="attach-open"
        :disabled="props.disabled || sending || Boolean(editing)"
        @click="openAttachPicker"
      >
        <Icon name="copy" :size="14" />
      </button>
      <button
        class="composer-tool record-tool"
        :class="{ recording, active: recording }"
        type="button"
        title="录制语音"
        aria-label="录制语音"
        data-testid="record-audio"
        :disabled="recordDisabled"
        @click="toggleRecording"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z" />
          <path d="M19 11a7 7 0 0 1-14 0M12 18v3" />
        </svg>
        <span v-if="recording" class="record-timer" data-testid="record-timer">
          {{ recordTimerText }}
        </span>
      </button>
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
      <button
        class="composer-tool"
        type="button"
        title="定时发送"
        aria-label="定时发送"
        data-testid="schedule-open"
        :disabled="
          props.disabled ||
          sending ||
          !content.trim() ||
          Boolean(editing) ||
          attachmentsBusy ||
          pendingAttachments.length > 0
        "
        @mousedown.prevent="openSchedule"
      >
        <Icon name="clock" :size="14" />
      </button>
    </div>

    <div
      v-if="pendingAttachments.length > 0 || uploadingCount > 0"
      class="attach-tray"
      data-testid="attach-tray"
    >
      <span
        v-for="file in pendingAttachments"
        :key="file.id"
        class="attach-chip"
        data-testid="attach-chip"
        :title="file.filename"
      >
        <Icon name="copy" :size="12" />
        <span class="attach-chip-name">{{ file.filename }}</span>
        <button
          class="attach-chip-remove"
          type="button"
          data-testid="attach-remove"
          :aria-label="`移除 ${file.filename}`"
          :disabled="sending"
          @click="removeAttachment(file.id)"
        >
          <Icon name="close" :size="11" />
        </button>
      </span>
      <span v-if="uploadingCount > 0" class="attach-chip uploading" data-testid="attach-uploading">
        <Icon name="clock" :size="12" />
        上传中 {{ uploadingCount }}…
      </span>
    </div>

    <div class="composer" :class="{ disabled: props.disabled }">
      <textarea
        ref="textarea"
        v-model="content"
        data-testid="composer"
        aria-label="消息输入框"
        rows="1"
        :disabled="props.disabled"
        :placeholder="editing ? '编辑消息，Enter 保存 · Esc 取消' : '发消息，@ 提及成员'"
        maxlength="4000"
        @input="onInput"
        @click="detectMention"
        @keydown="onKeydown"
        @compositionstart="composing = true"
        @compositionend="composing = false; detectMention()"
      ></textarea>
      <button
        class="send-btn"
        data-testid="send"
        :disabled="!canSend"
        title="发送"
        @click="submit"
      >
        <Icon name="send" :size="18" />
      </button>
    </div>
    <div class="composer-hint">Enter 发送 · Shift+Enter 换行 · @ 提及</div>
  </div>
</template>

<style scoped>
/* The picker is driven by the toolbar button; the native control only has to
   exist so `.click()` and the change event work. */
.attach-input {
  display: none;
}

/* Recording is a state, not just a glyph: an open microphone tints the tool
   and shows the running clock so it is obvious the room can hear the user. */
.record-tool {
  gap: 4px;
}

.record-tool.recording {
  border-color: var(--rust);
  background: rgba(180, 83, 31, 0.1);
  color: var(--rust);
}

.record-timer {
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  font-variant-numeric: tabular-nums;
}

.attach-tray {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 0 2px 6px;
}

.attach-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 220px;
  padding: 3px 4px 3px 7px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--paper-3);
  color: var(--text);
  font-size: 12px;
  line-height: 1.4;
}

.attach-chip.uploading {
  padding-right: 7px;
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
}

.attach-chip-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.attach-chip-remove {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}

.attach-chip-remove:hover {
  background: rgba(21, 23, 15, 0.1);
  color: var(--rust);
}

.attach-chip-remove:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

/* Tools that can become unavailable (attach, schedule) keep the affordance
   readable instead of looking clickable. */
.composer-tool:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.composer-tool:disabled:hover {
  background: var(--paper);
  color: var(--muted);
}
</style>
