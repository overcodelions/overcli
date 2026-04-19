import { useEffect } from 'react';
import { useStore } from './store';

/// Toggles `html.dark` to match the user's theme preference. 'system'
/// follows `prefers-color-scheme` and listens for OS-level theme
/// changes so the app responds without a reload.
export function useThemeEffect(): void {
  const theme = useStore((s) => s.settings.theme);

  useEffect(() => {
    const root = document.documentElement;
    const mql = window.matchMedia('(prefers-color-scheme: dark)');

    const apply = () => {
      let dark: boolean;
      if (theme === 'dark') dark = true;
      else if (theme === 'light') dark = false;
      else dark = mql.matches;
      root.classList.toggle('dark', dark);
    };

    apply();

    if (theme === 'system') {
      const handler = () => apply();
      mql.addEventListener('change', handler);
      return () => mql.removeEventListener('change', handler);
    }
  }, [theme]);
}
