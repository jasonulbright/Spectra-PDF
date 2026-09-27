import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/renderer/App.tsx'), 'utf8');

describe('tray Quit', () => {
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
      'app.requestQuit()',
      'app.confirmClose()',
    ];
    let prior = -1;
    for (const step of requiredSteps) {
      const position = exit.indexOf(step);
      expect(position, `missing ${step}`).toBeGreaterThan(prior);
      prior = position;
    }
  });
});
