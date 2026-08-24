// The renderer's ONE colour-profile answer (lib/icc-assent), and the two
// decisions every dependent surface takes from it.
//
// The bundled profiles ship under a bundling agreement whose end-user licence
// has to be presented and accepted. The installer obtains that and records it;
// a portable copy has no installer, so the application presents the same text
// on first run. What is tested here is the renderer half: which container asks,
// which state opens the dialog, which state disables a surface, and that a
// pending read is neither of those.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/renderer/lib/tauri-bridge', () => ({
  app: { iccAssentState: vi.fn(), iccLicenseText: vi.fn(), recordIccAssent: vi.fn() },
}));

import { app } from '../src/renderer/lib/tauri-bridge';
import {
  ICC_ACCEPTED,
  ICC_DECLINED,
  ICC_UNRECORDED,
  ensureIccAssent,
  iccAssent,
  iccBlocked,
  iccNeedsAssent,
  openIccLicense,
  recordIccAssent,
  registerIccLicenseOpener,
  resetIccAssent,
  subscribeIccAssent,
} from '../src/renderer/lib/icc-assent';

const state = vi.mocked(app.iccAssentState);
const record = vi.mocked(app.recordIccAssent);

const answer = (assent: string, portable = true) => ({
  portable,
  assent,
  licensePath: 'C:\\App\\icc\\Adobe-Color-Profile-License.txt',
});

beforeEach(() => {
  resetIccAssent();
  state.mockReset();
  record.mockReset();
});

afterEach(() => {
  resetIccAssent();
});

describe('reading the answer', () => {
  it('reads once per session and serves every later ask from that', async () => {
    state.mockResolvedValue(answer(ICC_ACCEPTED));
    await ensureIccAssent();
    await ensureIccAssent();
    await ensureIccAssent();
    expect(state).toHaveBeenCalledTimes(1);
    expect(iccAssent().assent).toBe(ICC_ACCEPTED);
  });

  it('stays pending when the read itself fails, so the next ask retries', async () => {
    // The `ensureGsCapability` regression, kept fixed here: one early IPC
    // hiccup must not disable colour conversion for the whole session.
    state.mockRejectedValueOnce(new Error('ipc went away'));
    const first = await ensureIccAssent();
    expect(first.pending).toBe(true);
    expect(iccBlocked(first)).toBe(false);

    state.mockResolvedValue(answer(ICC_ACCEPTED));
    const second = await ensureIccAssent();
    expect(second.assent).toBe(ICC_ACCEPTED);
  });

  it('treats a value it does not recognize as unrecorded, never as accepted', async () => {
    state.mockResolvedValue(answer('something-new'));
    const resolved = await ensureIccAssent();
    expect(resolved.assent).toBe(ICC_UNRECORDED);
    expect(iccBlocked(resolved)).toBe(true);
  });
});

describe('what a surface does with it', () => {
  it('does not disable anything while the read is still in flight', () => {
    // A surface disabled on a pending answer would flash a refusal on every
    // launch that it is about to withdraw.
    expect(iccAssent().pending).toBe(true);
    expect(iccBlocked()).toBe(false);
    expect(iccNeedsAssent()).toBe(false);
  });

  it.each([
    [ICC_ACCEPTED, false],
    [ICC_DECLINED, true],
    [ICC_UNRECORDED, true],
  ])('blocks on %s: %s', async (assent, blocked) => {
    state.mockResolvedValue(answer(assent));
    expect(iccBlocked(await ensureIccAssent())).toBe(blocked);
  });
});

describe('who gets asked', () => {
  it('opens the dialog only for an unrecorded answer in a portable copy', async () => {
    state.mockResolvedValue(answer(ICC_UNRECORDED, true));
    expect(iccNeedsAssent(await ensureIccAssent())).toBe(true);
  });

  it('never opens it in an installed copy, which carries the installer answer', async () => {
    resetIccAssent();
    state.mockResolvedValue(answer(ICC_ACCEPTED, false));
    expect(iccNeedsAssent(await ensureIccAssent())).toBe(false);
  });

  it('does not re-ask after a decline — that is a recorded answer', async () => {
    state.mockResolvedValue(answer(ICC_DECLINED, true));
    const resolved = await ensureIccAssent();
    // Disabled, so the notice shows and the user can come back to it...
    expect(iccBlocked(resolved)).toBe(true);
    // ...but the dialog does not reappear by itself on every launch.
    expect(iccNeedsAssent(resolved)).toBe(false);
  });
});

describe('answering', () => {
  it('publishes the new state to every subscribed surface', async () => {
    state.mockResolvedValue(answer(ICC_UNRECORDED));
    await ensureIccAssent();

    const woken = vi.fn();
    const unsubscribe = subscribeIccAssent(woken);
    record.mockResolvedValue(answer(ICC_ACCEPTED));

    await recordIccAssent(true);
    expect(record).toHaveBeenCalledWith(true);
    expect(woken).toHaveBeenCalled();
    // Lit up in place: no restart, no reopening the panel.
    expect(iccBlocked()).toBe(false);
    unsubscribe();
  });

  it('routes every surface back to the one dialog', () => {
    const open = vi.fn();
    registerIccLicenseOpener(open);
    openIccLicense();
    expect(open).toHaveBeenCalledTimes(1);

    registerIccLicenseOpener(null);
    openIccLicense();
    expect(open).toHaveBeenCalledTimes(1);
  });
});
