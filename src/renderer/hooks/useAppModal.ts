import { useEffect, useRef } from 'react';
import { pushAppModal } from '../commands/context';

/**
 * The plain-div dialog shells' keyboard/focus contract (M6.5, § 10.5) — one
 * hook instead of four per-dialog implementations:
 *
 *  - registers on the app-modal stack, so the keymap dispatcher's Escape
 *    closes the TOP dialog (M5.5b's recorded gap);
 *  - moves focus INTO the dialog on open and back to the opener on close
 *    (attach the returned ref + `tabIndex={-1}` to the dialog container);
 *  - traps Tab inside the dialog (focus must not wander into the chrome
 *    behind a modal).
 *
 * Radix-based dialogs (Confirm, Password) already do all of this and never
 * use this hook.
 */
export function useAppModal(onClose: () => void): React.RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const pop = pushAppModal(() => closeRef.current());
    const opener = document.activeElement as HTMLElement | null;
    const el = ref.current;
    el?.focus();
    const trap = (e: KeyboardEvent): void => {
      // Plain Tab only: Ctrl+Tab is the (suppressed) tab-switch chord, and
      // treating it as focus movement relocated focus for no reason the
      // user asked for (review-caught).
      if (e.key !== 'Tab' || e.ctrlKey || e.metaKey || e.altKey || !el) return;
      const focusables = el.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === el)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    el?.addEventListener('keydown', trap);
    return () => {
      el?.removeEventListener('keydown', trap);
      pop();
      // The opener may be gone (a menu item that closed); focus falls back
      // to the body then, which is the pre-hook behavior.
      opener?.focus?.();
    };
  }, []);
  return ref;
}
