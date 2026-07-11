// Floating drag ghost: a fixed-position snapshot of the page that follows the
// pointer. Replaces PDFx's DataTransfer.setDragImage — with Tauri's native
// drag-drop enabled, HTML5 drag events never complete inside the webview on
// Windows, so the canvas drives drags from pointer events and draws its own
// ghost. When `count` > 1 (a multi-page drag) the ghost stacks and shows a
// badge with the number of pages travelling together.
export function buildDragGhost(pageEl: HTMLElement, rect: DOMRect, count = 1): HTMLElement {
  const w = rect.width;
  const h = rect.height;
  const k = pageEl.offsetHeight ? h / pageEl.offsetHeight : 1;

  // Outer wrapper positions the whole ghost (including the stack offset); the
  // inner card carries the page snapshot so moveDragGhost only transforms one
  // element.
  const wrap = document.createElement('div');
  Object.assign(wrap.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    width: `${w}px`,
    height: `${h}px`,
    pointerEvents: 'none',
    zIndex: '80',
    willChange: 'transform',
  });

  const multi = count > 1;
  // Stacked shadow cards behind the top page for a multi-page drag.
  if (multi) {
    for (const off of [10 * k, 5 * k]) {
      const back = document.createElement('div');
      Object.assign(back.style, {
        position: 'absolute',
        top: `${off}px`,
        left: `${off}px`,
        width: '100%',
        height: '100%',
        borderRadius: `${10 * k}px`,
        background: 'var(--surface, #fff)',
        boxShadow: '0 4px 24px rgba(0, 0, 0, 0.35)',
        opacity: '0.9',
      });
      wrap.appendChild(back);
    }
  }

  const card = document.createElement('div');
  Object.assign(card.style, {
    position: 'absolute',
    top: '0',
    left: '0',
    width: '100%',
    height: '100%',
    borderRadius: `${10 * k}px`,
    overflow: 'hidden',
    background: 'var(--surface, #fff)',
    boxShadow: '0 4px 24px rgba(0, 0, 0, 0.45)',
    opacity: '0.9',
  });

  const src = pageEl.querySelector('canvas.pageview-base') as HTMLCanvasElement | null;
  if (src && src.classList.contains('ready')) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * dpr));
    c.height = Math.max(1, Math.round(h * dpr));
    Object.assign(c.style, { width: '100%', height: '100%', display: 'block' });
    c.getContext('2d')?.drawImage(src, 0, 0, c.width, c.height);
    card.appendChild(c);
  }
  wrap.appendChild(card);

  if (multi) {
    const badge = document.createElement('div');
    badge.textContent = String(count);
    Object.assign(badge.style, {
      position: 'absolute',
      top: `${-8 * k}px`,
      right: `${-8 * k}px`,
      minWidth: `${22 * k}px`,
      height: `${22 * k}px`,
      padding: `0 ${6 * k}px`,
      boxSizing: 'border-box',
      borderRadius: `${11 * k}px`,
      background: 'var(--accent, #2f6fed)',
      color: '#fff',
      fontSize: `${12 * k}px`,
      fontWeight: '700',
      lineHeight: `${22 * k}px`,
      textAlign: 'center',
      boxShadow: '0 1px 4px rgba(0, 0, 0, 0.4)',
    });
    wrap.appendChild(badge);
  }

  document.body.appendChild(wrap);
  return wrap;
}

export function moveDragGhost(ghost: HTMLElement, x: number, y: number): void {
  ghost.style.transform = `translate(${x}px, ${y}px)`;
}
