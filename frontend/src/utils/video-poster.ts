/**
 * Grabs the first decoded frame of a same-origin/blob video as a JPEG data URL.
 * A video element without a poster shows a blank rectangle until it decodes;
 * this lets both the message bubble and the media gallery paint a thumbnail
 * immediately after `loadeddata`. Failures (tainted canvas, zero dimensions,
 * unsupported codec) return null and leave the native video untouched.
 */
export function captureVideoPoster(video: HTMLVideoElement): string | null {
  if (!video.videoWidth || !video.videoHeight) {
    return null;
  }
  try {
    const longest = Math.max(video.videoWidth, video.videoHeight);
    const scale = Math.min(1, 480 / longest);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) {
      return null;
    }
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.72);
  } catch {
    return null;
  }
}
