export const THEME_STORAGE_KEY = 'census-atlas-theme';
const themes = new Set(['light', 'dark']);
let explicitTheme = null;
let mediaQuery = null;
let initialized = false;

/** Invalid or unavailable preferences safely fall back to the operating system. */
export function resolveTheme(preference, systemDark = false) {
  return themes.has(preference) ? preference : systemDark ? 'dark' : 'light';
}

export function getTheme() {
  return typeof document === 'undefined' ? 'light'
    : resolveTheme(document.documentElement.dataset.theme, mediaQuery?.matches);
}

export const isDarkTheme = () => getTheme() === 'dark';
export const getThemePreference = () => explicitTheme || 'system';

export function refreshThemeControl() {
  if (typeof document === 'undefined') return;
  const select = document.getElementById('theme-preference');
  if (select) select.value = getThemePreference();
}

function applyTheme(theme) {
  const previous = document.documentElement.dataset.theme;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#11232a' : '#fbfcf9');
  refreshThemeControl();
  if (previous !== theme) window.dispatchEvent(new CustomEvent('atlas-themechange', { detail: { theme } }));
}

export function setTheme(theme) {
  if (theme !== 'system' && !themes.has(theme)) return;
  explicitTheme = theme === 'system' ? null : theme;
  try {
    if (explicitTheme) localStorage.setItem(THEME_STORAGE_KEY, explicitTheme);
    else localStorage.removeItem(THEME_STORAGE_KEY);
  } catch { /* Private mode may disable storage. */ }
  applyTheme(resolveTheme(explicitTheme, mediaQuery?.matches));
}

export function initTheme() {
  if (typeof window === 'undefined' || initialized) return;
  initialized = true;
  mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    explicitTheme = themes.has(stored) ? stored : null;
  } catch { explicitTheme = null; }
  applyTheme(resolveTheme(explicitTheme, mediaQuery.matches));
  document.getElementById('theme-preference')?.addEventListener('change', event => setTheme(event.target.value));
  const followSystem = () => { if (!explicitTheme) applyTheme(resolveTheme(null, mediaQuery.matches)); };
  if (mediaQuery.addEventListener) mediaQuery.addEventListener('change', followSystem);
  else mediaQuery.addListener?.(followSystem);
  window.addEventListener('storage', event => {
    if (event.key !== THEME_STORAGE_KEY && event.key !== null) return;
    explicitTheme = themes.has(event.newValue) ? event.newValue : null;
    applyTheme(resolveTheme(explicitTheme, mediaQuery.matches));
  });
}
