import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from 'react';
import {
  ResolvedTheme,
  THEME_STORAGE_KEY,
  ThemePreference,
  applyThemeToDocument,
  getSystemResolvedTheme,
  parseThemePreference,
  readStoredThemePreference,
  resolveTheme,
  subscribeToSystemThemeChange,
  writeStoredThemePreference,
} from '../lib/theme';

export interface ThemeContextType {
  preference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  setTheme: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

const useIsomorphicLayoutEffect =
  typeof window !== 'undefined' && typeof document !== 'undefined' ? useLayoutEffect : useEffect;

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [preference, setPreference] = useState<ThemePreference>(() => readStoredThemePreference());
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(() => getSystemResolvedTheme());

  const resolvedTheme = useMemo(
    () => resolveTheme(preference, systemTheme),
    [preference, systemTheme]
  );

  const setTheme = useCallback((nextPreference: ThemePreference) => {
    const normalized = parseThemePreference(nextPreference);
    setPreference(normalized);
    writeStoredThemePreference(normalized);
    if (normalized === 'system') {
      setSystemTheme(getSystemResolvedTheme());
    }
  }, []);

  useIsomorphicLayoutEffect(() => {
    applyThemeToDocument(resolvedTheme);
  }, [resolvedTheme]);

  useEffect(() => {
    if (preference !== 'system') {
      return undefined;
    }

    setSystemTheme(getSystemResolvedTheme());
    return subscribeToSystemThemeChange((nextSystemTheme) => {
      setSystemTheme(nextSystemTheme);
    });
  }, [preference]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
      return undefined;
    }

    const handleStorage = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY) return;
      const next = parseThemePreference(event.newValue);
      setPreference(next);
      if (next === 'system') {
        setSystemTheme(getSystemResolvedTheme());
      }
    };

    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener('storage', handleStorage);
    };
  }, []);

  const value = useMemo<ThemeContextType>(
    () => ({
      preference,
      resolvedTheme,
      setTheme,
    }),
    [preference, resolvedTheme, setTheme]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};

export const useTheme = (): ThemeContextType => {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
};

export const useOptionalTheme = (): ThemeContextType | null => {
  return useContext(ThemeContext) ?? null;
};
