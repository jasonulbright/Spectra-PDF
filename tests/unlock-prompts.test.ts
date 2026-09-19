import { describe, expect, it } from 'vitest';
import { createUnlockPrompts, type UnlockPrompt } from '../src/renderer/lib/unlock-prompts';

describe('encrypted open prompts', () => {
  it('settles concurrent password and certificate opens in request order', async () => {
    const shown: (UnlockPrompt | null)[] = [];
    const prompts = createUnlockPrompts(request => shown.push(request));
    const first = prompts.password('first.pdf');
    const second = prompts.certificate('second.pdf');
    const third = prompts.password('third.pdf');
    expect(shown.map(p => p?.fileName)).toEqual(['first.pdf']);
    const firstPrompt = shown[0]!;
    prompts.answer(firstPrompt, { password: 'first secret' });
    await expect(first).resolves.toEqual({ password: 'first secret' });
    // Escape can report cancellation twice; the old answer cannot cancel
    // the next open or resolve it with the previous file's credentials.
    prompts.answer(firstPrompt, 'cancel');
    expect(shown.map(p => p?.fileName)).toEqual(['first.pdf', 'second.pdf']);
    prompts.answer(shown[1]!, { pfx: 'key.pfx', password: 'key secret' });
    await expect(second).resolves.toEqual({ pfx: 'key.pfx', password: 'key secret' });
    prompts.answer(shown[2]!, 'cancel');
    await expect(third).resolves.toBe('cancel');
    expect(shown.at(-1)).toBeNull();
  });

  it('keeps a certificate selection only in that file’s retry', async () => {
    const shown: (UnlockPrompt | null)[] = [];
    const prompts = createUnlockPrompts(p => shown.push(p));
    const first = prompts.certificate('a.pdf');
    const other = prompts.certificate('b.pdf');
    prompts.answer(shown[0]!, { pfx: 'a.pfx', password: 'wrong' });
    const answer = await first;
    expect(answer).not.toBe('cancel');
    const retry = prompts.certificate('a.pdf', 'incorrect password', 'a.pfx');
    expect(shown[1]).not.toHaveProperty('pfx', 'a.pfx');
    prompts.answer(shown[1]!, 'cancel');
    await other;
    expect(shown[2]).toMatchObject({ fileName: 'a.pdf', pfx: 'a.pfx', error: 'incorrect password' });
    expect(shown[2]).not.toHaveProperty('password');
    prompts.answer(shown[2]!, 'cancel');
    await retry;
  });
});
