// Boot theme resolution (3b review round 1): the shell CSS keys on
// [data-theme], and under the default System theme SettingsPanel stamps it
// only after an IPC round-trip — frames after the first paint. index.tsx
// now stamps synchronously via this resolver; these tests lock its logic.
import { describe, expect, it } from 'vitest';
import { resolveInitialTheme } from '../src/renderer/lib/theme-boot';

describe('resolveInitialTheme', () => {
  it('follows the OS preference under the default System theme', () => {
    expect(resolveInitialTheme(null, true)).toBe('light');
    expect(resolveInitialTheme(null, false)).toBe('dark');
    expect(resolveInitialTheme(JSON.stringify({ theme: 'system' }), true)).toBe('light');
    expect(resolveInitialTheme(JSON.stringify({ theme: 'system' }), false)).toBe('dark');
  });

  it('honors a stored explicit theme over the OS preference', () => {
    expect(resolveInitialTheme(JSON.stringify({ theme: 'light' }), false)).toBe('light');
    expect(resolveInitialTheme(JSON.stringify({ theme: 'dark' }), true)).toBe('dark');
  });

  it('treats corrupted or unexpected settings as System', () => {
    expect(resolveInitialTheme('{not json', true)).toBe('light');
    expect(resolveInitialTheme('{not json', false)).toBe('dark');
    expect(resolveInitialTheme(JSON.stringify({ theme: 42 }), true)).toBe('light');
    expect(resolveInitialTheme(JSON.stringify('a string'), false)).toBe('dark');
    expect(resolveInitialTheme(JSON.stringify(null), true)).toBe('light');
  });
});

describe('N14 — high-contrast is a stored explicit theme', () => {
  it('stamps high-contrast before first render like the other explicit themes', () => {
    expect(
      resolveInitialTheme(JSON.stringify({ theme: 'high-contrast' }), false),
    ).toBe('high-contrast');
    expect(
      resolveInitialTheme(JSON.stringify({ theme: 'high-contrast' }), true),
    ).toBe('high-contrast');
  });

  it('unknown theme values still fall back to the system preference', () => {
    expect(resolveInitialTheme(JSON.stringify({ theme: 'sepia' }), true)).toBe('light');
  });
});
