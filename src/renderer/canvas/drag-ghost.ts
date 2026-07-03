// Floating drag ghost: a fixed-position snapshot of the page that follows the
// pointer. Replaces PDFx's DataTransfer.setDragImage — with Tauri's native
// drag-drop enabled, HTML5 drag events never complete inside the webview on
// Windows, so the canvas drives drags from pointer events and draws its own
// ghost.
export function buildDragGhost(pageEl: HTMLElement, rect: DOMRect): HTMLElement {
  const w = rect.width;
  const h = rect.height;
  const k = pageEl.offsetHeight ? h / pageEl.offsetHeight : 1;

  const wrap = document.createElement('div');
  Object.assign(wrap.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    width: `${w}px`,
    height: `${h}px`,
    borderRadius: `${10 * k}px`,
    overflow: 'hidden',
    background: 'var(--surface, #fff)',
    boxShadow: '0 4px 24px rgba(0, 0, 0, 0.45)',
    opacity: '0.9',
    pointerEvents: 'none',
    zIndex: '80',
    willChange: 'transform',
  });

  const src = pageEl.querySelector('canvas.pageview-base') as HTMLCanvasElement | null;
  if (src && src.classList.contains('ready')) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * dpr));
    c.height = Math.max(1, Math.round(h * dpr));
    Object.assign(c.style, { width: '100%', height: '100%', display: 'block' });
    c.getContext('2d')?.drawImage(src, 0, 0, c.width, c.height);
    wrap.appendChild(c);
  }

  document.body.appendChild(wrap);
  return wrap;
}

export function moveDragGhost(ghost: HTMLElement, x: number, y: number): void {
  ghost.style.transform = `translate(${x}px, ${y}px)`;
}
