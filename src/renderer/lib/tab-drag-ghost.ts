// The tab-shaped element that follows the cursor during a cross-window drag.
//
// A clone of the tab rather than a rebuilt lookalike: the tab's own truncation,
// icon and dirty dot come along, and nothing here has to be kept in step with
// the strip's styling. The OS cursor is left alone — this is the only thing
// that moves.

const GHOST_Z_INDEX = '80';
const SNAP_BACK_MS = 130;
const FALLBACK_BACKGROUND = '#262626';

/**
 * The first painted background at or above an element.
 *
 * An idle tab declares none of its own — it is the strip behind it that is
 * painted — and a clone carrying a transparent background shows whatever the
 * ghost passes over instead of looking like a tab.
 */
function opaqueBackgroundOf(el: HTMLElement | null): string {
  for (let node = el; node; node = node.parentElement) {
    const color = getComputedStyle(node).backgroundColor;
    if (color && color !== 'transparent' && !color.startsWith('rgba(0, 0, 0, 0)')) return color;
  }
  return FALLBACK_BACKGROUND;
}

export function buildTabGhost(tabEl: HTMLElement, rect: DOMRect): HTMLElement {
  const wrap = document.createElement('div');
  Object.assign(wrap.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    pointerEvents: 'none',
    zIndex: GHOST_Z_INDEX,
    opacity: '0.85',
    borderRadius: '4px',
    overflow: 'hidden',
    boxShadow: '0 4px 24px rgba(0, 0, 0, 0.45)',
    willChange: 'transform',
  });
  wrap.setAttribute('data-testid', 'tab-drag-ghost');

  const clone = tabEl.cloneNode(true) as HTMLElement;
  Object.assign(clone.style, {
    width: '100%',
    height: '100%',
    background: opaqueBackgroundOf(tabEl),
    margin: '0',
  });
  wrap.appendChild(clone);

  document.body.appendChild(wrap);
  return wrap;
}

export function moveTabGhost(ghost: HTMLElement, x: number, y: number): void {
  ghost.style.transform = `translate(${x}px, ${y}px)`;
}

export function removeTabGhost(ghost: HTMLElement): void {
  ghost.remove();
}

/**
 * Return the ghost to the tab it came from, then remove it.
 *
 * A refused or same-window drop leaves the document exactly where it was, and
 * the ghost vanishing where the cursor happens to be reads as the tab having
 * gone somewhere.
 */
export function snapTabGhostBack(ghost: HTMLElement, home: { x: number; y: number }): void {
  ghost.style.transition = `transform ${SNAP_BACK_MS}ms ease-out, opacity ${SNAP_BACK_MS}ms ease-out`;
  moveTabGhost(ghost, home.x, home.y);
  ghost.style.opacity = '0';
  window.setTimeout(() => ghost.remove(), SNAP_BACK_MS);
}
