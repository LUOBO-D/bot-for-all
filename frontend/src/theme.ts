/* 星夜 is night-only: the app paints exactly one theme. This module pins
   the <html data-theme="dark"> + UA color-scheme before the first render so
   form controls, scrollbars and the theme-color bar match the night canvas
   from the first paint. There is no mode, no storage and no switch — a stale
   `bfa_theme` value in an existing browser simply has no effect anymore. */

const NIGHT = 'dark';
const NIGHT_COLOR = '#0a0e1c';

function paint() {
  const root = document.documentElement;
  root.dataset.theme = NIGHT;
  // Keep native form controls, scrollbars and UA chrome in the same theme.
  root.style.colorScheme = NIGHT;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', NIGHT_COLOR);
}

/** Call once before mounting the app so the first paint is already night. */
export function initTheme() {
  paint();
}
