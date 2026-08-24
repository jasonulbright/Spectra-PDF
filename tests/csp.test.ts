// The page's Content-Security-Policy, checked against what the app actually
// puts on screen and on the wire.
//
// The policy is a meta tag rather than a header, so nothing else enforces it
// and nothing else reports it: a directive that is too narrow fails silently
// as a blank image or a slow IPC transport, both of which look like bugs
// somewhere else entirely.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const html = readFileSync(
  resolve(__dirname, '..', 'src', 'renderer', 'index.html'),
  'utf8',
);

function directive(name: string): string[] {
  const meta = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html);
  expect(meta).not.toBeNull();
  const found = meta![1]
    .split(';')
    .map((d) => d.trim())
    .find((d) => d === name || d.startsWith(`${name} `));
  return found ? found.split(/\s+/).slice(1) : [];
}

describe('the renderer content security policy', () => {
  it('lets images carry the rasters this app produces itself', () => {
    // Page renders, captured signatures, and stamp artwork are canvas data
    // URLs and object URLs. Under `default-src 'self'` alone every one of
    // them fails to load and the surface shows nothing.
    const img = directive('img-src');
    expect(img).toContain('data:');
    expect(img).toContain('blob:');
    expect(img).toContain("'self'");
  });

  it('keeps the IPC endpoint connectable', () => {
    // Without it every invoke falls back to the slower postMessage transport,
    // one console error per call.
    const connect = directive('connect-src');
    expect(connect).toContain('ipc:');
    expect(connect).toContain('http://ipc.localhost');
  });

  it('does not widen script-src past the bundle', () => {
    expect(directive('script-src')).toEqual(["'self'"]);
  });
});
