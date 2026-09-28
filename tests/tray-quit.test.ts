import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { shouldMinimizeToTrayOnClose } from '../src/renderer/lib/close-sequence';

const source = readFileSync(resolve(process.cwd(), 'src/renderer/App.tsx'), 'utf8');

describe('tray Quit', () => {
  it('only applies the tray preference to a plain window close', () => {
    expect(shouldMinimizeToTrayOnClose(null, true)).toBe(true);
    expect(shouldMinimizeToTrayOnClose(17, true)).toBe(false);
    expect(shouldMinimizeToTrayOnClose(null, false)).toBe(false);

    const closeStart = source.indexOf('const unlisten = app.onBeforeClose(');
    const closeEnd = source.indexOf('// Leaving doc-tab-land', closeStart);
    expect(closeStart).toBeGreaterThanOrEqual(0);
    expect(closeEnd).toBeGreaterThan(closeStart);
    expect(source.slice(closeStart, closeEnd)).toMatch(
      /shouldMinimizeToTrayOnClose\(\s*sessionId,\s*getSettings\(\)\.minimizeToTray === true,\s*\)/,
    );
  });

  it('uses the same unsaved-work and acknowledged close flow as File Exit', () => {
    const listenerStart = source.indexOf('const unlisten = app.onTrayAction(');
    const listenerEnd = source.indexOf('// Handle files opened via file association', listenerStart);
    expect(listenerStart).toBeGreaterThanOrEqual(0);
    expect(listenerEnd).toBeGreaterThan(listenerStart);
    const listener = source.slice(listenerStart, listenerEnd);
    expect(listener).toContain("action === 'quit'");
    expect(listener).toMatch(/handleExit\(\)/);

    const exitStart = source.indexOf('const handleExit = useCallback(async () => {');
    const exitEnd = source.indexOf('// Hand a document to another window.', exitStart);
    expect(exitStart).toBeGreaterThanOrEqual(0);
    expect(exitEnd).toBeGreaterThan(exitStart);
    const exit = source.slice(exitStart, exitEnd);
    const requiredSteps = [
      'confirmCurrentDirtyFiles(',
      'flushTabOrder()',
      'finishCoordinatedExit(',
      'app.requestQuit()',
      'app.confirmClose()',
    ];
    let prior = -1;
    for (const step of requiredSteps) {
      const position = exit.indexOf(step);
      expect(position, `missing ${step}`).toBeGreaterThan(prior);
      prior = position;
    }
    const coordinated = exit.slice(exit.indexOf('finishCoordinatedExit('));
    const completionSteps = [
      'app.requestQuit()',
      'confirmCurrentDirtyFiles(',
      'alreadyAnswered',
      'app.quitCancelled(sessionId)',
      'app.confirmClose()',
    ];
    prior = -1;
    for (const step of completionSteps) {
      const position = coordinated.indexOf(step);
      expect(position, `missing ${step} in coordinated completion`).toBeGreaterThan(prior);
      prior = position;
    }
  });
});
