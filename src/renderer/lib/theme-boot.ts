/**
 * Effective theme at boot, resolved synchronously. The shell CSS keys on
 * [data-theme] (and, under a backdrop, tints the frame by it), so the
 * attribute must be correct on the very first paint. SettingsPanel's
 * applyTheme() stamps it only after an IPC round-trip (setTheme(null) →
 * re-read matchMedia) — frames too late. At window creation tao seeds the
 * window theme from the OS, so matchMedia already reports the OS truth
 * here; a stored explicit theme takes precedence. applyTheme later
 * re-stamps the same value — idempotent.
 */

/** Pure resolver over the raw localStorage payload ("spectra-settings",
 *  same key SettingsPanel owns — duplicated here so this module stays
 *  dependency-free and unit-testable without the Tauri API graph). */
export function resolveInitialTheme(
  storedSettingsJson: string | null,
  prefersLight: boolean,
): 'light' | 'dark' {
  try {
    const parsed: unknown = JSON.parse(storedSettingsJson ?? 'null');
    const theme = (parsed as { theme?: unknown } | null)?.theme;
    if (theme === 'light' || theme === 'dark') return theme;
  } catch {
    // Corrupted settings — treat as System.
  }
  return prefersLight ? 'light' : 'dark';
}

export function stampInitialTheme(): void {
  document.documentElement.setAttribute(
    'data-theme',
    resolveInitialTheme(
      localStorage.getItem('spectra-settings'),
      window.matchMedia('(prefers-color-scheme: light)').matches,
    ),
  );
}
