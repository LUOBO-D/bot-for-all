import { ref } from 'vue';

export type ThemeMode = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'bfa_theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

/* Address-bar tint per resolved theme (optional, purely cosmetic). */
const THEME_COLOR: Record<ResolvedTheme, string> = {
  light: '#f6f4ec',
  dark: '#15170f',
};

function readStoredMode(): ThemeMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  } catch {
    /* private mode / storage disabled — fall through to system */
  }
  return 'system';
}

function darkMedia(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  return window.matchMedia(DARK_QUERY);
}

function resolve(mode: ThemeMode): ResolvedTheme {
  if (mode !== 'system') return mode;
  return darkMedia()?.matches ? 'dark' : 'light';
}

/** Current preference (persisted in `localStorage.bfa_theme`). */
export const themeMode = ref<ThemeMode>(readStoredMode());

/** The concrete theme currently painted on `<html data-theme>`. */
export const resolvedTheme = ref<ResolvedTheme>(resolve(themeMode.value));

function apply(mode: ThemeMode) {
  const theme = resolve(mode);
  resolvedTheme.value = theme;

  const root = document.documentElement;
  root.dataset.theme = theme;
  // Keep native form controls, scrollbars and UA chrome in the same theme.
  root.style.colorScheme = theme;

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLOR[theme]);
}

/** Persist the preference, paint it and (for `system`) follow the OS live. */
export function setTheme(mode: ThemeMode) {
  themeMode.value = mode;
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* storage unavailable: the in-memory choice still applies for this tab */
  }
  apply(mode);
}

let initialized = false;

/** Call once before mounting the app so the first paint is already correct. */
export function initTheme() {
  if (initialized) return;
  initialized = true;

  themeMode.value = readStoredMode();
  apply(themeMode.value);

  // One listener for the lifetime of the page: it only reacts while the
  // preference is `system`, so switching to light/dark needs no re-wiring.
  const media = darkMedia();
  if (media) {
    const onChange = () => {
      if (themeMode.value === 'system') apply('system');
    };
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', onChange);
    } else if (typeof media.addListener === 'function') {
      media.addListener(onChange);
    }
  }
}
