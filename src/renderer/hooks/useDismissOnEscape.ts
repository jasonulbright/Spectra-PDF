import { useEffect, useRef } from 'react';
import { pushEscapeInterceptor } from '../commands/context';

interface FocusableLike {
  readonly isConnected: boolean;
}

/**
 * Where focus goes once a dismissed surface is gone: back to the element that
 * held it when the surface opened, but only when focus was lost with the
 * surface (it sat inside and fell to the body). A click elsewhere that closed
 * the surface keeps the focus it took.
 */
export function focusReturnTarget<T extends FocusableLike>(
  active: unknown,
  body: unknown,
  opener: T | null,
): T | null {
  if (!opener || opener === body || !opener.isConnected) return null;
  if (active !== null && active !== undefined && active !== body) return null;
  return opener;
}

/**
 * A non-modal floating surface (a placement card, a status-bar popover) owns
 * Escape while it is open: the key closes it and nothing further down the
 * Escape chain runs, so one press never both closes the surface and disarms
 * the canvas mode. Surfaces stack LIFO on the keymap's interceptor stack, so
 * the most recently opened one closes first.
 */
export function useDismissOnEscape(open: boolean, dismiss: () => void): void {
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;
  const openerRef = useRef<HTMLElement | null>(null);
  // Read during the render that opens the surface: a child's `autoFocus`
  // moves focus in the commit, before any effect of this component runs.
  if (open && openerRef.current === null && typeof document !== 'undefined') {
    openerRef.current = (document.activeElement as HTMLElement | null) ?? document.body;
  }
  useEffect(() => {
    if (!open) return;
    const pop = pushEscapeInterceptor(() => {
      dismissRef.current();
      return true;
    });
    return () => {
      pop();
      const opener = openerRef.current;
      openerRef.current = null;
      focusReturnTarget(document.activeElement, document.body, opener)?.focus();
    };
  }, [open]);
}
