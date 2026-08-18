// Flush BEFORE acknowledge — the peer half of the exit seal.
//
// The seam this closes: only the sealing window flushed its tab order, so a
// reorder made in window B and still in flight when window A hit Exit was
// sealed over. A peer that publishes before it answers cannot be sealed over,
// and the quit's own 3s abort bounds the wait — a flush that never finishes
// withholds the receipt and the quit aborts, which is the fail-closed outcome.
import { describe, expect, it, vi } from 'vitest';
import { sealBeforeClose } from '../src/renderer/lib/close-sequence';

describe('sealBeforeClose', () => {
  it('acknowledges only AFTER the flush has resolved', async () => {
    const order: string[] = [];
    let release: (() => void) | null = null;
    const flushing = new Promise<void>((resolve) => {
      release = () => {
        order.push('flush');
        resolve();
      };
    });

    const run = sealBeforeClose(7, {
      flush: () => flushing,
      ack: async (id) => {
        order.push(`ack:${id}`);
      },
    });

    // The flush is still outstanding: nothing may have been acknowledged.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual([]);

    release!();
    await run;
    expect(order).toEqual(['flush', 'ack:7']);
  });

  it('never acknowledges at all while the flush is outstanding', async () => {
    const ack = vi.fn(async () => {});
    // A flush that never settles: the quit's timeout is what answers, and it
    // answers ABORT. Nothing here may answer for it.
    void sealBeforeClose(1, { flush: () => new Promise<void>(() => {}), ack });
    await new Promise((r) => setTimeout(r, 10));
    expect(ack).not.toHaveBeenCalled();
  });

  it('flushes on a plain window close and acknowledges nothing', async () => {
    // quitId null is a window ×: no quit is waiting, and the last window
    // closing still seals the record by that route.
    const flush = vi.fn(async () => {});
    const ack = vi.fn(async () => {});
    await sealBeforeClose(null, { flush, ack });
    expect(flush).toHaveBeenCalledTimes(1);
    expect(ack).not.toHaveBeenCalled();
  });

  it('swallows a failed receipt — the quit timeout is the authority', async () => {
    const flush = vi.fn(async () => {});
    await expect(
      sealBeforeClose(3, {
        flush,
        ack: async () => {
          throw new Error('window gone');
        },
      }),
    ).resolves.toBeUndefined();
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('propagates a flush failure rather than acknowledging over it', async () => {
    // A publisher that threw has not published; answering the quit anyway
    // would hand it a receipt for an order that never arrived.
    const ack = vi.fn(async () => {});
    await expect(
      sealBeforeClose(4, {
        flush: async () => {
          throw new Error('publisher failed');
        },
        ack,
      }),
    ).rejects.toThrow('publisher failed');
    expect(ack).not.toHaveBeenCalled();
  });
});
