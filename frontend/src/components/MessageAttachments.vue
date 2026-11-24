<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import http, { errorMessage } from '../api/http';
import type { Attachment } from '../types';
import { captureVideoPoster } from '../utils/video-poster';
import Icon from './Icon.vue';

const props = defineProps<{
  roomId: number;
  attachments: Attachment[];
}>();

interface LoadedBlob {
  url: string;
  blob: Blob;
}

// Images, voice notes and videos are prefetched: the download route needs the
// bearer token, so a plain `<img src>` / `<audio src>` / `<video src>` (or
// `href`) would come back 401 and the bubble would show a broken control.
// Everything else stays a filename row until asked.
const images = computed(() =>
  props.attachments.filter((file) => file.mime.startsWith('image/')),
);
const audios = computed(() =>
  props.attachments.filter((file) => file.mime.startsWith('audio/')),
);
const videos = computed(() =>
  props.attachments.filter((file) => file.mime.startsWith('video/')),
);
const files = computed(() =>
  props.attachments.filter(
    (file) =>
      !file.mime.startsWith('image/') &&
      !file.mime.startsWith('audio/') &&
      !file.mime.startsWith('video/'),
  ),
);

// Object URLs live for as long as the attachment is on screen. They are
// created after the blob response lands, revoked when the row leaves the
// message (edit/refresh), when the media element fails to decode, and, as a
// backstop, when the component unmounts.
const loaded = reactive(new Map<number, LoadedBlob>());
const videoPosters = reactive(new Map<number, string>());
const loading = ref<number[]>([]);
const failed = ref<number[]>([]);
let disposed = false;

function endpoint(file: Attachment): string {
  // Built from the route rather than `file.url`: the axios instance already
  // owns the `/api` prefix, and a combined path would duplicate it.
  return `/rooms/${props.roomId}/attachments/${file.id}`;
}

function isImage(file: Attachment): boolean {
  return file.mime.startsWith('image/');
}

function isAudio(file: Attachment): boolean {
  return file.mime.startsWith('audio/');
}

function isVideo(file: Attachment): boolean {
  return file.mime.startsWith('video/');
}

async function fetchBlob(file: Attachment): Promise<Blob> {
  const { data } = await http.get<Blob>(endpoint(file), { responseType: 'blob' });
  return data;
}

async function loadBlob(file: Attachment) {
  if (disposed || loaded.has(file.id) || loading.value.includes(file.id)) {
    return;
  }
  loading.value = [...loading.value, file.id];
  try {
    const blob = await fetchBlob(file);
    // The row may have been removed while the request was in flight; the URL
    // would then have no owner to revoke it.
    if (disposed) {
      return;
    }
    loaded.set(file.id, { url: URL.createObjectURL(blob), blob });
    failed.value = failed.value.filter((id) => id !== file.id);
  } catch {
    if (!disposed) {
      failed.value = [...failed.value.filter((id) => id !== file.id), file.id];
    }
  } finally {
    loading.value = loading.value.filter((id) => id !== file.id);
  }
}

function release(id: number) {
  const image = loaded.get(id);
  if (image) {
    URL.revokeObjectURL(image.url);
    loaded.delete(id);
  }
}

function markBroken(id: number) {
  // Fetched fine but the browser cannot decode it (corrupt/unsupported):
  // drop the URL and fall back to the filename row instead of a broken icon.
  release(id);
  if (!failed.value.includes(id)) {
    failed.value = [...failed.value, id];
  }
}

function capturePoster(file: Attachment, event: Event) {
  if (videoPosters.has(file.id)) {
    return;
  }
  const video = event.target;
  if (!(video instanceof HTMLVideoElement)) {
    return;
  }
  const poster = captureVideoPoster(video);
  if (poster) {
    videoPosters.set(file.id, poster);
  }
}

