// Tauri stamps a fresh nonce on the shell's inline <style> and grants that
// nonce, and only that nonce, to `style-src` for this document load. The
// scroll lock under every modal dialog (react-remove-scroll-bar through
// react-style-singleton) inserts its own <style> element and tags it with
// the global `__webpack_nonce__` when one is defined; without it the
// policy refuses the element and the page behind a dialog keeps scrolling.
// The nonce attribute reads back empty by design, so it is taken from the
// element's `nonce` property.
export function adoptStyleNonce(doc: Document = document): string | null {
  const shell = doc.querySelector<HTMLStyleElement>('head style[nonce]');
  const nonce = shell?.nonce ?? '';
  if (!nonce) return null;
  (globalThis as { __webpack_nonce__?: string }).__webpack_nonce__ = nonce;
  return nonce;
}
