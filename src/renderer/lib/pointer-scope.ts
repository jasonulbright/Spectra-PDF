type WindowListener<K extends keyof WindowEventMap> = (ev: WindowEventMap[K]) => void;

export interface PointerScope {
  add<K extends keyof WindowEventMap>(type: K, listener: WindowListener<K>, options?: boolean | AddEventListenerOptions): void;
  remove<K extends keyof WindowEventMap>(type: K, listener: WindowListener<K>, options?: boolean | EventListenerOptions): void;
}

type ListenerTarget = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

/**
 * Window listeners for the gesture of one pointer. A pointer event from any
 * other pointer is dropped before the listener runs: without this, a pen or
 * touch contact during a mouse drag moves the drag, and its release commits
 * it. Events that carry no pointer id (blur, keydown) always pass.
 *
 * `remove` must receive the same listener that `add` received; the wrapper is
 * looked up by that identity.
 */
export function pointerScope(pointerId: number, target: ListenerTarget = window): PointerScope {
  const wrapped = new Map<unknown, EventListener>();
  const wrap = (listener: unknown): EventListener => {
    let w = wrapped.get(listener);
    if (!w) {
      w = (ev: Event): void => {
        if (ownsPointer(pointerId, ev)) (listener as (ev: Event) => void)(ev);
      };
      wrapped.set(listener, w);
    }
    return w;
  };
  return {
    add: (type, listener, options) => target.addEventListener(type, wrap(listener), options),
    remove: (type, listener, options) => target.removeEventListener(type, wrap(listener), options),
  };
}

/** True when `ev` belongs to the gesture of `pointerId` or carries no pointer id. */
export function ownsPointer(pointerId: number, ev: Event): boolean {
  const id = (ev as Partial<PointerEvent>).pointerId;
  return typeof id !== 'number' || id === pointerId;
}
