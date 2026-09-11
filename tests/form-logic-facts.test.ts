import { describe, expect, it, vi } from 'vitest';
import { readFormFields } from '../src/renderer/lib/forms';
import type { EngineCall } from '../src/renderer/lib/engine-call';

describe('authored XFA logic fact boundary', () => {
  it.each([true, false, null])('preserves an explicit fact, including unknown: %s', async value => {
    const call = vi.fn<EngineCall>(async () => ({ fields: [], count: 0, has_xfa: true,
      xfa: 'static', xfa_calculations: value, calculation_order: [] }));
    expect((await readFormFields(call, 'work.pdf', true)).xfaCalculations).toBe(value);
  });
  it.each([undefined, 0, 'false', []])('does not accept a malformed editable reply: %s', async value => {
    const call = vi.fn<EngineCall>(async () => ({ fields: [], count: 0, has_xfa: true,
      xfa: 'static', xfa_calculations: value, calculation_order: [] }));
    await expect(readFormFields(call, 'work.pdf', true)).rejects.toThrow();
  });
});
