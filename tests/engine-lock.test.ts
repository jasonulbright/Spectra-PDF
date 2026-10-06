import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isTrackableMethod } from '../src/renderer/hooks/useOperationQueue';
import { ENGINE_LOCK_TABLE, lockKeysFor, withFileLock, __lockedCount, type LockClaim } from '../src/renderer/lib/engine-lock';

/** A promise plus its resolver, so a test can hold an operation open. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Drains enough microtasks for every waiter whose turn has come to start. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

const S = (key: string): LockClaim => ({ key, mode: 'shared' });
const X = (key: string): LockClaim => ({ key, mode: 'exclusive' });

describe('lockKeysFor', () => {
  it('takes the mode of each parameter from the method row', () => {
    expect(lockKeysFor('merge', { files: ['C:\\b.pdf', 'C:\\a.pdf'], output: 'C:\\c.pdf' })).toEqual([
      S('C:\\a.pdf'), S('C:\\b.pdf'), X('C:\\c.pdf'),
    ]);
    expect(lockKeysFor('compress', { file: 'C:\\a.pdf', output: 'C:\\b.pdf' })).toEqual([
      S('C:\\a.pdf'), X('C:\\b.pdf'),
    ]);
    expect(lockKeysFor('get_page_count', { file: 'C:\\a.pdf' })).toEqual([S('C:\\a.pdf')]);
  });

  it('a key named shared and exclusive in one call is exclusive', () => {
    expect(lockKeysFor('rotate', { file: 'C:\\a.pdf', output: 'C:\\a.pdf' })).toEqual([X('C:\\a.pdf')]);
  });

  it('holds the in-place writers exclusive on the key they rewrite', () => {
    expect(lockKeysFor('open_document', { path: 'w.pdf', password: 'p' })).toEqual([X('w.pdf')]);
    expect(lockKeysFor('open_document_attempt', { path: 'w.pdf', password: 'p' })).toEqual([X('w.pdf')]);
    expect(lockKeysFor('open_pubkey_document', { path: 'w.pdf', pfx: 'id.pfx' })).toEqual([S('id.pfx'), X('w.pdf')]);
    expect(lockKeysFor('unlock', { file: 'w.pdf', password: 'p' })).toEqual([X('w.pdf')]);
    expect(lockKeysFor('print_preview', { file: 'w.pdf', cleanup_dir: 'prev' })).toEqual([X('prev'), S('w.pdf')]);
    expect(lockKeysFor('print_preview_cleanup', { directory: 'prev' })).toEqual([X('prev')]);
    expect(lockKeysFor('extract_page_image', { file: 'w.pdf', output_prefix: 'out' })).toEqual([X('out'), S('w.pdf')]);
    expect(lockKeysFor('add_user_dictionary', { aff: 'a.aff', dic: 'a.dic', user_dictionary_dir: 'u' })).toEqual([X('u')]);
    expect(lockKeysFor('transplant_incremental', { original: 'w.pdf', modified: 't.pdf', output: 't.pdf' }))
      .toEqual([X('t.pdf'), S('w.pdf')]);
  });

  it('a folder run is exclusive on its source only when it rewrites in place', () => {
    for (const method of ['batch_ocr', 'run_action', 'run_preflight_sweep']) {
      expect(lockKeysFor(method, { source: 'in', dest: 'out', in_place: true })).toEqual([X('in'), X('out')]);
      expect(lockKeysFor(method, { source: 'in', dest: 'out', in_place: false })).toEqual([S('in'), X('out')]);
      expect(lockKeysFor(method, { source: 'in', dest: 'out' })).toEqual([S('in'), X('out')]);
    }
  });

  it('reads source rows by their path and never keys base64 data or tool paths', () => {
    expect(lockKeysFor('create_pdf', { sources: [{ path: 'a.png' }, { kind: 'blank' }, 'b.pdf'], output: 'o.pdf' }))
      .toEqual([S('a.png'), S('b.pdf'), X('o.pdf')]);
    expect(lockKeysFor('sealed_plaintext', { path: 'w.pdf', data: 'QUJD' })).toEqual([S('w.pdf')]);
    expect(lockKeysFor('recognize', { file: 'w.pdf', gs_path: 'gs.exe', tesseract_path: 't.exe' })).toEqual([S('w.pdf')]);
    expect(lockKeysFor('recognize_raster', { data: 'QUJD', tesseract_path: 't.exe' })).toEqual([]);
  });

  it('ignores non-path values and empty strings', () => {
    expect(lockKeysFor('rotate', { pages: 3, file: '' })).toEqual([]);
    expect(lockKeysFor('merge', { files: ['C:\\a.pdf', 7, null, ''] })).toEqual([S('C:\\a.pdf')]);
  });

  it('locks an unlisted method exclusively on every common path parameter', () => {
    expect(lockKeysFor('not_a_method', { file: 'a', source: 'b', files: ['c'], gs_path: 'gs' }))
      .toEqual([X('a'), X('b'), X('c')]);
    expect(lockKeysFor('toString', { file: 'a' })).toEqual([X('a')]);
  });
});

describe('the lock table covers the engine and the renderer', () => {
  const registered = Array.from(
    readFileSync(new URL('../src/engine/__main__.py', import.meta.url), 'utf8')
      .matchAll(/server\.register\("([a-z_0-9]+)"/g),
    m => m[1],
  );

  it('has exactly one row per registered engine method', () => {
    expect(registered.length).toBeGreaterThan(200);
    expect(Object.keys(ENGINE_LOCK_TABLE).sort()).toEqual([...registered].sort());
  });

  it('every method id the renderer sends has a row, documentless methods an empty one', () => {
    const root = new URL('../src/renderer/', import.meta.url);
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(name)) files.push(full);
      }
    };
    walk(fileURLToPath(root));
    const sent = new Set<string>();
    const caller = /\b(?:call|callRaw|rawCall|engineCall|engineCallRaw|callStaged|dispatchEngineRequest)\(\s*'([a-z][a-z_0-9]*)'/g;
    for (const file of files) for (const m of readFileSync(file, 'utf8').matchAll(caller)) sent.add(m[1]);
    expect(sent.size).toBeGreaterThan(100);
    expect([...sent].filter(method => !Object.prototype.hasOwnProperty.call(ENGINE_LOCK_TABLE, method))).toEqual([]);
    expect(sent.has('print_preview')).toBe(true);
    expect(sent.has('recognize')).toBe(true);
    expect(ENGINE_LOCK_TABLE.list_system_fonts).toEqual({});
    expect(ENGINE_LOCK_TABLE.recognize_raster).toEqual({});
  });
});

describe('withFileLock', () => {
  it('keeps passive working-file readers ahead of publication without gating page edits', async () => {
    for (const method of ['read_form_fields', 'signature_policy', 'list_links', 'list_redact_annotations']) {
      expect(isTrackableMethod(method)).toBe(false);
    }
    // engine-call-ownership.test.ts executes this production closure and
    // proves both its passive no-gate path and post-lock ownership refusal.
    const canvas = readFileSync(new URL('../src/renderer/components/canvas/WorkspaceCanvasView.tsx', import.meta.url), 'utf8');
    for (const method of ['list_links', 'list_redact_annotations']) {
      expect(canvas).toContain(`engineCall('${method}'`);
      expect(canvas).not.toContain(`engineCallRaw('${method}'`);
    }
    const handle = deferred();
    const order: string[] = [];
    const reader = withFileLock(lockKeysFor('read_form_fields', { file: 'working.pdf' }), async () => {
      order.push('reader-open'); await handle.promise; order.push('reader-closed');
    });
    const undo = withFileLock(['working.pdf'], async () => { order.push('replace'); });
    await flush();
    expect(order).toEqual(['reader-open']);
    handle.resolve();
    await Promise.all([reader, undo]);
    expect(order).toEqual(['reader-open', 'reader-closed', 'replace']);
  });

  it('serializes two operations on the same file', async () => {
    const order: string[] = [];
    const first = deferred();
    const a = withFileLock(['C:\\a.pdf'], async () => {
      order.push('a:start');
      await first.promise;
      order.push('a:end');
    });
    const b = withFileLock(['C:\\a.pdf'], async () => {
      order.push('b:start');
    });
    // b must not have started: a still holds the file.
    await flush();
    expect(order).toEqual(['a:start']);
    first.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual(['a:start', 'a:end', 'b:start']);
  });

  it('two writes to one file through the method table run in issue order', async () => {
    const order: string[] = [];
    const first = deferred();
    const a = withFileLock(lockKeysFor('compress', { file: 'w.pdf', output: 'w.pdf' }), async () => {
      order.push('compress:start'); await first.promise; order.push('compress:end');
    });
    const b = withFileLock(lockKeysFor('grayscale', { file: 'w.pdf', output: 'w.pdf' }), async () => {
      order.push('grayscale');
    });
    await flush();
    expect(order).toEqual(['compress:start']);
    first.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual(['compress:start', 'compress:end', 'grayscale']);
  });

  it('shared holders of one key run together', async () => {
    const order: string[] = [];
    const one = deferred();
    const two = deferred();
    const a = withFileLock([S('w.pdf')], async () => { order.push('a:start'); await one.promise; order.push('a:end'); });
    const b = withFileLock([S('w.pdf')], async () => { order.push('b:start'); await two.promise; order.push('b:end'); });
    await flush();
    expect(order).toEqual(['a:start', 'b:start']);
    two.resolve();
    await b;
    expect(order).toEqual(['a:start', 'b:start', 'b:end']);
    one.resolve();
    await a;
    expect(__lockedCount()).toBe(0);
  });

  it('an exclusive holder waits for every earlier shared holder', async () => {
    const order: string[] = [];
    const one = deferred();
    const two = deferred();
    const a = withFileLock([S('w.pdf')], async () => { await one.promise; order.push('a:end'); });
    const b = withFileLock([S('w.pdf')], async () => { await two.promise; order.push('b:end'); });
    const w = withFileLock([X('w.pdf')], async () => { order.push('write'); });
    await flush();
    expect(order).toEqual([]);
    one.resolve();
    await a;
    await flush();
    expect(order).toEqual(['a:end']);
    two.resolve();
    await Promise.all([b, w]);
    expect(order).toEqual(['a:end', 'b:end', 'write']);
  });

  it('a waiting exclusive holder blocks every later shared holder, so readers cannot starve it', async () => {
    const order: string[] = [];
    const first = deferred();
    const write = deferred();
    const r1 = withFileLock([S('w.pdf')], async () => { order.push('r1'); await first.promise; });
    const w = withFileLock([X('w.pdf')], async () => { order.push('w:start'); await write.promise; order.push('w:end'); });
    const r2 = withFileLock([S('w.pdf')], async () => { order.push('r2'); });
    const r3 = withFileLock([S('w.pdf')], async () => { order.push('r3'); });
    await flush();
    expect(order).toEqual(['r1']);
    first.resolve();
    await flush();
    expect(order).toEqual(['r1', 'w:start']);
    write.resolve();
    await Promise.all([r1, w, r2, r3]);
    expect(order).toEqual(['r1', 'w:start', 'w:end', 'r2', 'r3']);
    expect(__lockedCount()).toBe(0);
  });

  it('a shared holder does not wait for a holder of another key', async () => {
    const hold = deferred();
    const a = withFileLock([X('a.pdf')], () => hold.promise);
    let ran = false;
    await withFileLock([S('b.pdf')], async () => { ran = true; });
    expect(ran).toBe(true);
    hold.resolve();
    await a;
  });

  it('one acquisition claims every key at once, whatever its modes', async () => {
    // Writer holds b; a merge reading a and b queues; a later writer of a
    // must queue behind the merge, not slip in on a free a.
    const order: string[] = [];
    const hold = deferred();
    const rewrite = withFileLock([X('b.pdf')], async () => { order.push('rewrite:start'); await hold.promise; order.push('rewrite:end'); });
    const merge = withFileLock(lockKeysFor('merge', { files: ['a.pdf', 'b.pdf'], output: 'm.pdf' }), async () => { order.push('merge'); });
    const writeA = withFileLock([X('a.pdf')], async () => { order.push('write-a'); });
    await flush();
    expect(order).toEqual(['rewrite:start']);
    hold.resolve();
    await Promise.all([rewrite, merge, writeA]);
    expect(order).toEqual(['rewrite:start', 'rewrite:end', 'merge', 'write-a']);
  });

  it('lets operations on DIFFERENT files run concurrently', async () => {
    const order: string[] = [];
    const hold = deferred();
    const a = withFileLock(['C:\\a.pdf'], async () => {
      order.push('a:start');
      await hold.promise;
    });
    const b = withFileLock(['C:\\b.pdf'], async () => {
      order.push('b:start');
    });
    await b;
    expect(order).toEqual(['a:start', 'b:start']);
    hold.resolve();
    await a;
  });

  it('a FAILED operation releases its lock and does not reject the next', async () => {
    const a = withFileLock(['C:\\a.pdf'], async () => {
      throw new Error('compress failed');
    });
    await expect(a).rejects.toThrow('compress failed');
    await expect(withFileLock(['C:\\a.pdf'], async () => 'ok')).resolves.toBe('ok');
    expect(__lockedCount()).toBe(0);
  });

  it('a failed shared holder releases its key for the exclusive holder behind it', async () => {
    const r = withFileLock([S('a.pdf')], async () => { throw new Error('read failed'); });
    const w = withFileLock([X('a.pdf')], async () => 'written');
    await expect(r).rejects.toThrow('read failed');
    await expect(w).resolves.toBe('written');
    expect(__lockedCount()).toBe(0);
  });

  it('releases every key it claimed, including on failure', async () => {
    await expect(
      withFileLock([S('C:\\a.pdf'), X('C:\\b.pdf')], async () => {
        throw new Error('nope');
      }),
    ).rejects.toThrow('nope');
    expect(__lockedCount()).toBe(0);
  });

  it('runs straight through when the call names no file', async () => {
    const order: string[] = [];
    await Promise.all([
      withFileLock([], async () => {
        order.push('one');
      }),
      withFileLock([], async () => {
        order.push('two');
      }),
    ]);
    expect(order.sort()).toEqual(['one', 'two']);
  });

  it('a three-deep queue on one file runs in arrival order', async () => {
    const order: number[] = [];
    const gate = deferred();
    const runs = [1, 2, 3].map((n) =>
      withFileLock(['C:\\a.pdf'], async () => {
        if (n === 1) await gate.promise;
        order.push(n);
      }),
    );
    gate.resolve();
    await Promise.all(runs);
    expect(order).toEqual([1, 2, 3]);
    expect(__lockedCount()).toBe(0);
  });
});
