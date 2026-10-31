const palettes = ['av-0', 'av-1', 'av-2', 'av-3', 'av-4', 'av-5'];

export function avatarClass(id: number): string {
  return palettes[Math.abs(id) % palettes.length];
}

export function initialOf(name: string): string {
  const trimmed = name.trim();
  return trimmed ? trimmed.slice(0, 1).toUpperCase() : '?';
}

export function formatDate(value: string): string {
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) {
    return '今天';
  }
  if (date.toDateString() === yesterday.toDateString()) {
    return '昨天';
  }
  return date.toLocaleDateString();
}

export function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function formatRelative(value: string): string {
  const date = new Date(value);
  const diff = Date.now() - date.getTime();
  if (diff < 60_000) {
    return '刚刚';
  }
  if (diff < 3_600_000) {
    return `${Math.floor(diff / 60_000)} 分钟前`;
  }
  if (date.toDateString() === new Date().toDateString()) {
    return formatTime(value);
  }
  return date.toLocaleDateString();
}

export function plainPreview(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, '[代码]')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '[图片]')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`>#~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