// The viewer state must exist before the immediate watcher below runs, since
// that first pass may already decide a removed attachment closes the viewer.
const lightbox = ref<Attachment | null>(null);
const lightboxCloseButton = ref<HTMLButtonElement | null>(null);
const lightboxZoomed = ref(false);
let lightboxSwipe: { x: number; y: number } | null = null;
let lightboxTrigger: HTMLElement | null = null;
let bodyOverflow: string | null = null;
const lightboxUrl = computed(() =>
  lightbox.value ? loaded.get(lightbox.value.id)?.url : undefined,
);
const lightboxIndex = computed(() =>
  lightbox.value ? images.value.findIndex((file) => file.id === lightbox.value?.id) : -1,
);
const canStepLightbox = computed(() => images.value.length > 1);

// A message update swaps in a fresh array; ids that disappeared must drop
// their object URLs, new media starts loading. Keying on the id list keeps
// this cheap and avoids reloading blobs on every unrelated message change.
watch(
  () => props.attachments.map((file) => file.id).join(','),
  () => {
    const ids = new Set(props.attachments.map((file) => file.id));
    for (const id of [...loaded.keys()]) {
      if (!ids.has(id)) {
        release(id);
      }
    }
    for (const id of [...videoPosters.keys()]) {
      if (!ids.has(id)) {
        videoPosters.delete(id);
      }
    }
    failed.value = failed.value.filter((id) => ids.has(id));
    if (lightbox.value && !ids.has(lightbox.value.id)) {
      closeLightbox(false);
    }
    for (const file of props.attachments) {
      if (isImage(file) || isAudio(file) || isVideo(file)) {
        void loadBlob(file);
      }
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  disposed = true;
  closeLightbox(false);
  for (const id of [...loaded.keys()]) {
    release(id);
  }
  videoPosters.clear();
});

// The viewer is shared by every image in the message. The trigger element is
// captured so Escape or a backdrop click can hand focus back to it, and the
// body scroll lock is restored exactly once. Closing never revokes the blob:
// that URL belongs to the loaded map and lives as long as the attachment row.
function lockBodyScroll() {
  if (bodyOverflow !== null) {
    return;
  }
  bodyOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
}

function unlockBodyScroll() {
  if (bodyOverflow === null) {
    return;
  }
  document.body.style.overflow = bodyOverflow;
  bodyOverflow = null;
}

function openLightbox(file: Attachment, event: MouseEvent) {
  const trigger = event.currentTarget;
  if (!(trigger instanceof HTMLElement) || !loaded.has(file.id)) {
    return;
  }
  lightboxTrigger = trigger;
  lightbox.value = file;
  lightboxZoomed.value = false;
  lightboxSwipe = null;
  lockBodyScroll();
  // Capture phase: Escape closes the viewer before the page-level chat
  // shortcuts (selection mode, composer cancel) can act on the same key.
  window.addEventListener('keydown', onLightboxKeydown, true);
  void nextTick(() => lightboxCloseButton.value?.focus());
}

function closeLightbox(focusTrigger = true) {
  if (!lightbox.value) {
    return;
  }
  lightbox.value = null;
  lightboxZoomed.value = false;
  lightboxSwipe = null;
  window.removeEventListener('keydown', onLightboxKeydown, true);
  unlockBodyScroll();
  const trigger = lightboxTrigger;
  lightboxTrigger = null;
  if (focusTrigger && trigger?.isConnected) {
    trigger.focus();
  }
}

function stepLightbox(delta: number) {
  if (!canStepLightbox.value) {
    return;
  }
  const index = lightboxIndex.value;
  if (index < 0) {
    return;
  }
  const next = images.value[(index + delta + images.value.length) % images.value.length];
  if (!loaded.has(next.id)) {
    return;
  }
  lightbox.value = next;
  lightboxZoomed.value = false;
}

function onLightboxPointerDown(event: PointerEvent) {
  // Buttons keep their click; zoomed images scroll instead of stepping.
  if (event.button !== 0 || lightboxZoomed.value) {
    return;
  }
  if (event.target instanceof HTMLElement && event.target.closest('button')) {
    return;
  }
  lightboxSwipe = { x: event.clientX, y: event.clientY };
  if (event.currentTarget instanceof HTMLElement) {
    event.currentTarget.setPointerCapture(event.pointerId);
  }
}

function onLightboxPointerUp(event: PointerEvent) {
  const start = lightboxSwipe;
  lightboxSwipe = null;
  if (!start) {
    return;
  }
  const dx = event.clientX - start.x;
  const dy = event.clientY - start.y;
  if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy) * 1.4) {
    return;
  }
  stepLightbox(dx < 0 ? 1 : -1);
}

