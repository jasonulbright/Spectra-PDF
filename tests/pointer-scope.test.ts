import { describe, it, expect, vi } from 'vitest';
import { ownsPointer, pointerScope } from '../src/renderer/lib/pointer-scope';

const pointer = (type: string, pointerId: number): Event => Object.assign(new Event(type), { pointerId });

function drag(target: EventTarget) {
  const pointers = pointerScope(1, target);
  const moves: number[] = [];
  const result = { committed: false, cancelled: false };
  const move = (ev: PointerEvent): void => void moves.push(ev.pointerId);
  const detach = (): void => {
    pointers.remove('pointermove', move);
    pointers.remove('pointerup', up);
    pointers.remove('pointercancel', cancel);
    pointers.remove('blur', cancel);
  };
  const up = (): void => {
    detach();
    result.committed = true;
  };
  const cancel = (): void => {
    detach();
    result.cancelled = true;
  };
  pointers.add('pointermove', move);
  pointers.add('pointerup', up);
  pointers.add('pointercancel', cancel);
  pointers.add('blur', cancel);
  return { moves, result };
}

describe('pointerScope', () => {
  it('moves and commits for the pointer that started the drag', () => {
    const t = new EventTarget();
    const { moves, result } = drag(t);
    t.dispatchEvent(pointer('pointermove', 1));
    t.dispatchEvent(pointer('pointerup', 1));
    expect(moves).toEqual([1]);
    expect(result).toEqual({ committed: true, cancelled: false });
  });

  it('ignores a second pointer moving, lifting or cancelling during the drag', () => {
    const t = new EventTarget();
    const { moves, result } = drag(t);
    t.dispatchEvent(pointer('pointermove', 2));
    t.dispatchEvent(pointer('pointerup', 2));
    t.dispatchEvent(pointer('pointercancel', 2));
    expect(moves).toEqual([]);
    expect(result).toEqual({ committed: false, cancelled: false });
    t.dispatchEvent(pointer('pointerup', 1));
    expect(result.committed).toBe(true);
  });

  it('ends without commit on pointercancel or blur, and detaches every listener', () => {
    for (const type of ['pointercancel', 'blur']) {
      const t = new EventTarget();
      const { moves, result } = drag(t);
      t.dispatchEvent(type === 'blur' ? new Event('blur') : pointer(type, 1));
      t.dispatchEvent(pointer('pointermove', 1));
      t.dispatchEvent(pointer('pointerup', 1));
      expect(moves).toEqual([]);
      expect(result).toEqual({ committed: false, cancelled: true });
    }
  });

  it('removes by the listener that was added', () => {
    const t = new EventTarget();
    const fn = vi.fn();
    const pointers = pointerScope(1, t);
    pointers.add('pointermove', fn);
    pointers.remove('pointermove', fn);
    t.dispatchEvent(pointer('pointermove', 1));
    expect(fn).not.toHaveBeenCalled();
  });

  it('ownsPointer passes events without a pointer id', () => {
    expect(ownsPointer(1, new Event('blur'))).toBe(true);
    expect(ownsPointer(1, pointer('pointerup', 2))).toBe(false);
  });
});
