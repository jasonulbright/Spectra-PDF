// U8 — the engine opened it, pdf.js will not draw it. The verdict is keyed on
// buffer identity so it dies with the bytes that earned it.
import { describe, it, expect } from 'vitest';
import {
  EMPTY_RENDER_HEALTH,
  isUnrenderable,
  markRenderFailed,
  markRenderSucceeded,
  pruneRenderHealth,
  unrenderablePaths,
} from '../src/renderer/lib/render-health';

const A = 'C:\\docs\\truncated.pdf';
const B = 'C:\\docs\\fine.pdf';

describe('render health', () => {
  it('reports nothing before any verdict', () => {
    expect(isUnrenderable(EMPTY_RENDER_HEALTH, A, {})).toBe(false);
  });

  it('reports a refused load against the bytes that were refused', () => {
    const buffer = {};
    const state = markRenderFailed(EMPTY_RENDER_HEALTH, A, buffer);
    expect(isUnrenderable(state, A, buffer)).toBe(true);
    expect(isUnrenderable(state, B, buffer)).toBe(false);
  });

  it('clears when a later load of the same bytes succeeds', () => {
    const buffer = {};
    let state = markRenderFailed(EMPTY_RENDER_HEALTH, A, buffer);
    state = markRenderSucceeded(state, A);
    expect(isUnrenderable(state, A, buffer)).toBe(false);
  });

  it('does not outlive the bytes: new buffer, no verdict', () => {
    const state = markRenderFailed(EMPTY_RENDER_HEALTH, A, {});
    // A repair, an undo, any whole-file op — the load for the new bytes is in
    // flight and has reached no verdict, so the canvas must not still accuse.
    expect(isUnrenderable(state, A, {})).toBe(false);
  });

  it('treats an absent buffer as no verdict', () => {
    const buffer = {};
    const state = markRenderFailed(EMPTY_RENDER_HEALTH, A, buffer);
    expect(isUnrenderable(state, A, null)).toBe(false);
    expect(isUnrenderable(state, A, undefined)).toBe(false);
  });

  it('drops verdicts for closed files', () => {
    const buffer = {};
    const state = pruneRenderHealth(markRenderFailed(EMPTY_RENDER_HEALTH, A, buffer), new Set([B]));
    expect(isUnrenderable(state, A, buffer)).toBe(false);
  });

  it('keeps identity stable when nothing changed', () => {
    const buffer = {};
    const state = markRenderFailed(EMPTY_RENDER_HEALTH, A, buffer);
    expect(markRenderFailed(state, A, buffer)).toBe(state);
    expect(markRenderSucceeded(state, B)).toBe(state);
    expect(pruneRenderHealth(state, new Set([A]))).toBe(state);
  });

  it('lists only the documents whose current bytes were refused', () => {
    const stale = {};
    const fresh = {};
    const state = markRenderFailed(markRenderFailed(EMPTY_RENDER_HEALTH, A, fresh), B, stale);
    expect(unrenderablePaths(state, new Map([[A, fresh], [B, {}]]))).toEqual([A]);
  });
});
