import { describe, expect, it } from 'vitest';
import { normalizedStartupJson } from '../e2e-tests/support/app-data';

const parse = (text: string): unknown => JSON.parse(text);

describe('normalizedStartupJson', () => {
  it('writes the off flag when no record exists', () => {
    expect(parse(normalizedStartupJson(null))).toEqual({ restoreWindowsOnLaunch: false });
  });

  it('turns restore off and keeps the other flags', () => {
    const current = JSON.stringify({ startMinimized: true, restoreWindowsOnLaunch: true });
    expect(parse(normalizedStartupJson(current))).toEqual({
      startMinimized: true,
      restoreWindowsOnLaunch: false,
    });
  });

  it('adds the off flag to an object that lacks it', () => {
    expect(parse(normalizedStartupJson('{"startMinimized":false}'))).toEqual({
      startMinimized: false,
      restoreWindowsOnLaunch: false,
    });
  });

  it.each(['', 'not json', '[]', 'null', '42', '"text"', '{"restoreWindowsOnLaunch":'])(
    'replaces a record the launch would set aside: %j',
    (current) => {
      expect(parse(normalizedStartupJson(current))).toEqual({ restoreWindowsOnLaunch: false });
    },
  );
});
