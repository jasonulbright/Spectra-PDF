import { describe, expect, it, vi } from 'vitest';
import { withPromptTurn } from '../src/renderer/lib/prompt-turn';

describe('withPromptTurn', () => {
  it('takes the turn before the prompt and returns it after the answer', async () => {
    const order: string[] = [];
    const bridge = {
      begin: vi.fn(async () => { order.push('begin'); return 7; }),
      end: vi.fn(async (t: number) => { order.push(`end:${t}`); }),
    };
    const answer = await withPromptTurn(bridge, async () => { order.push('prompt'); return 'cancel'; });
    expect(answer).toBe('cancel');
    expect(order).toEqual(['begin', 'prompt', 'end:7']);
  });

  it('returns the turn when the prompt throws', async () => {
    const end = vi.fn(async () => undefined);
    await expect(withPromptTurn({ begin: async () => 3, end }, async () => { throw new Error('x'); }))
      .rejects.toThrow('x');
    expect(end).toHaveBeenCalledWith(3);
  });

  it('releases nothing for a visible window', async () => {
    const end = vi.fn(async () => undefined);
    await withPromptTurn({ begin: async () => null, end }, async () => 1);
    expect(end).not.toHaveBeenCalled();
  });

  it('still prompts when the turn cannot be taken', async () => {
    const prompt = vi.fn(async () => 'save');
    const answer = await withPromptTurn(
      { begin: async () => { throw new Error('ipc'); }, end: async () => undefined },
      prompt,
    );
    expect(answer).toBe('save');
  });
});
