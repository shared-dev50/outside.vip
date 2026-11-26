export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'outside_theme_preference';
export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'system';

export const THEME_META_COLOR: Record<ResolvedTheme, string> = {
  light: '#FAF8F5',
  dark: '#0D0E12',
};

export const THEME_OPTIONS: ReadonlyArray<{ value: ThemePreference; label: string }> = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
];

export function parseThemePreference(value: unknown): ThemePreference {
  if (value === 'light' || value === 'dark' || value === 'system') {
    return value;
  }
  return DEFAULT_THEME_PREFERENCE;
}

export function getSystemResolvedTheme(): ResolvedTheme {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return 'light';
  }
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function resolveTheme(
  preference: ThemePreference,
  systemTheme: ResolvedTheme = getSystemResolvedTheme()
): ResolvedTheme {
  return preference === 'system' ? systemTheme : preference;
}

export function readStoredThemePreference(): ThemePreference {
  if (typeof window === 'undefined') {
    return DEFAULT_THEME_PREFERENCE;
  }
  try {
    return parseThemePreference(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_THEME_PREFERENCE;
  }
}

export function writeStoredThemePreference(preference: ThemePreference): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, parseThemePreference(preference));
  } catch {
    // Ignore storage quota / privacy mode failures
  }
}

export function applyThemeToDocument(
  resolvedTheme: ResolvedTheme,
  doc: Document | undefined = typeof document !== 'undefined' ? document : undefined
): void {
  if (!doc) return;
  const root = doc.documentElement;
  if (!root) return;

  root.setAttribute?.('data-theme', resolvedTheme);
  if (root.dataset) {
    root.dataset.theme = resolvedTheme;
  }

  if (root.classList) {
    if (resolvedTheme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }

  if (root.style) {
    root.style.colorScheme = resolvedTheme;
  }

  if (typeof doc.querySelector === 'function') {
    const metaThemeColor = doc.querySelector('meta[name="theme-color"]');
    if (metaThemeColor) {
      metaThemeColor.setAttribute('content', THEME_META_COLOR[resolvedTheme]);
    }
  }
}

type LegacyMediaQueryList = MediaQueryList & {
  addListener?: (listener: (event: MediaQueryListEvent) => void) => void;
  removeListener?: (listener: (event: MediaQueryListEvent) => void) => void;
};

export function subscribeToSystemThemeChange(
  onChange: (systemTheme: ResolvedTheme) => void
): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {};
  }

  let mediaQuery: LegacyMediaQueryList | null = null;
  try {
    mediaQuery = window.matchMedia('(prefers-color-scheme: dark)') as LegacyMediaQueryList;
  } catch {
    return () => {};
  }

  if (!mediaQuery) {
    return () => {};
  }

  const handleChange = (event: MediaQueryListEvent | { matches: boolean }) => {
    const matches = typeof event?.matches === 'boolean' ? event.matches : Boolean(mediaQuery?.matches);
    onChange(matches ? 'dark' : 'light');
  };

  if (typeof mediaQuery.addEventListener === 'function') {
    mediaQuery.addEventListener('change', handleChange as EventListener);
    return () => {
      mediaQuery?.removeEventListener?.('change', handleChange as EventListener);
    };
  }

  if (typeof mediaQuery.addListener === 'function') {
    mediaQuery.addListener(handleChange as (event: MediaQueryListEvent) => void);
    return () => {
      mediaQuery?.removeListener?.(handleChange as (event: MediaQueryListEvent) => void);
    };
  }

  return () => {};
}