function onLightboxDoubleClick(event: MouseEvent) {
  if (event.target instanceof HTMLElement && event.target.closest('button')) {
    return;
  }
  lightboxZoomed.value = !lightboxZoomed.value;
}

function onLightboxKeydown(event: KeyboardEvent) {
  if (event.ctrlKey || event.metaKey || event.altKey) {
    return;
  }
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault();
    event.stopPropagation();
    stepLightbox(event.key === 'ArrowLeft' ? -1 : 1);
    return;
  }
  if (event.key === '+' || event.key === '=') {
    event.preventDefault();
    event.stopPropagation();
    lightboxZoomed.value = true;
    return;
  }
  if (event.key === '-' || event.key === '0') {
    event.preventDefault();
    event.stopPropagation();
    lightboxZoomed.value = false;
    return;
  }
  if (event.key !== 'Escape') {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  closeLightbox();
}

function saveLightbox() {
  if (lightbox.value) {
    void save(lightbox.value);
  }
}

async function save(file: Attachment) {
  try {
    // Reuse the already-downloaded blob when the image is on screen; the
    // transient URL for the anchor click is revoked on the next macrotask so
    // the browser has time to start the save.
    const cached = loaded.get(file.id);
    const blob = cached ? cached.blob : await fetchBlob(file);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = file.filename || `attachment-${file.id}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    ElMessage.error(errorMessage(error));
  }
}

function formatSize(size: number): string {
  if (!Number.isFinite(size) || size <= 0) {
    return '';
  }
  if (size < 1024) {
    return `${size} B`;
  }
  const units = ['KB', 'MB', 'GB'];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
</script>

<template>
  <div v-if="attachments.length > 0" class="msg-attachments">
    <figure v-for="file in images" :key="file.id" class="attachment-image-card">
      <button
        v-if="loaded.get(file.id)"
        class="attachment-image-button"
        type="button"
        data-testid="attachment-image-open"
        :aria-label="`查看大图 ${file.filename}`"
        @click.stop="openLightbox(file, $event)"
      >
        <img
          :src="loaded.get(file.id)?.url"
          :alt="file.filename"
          class="attachment-image"
          data-testid="attachment-image"
          loading="lazy"
          @error="markBroken(file.id)"
        />
      </button>
      <div
        v-else
        class="attachment-image-state"
        :class="{ failed: failed.includes(file.id) }"
      >
        <Icon name="copy" :size="14" />
        <span>{{ failed.includes(file.id) ? '图片加载失败' : '图片加载中…' }}</span>
      </div>
      <figcaption class="attachment-caption">
        <span class="attachment-name" :title="file.filename">{{ file.filename }}</span>
        <span class="attachment-size">{{ formatSize(file.size) }}</span>
        <button
          class="attachment-download-icon"
          type="button"
          title="下载"
          :aria-label="`下载 ${file.filename}`"
          @click.stop="save(file)"
        >
          <Icon name="arrowDown" :size="14" />
        </button>
      </figcaption>
    </figure>

    <figure
      v-for="file in audios"
      :key="file.id"
      class="attachment-audio-card"
      data-testid="attachment-audio-card"
    >
      <audio
        v-if="loaded.get(file.id)"
        :src="loaded.get(file.id)?.url"
        class="attachment-audio"
        controls
        preload="metadata"
        data-testid="attachment-audio"
        @error="markBroken(file.id)"
      ></audio>
      <div
        v-else
        class="attachment-image-state"
        :class="{ failed: failed.includes(file.id) }"
      >
        <Icon name="copy" :size="14" />
        <span>{{ failed.includes(file.id) ? '音频加载失败' : '音频加载中…' }}</span>
      </div>
      <figcaption class="attachment-caption">
        <span class="attachment-name" :title="file.filename">{{ file.filename }}</span>
        <span class="attachment-size">{{ formatSize(file.size) }}</span>
        <button
          class="attachment-download-icon"
          type="button"
          title="下载"
          :aria-label="`下载 ${file.filename}`"
          @click.stop="save(file)"
        >
          <Icon name="arrowDown" :size="14" />
        </button>
      </figcaption>
    </figure>

    <figure
      v-for="file in videos"
      :key="file.id"
      class="attachment-video-card"
      data-testid="attachment-video-card"
    >
      <video
        v-if="loaded.get(file.id)"
        :src="loaded.get(file.id)?.url"
        :poster="videoPosters.get(file.id)"
        class="attachment-video"
        controls
        preload="metadata"
        data-testid="attachment-video"
        @loadeddata="capturePoster(file, $event)"
        @error="markBroken(file.id)"
      ></video>
      <div
        v-else
        class="attachment-image-state"
        :class="{ failed: failed.includes(file.id) }"
      >
        <Icon name="copy" :size="14" />
        <span>{{ failed.includes(file.id) ? '视频加载失败' : '视频加载中…' }}</span>
      </div>
      <figcaption class="attachment-caption">
        <span class="attachment-name" :title="file.filename">{{ file.filename }}</span>
        <span class="attachment-size">{{ formatSize(file.size) }}</span>
        <button
          class="attachment-download-icon"
          type="button"
          title="下载"
          :aria-label="`下载 ${file.filename}`"
          @click.stop="save(file)"
        >
          <Icon name="arrowDown" :size="14" />
        </button>
      </figcaption>
    </figure>

    <div
      v-for="file in files"
      :key="file.id"
      class="attachment-file"
      data-testid="attachment-file"
    >
      <span class="attachment-file-icon"><Icon name="copy" :size="16" /></span>
      <span class="attachment-file-copy">
        <span class="attachment-name" :title="file.filename">{{ file.filename }}</span>
        <span class="attachment-size">
          {{ formatSize(file.size) || file.mime || '文件' }}
        </span>
      </span>
      <button
        class="attachment-download"
        type="button"
        data-testid="attachment-download"
        :aria-label="`下载 ${file.filename}`"
        @click.stop="save(file)"
      >
        <Icon name="arrowDown" :size="14" />
        <span>下载</span>
      </button>
    </div>

    <Teleport to="body">
      <div
        v-if="lightbox"
        class="image-lightbox"
        data-testid="image-lightbox"
        @click.self="closeLightbox()"
      >
        <div
          class="lightbox-panel"
          role="dialog"
          aria-modal="true"
          :aria-label="`查看图片 ${lightbox.filename}`"
          :data-zoomed="lightboxZoomed ? 'true' : 'false'"
          data-testid="lightbox-panel"
        >
          <div class="lightbox-head">
            <span
              class="lightbox-name"
              :title="lightbox.filename"
              aria-live="polite"
              data-testid="lightbox-name"
            >
              {{ lightbox.filename }}
            </span>
            <span v-if="formatSize(lightbox.size)" class="lightbox-size">
              {{ formatSize(lightbox.size) }}
            </span>
            <button
              class="lightbox-action"
              type="button"
              data-testid="lightbox-zoom"
              :aria-label="lightboxZoomed ? '还原图片' : '放大图片'"
              :aria-pressed="lightboxZoomed"
              @click="lightboxZoomed = !lightboxZoomed"
            >
              {{ lightboxZoomed ? '1×' : '2×' }}
            </button>
            <button
              class="lightbox-action"
              type="button"
              data-testid="lightbox-download"
              :aria-label="`下载 ${lightbox.filename}`"
              @click="saveLightbox"
            >
              <Icon name="arrowDown" :size="14" />
              <span>下载</span>
            </button>
            <button
              ref="lightboxCloseButton"
              class="lightbox-action lightbox-close"
              type="button"
              data-testid="lightbox-close"
              aria-label="关闭"
              @click="closeLightbox()"
            >
              <Icon name="close" :size="16" />
            </button>
          </div>
          <div class="lightbox-body">
            <button
              v-if="canStepLightbox"
              class="lightbox-nav lightbox-prev"
              type="button"
              data-testid="lightbox-prev"
              aria-label="上一张"
              @click="stepLightbox(-1)"
            >
              ‹
            </button>
            <div
              class="lightbox-stage"
              data-testid="lightbox-stage"
              @pointerdown="onLightboxPointerDown"
              @pointerup="onLightboxPointerUp"
              @pointercancel="lightboxSwipe = null"
              @dblclick="onLightboxDoubleClick"
            >
              <img
                v-if="lightboxUrl"
                :src="lightboxUrl"
                :alt="lightbox.filename"
                class="lightbox-image"
                :class="{ 'is-zoomed': lightboxZoomed }"
                data-testid="lightbox-image"
                draggable="false"
                title="双击放大或还原"
                @dragstart.prevent
              />
            </div>
            <button
              v-if="canStepLightbox"
              class="lightbox-nav lightbox-next"
              type="button"
              data-testid="lightbox-next"
              aria-label="下一张"
              @click="stepLightbox(1)"
            >
              ›
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.msg-attachments {
  display: flex;
  flex-direction: column;
  gap: 6px;
  box-sizing: border-box;
  max-width: 320px;
  margin-top: 7px;
}

/* Images read as a quiet well, the same surface as a link preview. */
.attachment-image-card {
  display: flex;
  flex-direction: column;
  margin: 0;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--paper-3);
}

.attachment-image {
  display: block;
  width: 100%;
  max-height: 280px;
  object-fit: contain;
  background: var(--paper);
}

/* The thumbnail is the trigger; strip the button chrome so the well still
   reads as an image, but keep a visible focus ring for keyboard users. */
.attachment-image-button {
  display: block;
  width: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: zoom-in;
}

.attachment-image-button:focus-visible {
  outline: 2px solid var(--rust);
  outline-offset: -2px;
}

.attachment-image-state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 88px;
  padding: 10px;
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
}

/* Voice notes sit in the same well as images: the native control needs the
   whole row, and the caption below carries the filename and download. */
.attachment-audio-card {
  display: flex;
  flex-direction: column;
  margin: 0;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--paper-3);
}

.attachment-audio {
  display: block;
  width: 100%;
  height: 40px;
  background: var(--paper);
}

.attachment-video-card {
  display: flex;
  flex-direction: column;
  margin: 0;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--paper-3);
}

.attachment-video {
  display: block;
  width: 100%;
  max-height: 280px;
  background: var(--paper);
}

.attachment-image-state.failed {
  color: var(--rust);
}

.attachment-caption {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  border-top: 1px solid var(--line);
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
}

.attachment-file {
  display: flex;
  align-items: center;
  gap: 8px;
  box-sizing: border-box;
  padding: 7px 9px;
  border: 1px solid var(--line);
  border-left: 2px solid var(--rust);
  border-radius: 0 var(--r-sm) var(--r-sm) 0;
  background: var(--paper-3);
}

.attachment-file-icon {
  display: flex;
  flex: none;
  color: var(--rust);
}

.attachment-file-copy {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}

.attachment-name {
  overflow: hidden;
  color: var(--text);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.attachment-size {
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
}

/* The caption is a row, so the name yields space instead of pushing the
   download button out of the bubble. */
.attachment-caption .attachment-name {
  flex: 1;
  min-width: 0;
}

.attachment-caption .attachment-size {
  flex: none;
}

.attachment-download-icon,
.attachment-download {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: none;
  padding: 3px 6px;
  border: 1px solid transparent;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  cursor: pointer;
}

.attachment-download-icon {
  margin-left: auto;
  padding: 2px;
}

.attachment-download:hover,
.attachment-download-icon:hover {
  border-color: var(--line);
  color: var(--rust);
}

.attachment-download:focus-visible,
.attachment-download-icon:focus-visible {
  outline: 2px solid var(--rust);
  outline-offset: 1px;
}

/* Gold self bubbles: the paper well would glare, so tint the ink instead. */
.msg.self .attachment-file {
  border-color: rgba(22, 28, 54, 0.28);
  border-left-color: var(--ink-2);
  background: rgba(22, 28, 54, 0.08);
}

.msg.self .attachment-image-card {
  border-color: rgba(22, 28, 54, 0.28);
  background: rgba(22, 28, 54, 0.08);
}

.msg.self .attachment-audio-card {
  border-color: rgba(22, 28, 54, 0.28);
  background: rgba(22, 28, 54, 0.08);
}

.msg.self .attachment-video-card {
  border-color: rgba(22, 28, 54, 0.28);
  background: rgba(22, 28, 54, 0.08);
}

.msg.self .attachment-audio,
.msg.self .attachment-video {
  background: transparent;
}

.msg.self .attachment-name {
  color: var(--ink);
}

.msg.self .attachment-size,
.msg.self .attachment-download,
.msg.self .attachment-download-icon,
.msg.self .attachment-caption {
  color: var(--ink-2);
}

/* Teleported to body, so this surface is deliberately theme-independent:
   a dark stage keeps the image the only bright thing on screen. */
.image-lightbox {
  position: fixed;
  inset: 0;
  z-index: 2000;
  display: flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  padding: 24px;
  background: rgba(12, 13, 9, 0.88);
}

.lightbox-panel {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  max-width: min(1200px, 100%);
  max-height: 100%;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: var(--r-md);
  background: rgba(4, 6, 18, 0.96);
}

.lightbox-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px 6px 12px;
  color: rgba(255, 255, 255, 0.72);
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
}

.lightbox-name {
  overflow: hidden;
  flex: 1;
  min-width: 0;
  color: #f4f2ea;
  font-family: var(--font-body);
  font-size: 13px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lightbox-size {
  flex: none;
}

.lightbox-action {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: none;
  padding: 4px 7px;
  border: 1px solid transparent;
  border-radius: var(--r-sm);
  background: transparent;
  color: rgba(255, 255, 255, 0.72);
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  cursor: pointer;
}

.lightbox-action:hover {
  border-color: rgba(255, 255, 255, 0.24);
  color: #f4f2ea;
}

.lightbox-action:focus-visible {
  outline: 2px solid var(--rust);
  outline-offset: 1px;
}

.lightbox-close {
  padding: 4px;
}

.lightbox-body {
  position: relative;
  display: flex;
  align-items: center;
  min-height: 0;
  max-height: calc(100vh - 130px);
}

.lightbox-stage {
  display: flex;
  align-items: flex-start;
  justify-content: center;
  width: 100%;
  min-height: 0;
  overflow: auto;
  background: #0c0d09;
  touch-action: pan-y;
}

.lightbox-nav {
  position: absolute;
  top: 50%;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 48px;
  padding: 0;
  transform: translateY(-50%);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: var(--r-sm);
  background: rgba(12, 13, 9, 0.62);
  color: #f4f2ea;
  font-family: var(--font-body);
  font-size: 30px;
  line-height: 1;
  cursor: pointer;
}

.lightbox-prev {
  left: 8px;
}

.lightbox-next {
  right: 8px;
}

.lightbox-nav:hover,
.lightbox-nav:focus-visible {
  background: rgba(12, 13, 9, 0.88);
  border-color: rgba(255, 255, 255, 0.5);
}

.lightbox-image {
  display: block;
  max-width: 100%;
  max-height: calc(100vh - 130px);
  object-fit: contain;
  background: #0c0d09;
}

.lightbox-image.is-zoomed {
  width: 200%;
  max-width: none;
  max-height: none;
}
</style>
