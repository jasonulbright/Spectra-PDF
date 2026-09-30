// The webview content security policy, read from the one place it is defined.
//
// Tauri serves the policy as a response header on every HTML asset and
// appends a per-load nonce to `style-src` for the inline <style> in
// index.html. A nonce in a directive makes the browser ignore
// 'unsafe-inline' in that directive, so inline style ATTRIBUTES are granted
// through `style-src-attr` alone: the paragraph editor's contentEditable
// surface is an innerHTML string carrying `style="…"` spans
// (lib/edit-paragraphs.ts `segmentsToHtml`), and the browser's own editing
// commands write style attributes into that surface too.
//
// `connect-src` must name Tauri's IPC endpoint (ipc: / http://ipc.localhost),
// or every invoke falls back to the postMessage transport with a console
// error per call. `img-src` must allow data: and blob:: page renders,
// captured signatures, stamp artwork and print previews are canvas data URLs
// or object URLs, and a refused one draws as a blank preview with no error
// surfaced to the user.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');
const conf = JSON.parse(readFileSync(resolve(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const security = conf.app.security as Record<string, unknown>;
const csp = security.csp as Record<string, string>;

function sources(directive: string): string[] {
  const value = csp[directive];
  return typeof value === 'string' ? value.trim().split(/\s+/) : [];
}

describe('webview content security policy', () => {
  it('is defined as a directive map', () => {
    expect(csp).not.toBeNull();
    expect(typeof csp).toBe('object');
    expect(sources('default-src')).toEqual(["'self'"]);
  });

  it('never allows eval, in any directive', () => {
    for (const [directive, value] of Object.entries(csp)) {
      expect(value, directive).not.toContain("'unsafe-eval'");
      expect(value, directive).not.toContain("'wasm-unsafe-eval'");
    }
  });

  it('does not widen script-src past the bundle', () => {
    expect(sources('script-src')).toEqual(["'self'"]);
  });

  it('limits scripts to the app origin', () => {
    expect(csp['script-src-elem']).toBeUndefined();
    expect(csp['script-src-attr']).toBeUndefined();
    expect(sources('worker-src')).toEqual(["'self'"]);
  });

  it('keeps inline style elements behind the Tauri nonce', () => {
    expect(sources('style-src')).toEqual(["'self'"]);
    expect(csp['style-src-elem']).toBeUndefined();
    expect(sources('style-src-attr')).toEqual(["'unsafe-inline'"]);
  });

  it('closes plugins, base rebinding, framing and form navigation', () => {
    expect(sources('object-src')).toEqual(["'none'"]);
    expect(sources('base-uri')).toEqual(["'none'"]);
    expect(sources('frame-src')).toEqual(["'none'"]);
    expect(sources('frame-ancestors')).toEqual(["'none'"]);
    expect(sources('form-action')).toEqual(["'none'"]);
  });

  it('lets images carry the rasters this app produces itself', () => {
    expect(sources('img-src')).toEqual(["'self'", 'data:', 'blob:']);
  });

  it('keeps the IPC endpoint connectable', () => {
    expect(sources('connect-src')).toEqual(["'self'", 'ipc:', 'http://ipc.localhost']);
  });

  it('reaches no network origin other than the IPC endpoint', () => {
    expect(sources('font-src')).toEqual(["'self'"]);
    for (const [directive, value] of Object.entries(csp)) {
      for (const source of value.trim().split(/\s+/)) {
        expect(source, directive).not.toBe('*');
        expect(source, directive).not.toMatch(/^https?:$/);
      }
    }
  });

  it('lets Tauri apply its nonces and has no looser dev variant', () => {
    expect(security.dangerousDisableAssetCspModification).toBeUndefined();
    expect(security.devCsp).toBeUndefined();
  });

  it('has no second policy or inline script in index.html', () => {
    const html = readFileSync(resolve(root, 'src', 'renderer', 'index.html'), 'utf8');
    expect(html).not.toMatch(/http-equiv\s*=\s*["']Content-Security-Policy/i);
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    expect(scripts.length).toBeGreaterThan(0);
    for (const [, attrs, body] of scripts) {
      expect(attrs).toMatch(/\bsrc\s*=/);
      expect(body.trim()).toBe('');
    }
  });
});

describe('adoptStyleNonce', () => {
  const g = globalThis as { __webpack_nonce__?: string };

  it('publishes the shell style nonce for libraries that insert <style>', async () => {
    const { adoptStyleNonce } = await import('../src/renderer/lib/style-nonce');
    const doc = { querySelector: () => ({ nonce: 'abc123' }) } as unknown as Document;
    delete g.__webpack_nonce__;
    expect(adoptStyleNonce(doc)).toBe('abc123');
    expect(g.__webpack_nonce__).toBe('abc123');
    delete g.__webpack_nonce__;
  });

  it('publishes nothing when the shell carries no nonce', async () => {
    const { adoptStyleNonce } = await import('../src/renderer/lib/style-nonce');
    const doc = { querySelector: () => null } as unknown as Document;
    delete g.__webpack_nonce__;
    expect(adoptStyleNonce(doc)).toBeNull();
    expect(g.__webpack_nonce__).toBeUndefined();
  });
});
