import { useCallback, useEffect, useRef, useState } from 'react';
import { requestDocumentProxy } from '../lib/pdfDocCache';
import { collectPdfjsFacts } from '../lib/doc-health-pdfjs';
import type { EngineHealthReply } from '../lib/doc-health-engine';
import {
  EMPTY_HEALTH_LEDGER,
  beginCollection,
  pruneHealthLedger,
  recordCollection,
  retireHealth,
  type HealthLedger,
} from '../lib/doc-health';
import type { OpenFile, PdfBuffer } from '../state/types';

// Collects the document-health ledger for every open document, once per set of
// bytes.
//
// WHEN: on settle — a file whose current buffer has no ledger row gets one,
// which covers open, reindex, undo/redo, whole-file ops and the page-tier
// commit alike, because every one of them replaces the buffer. A byte-only
// import source is never collected: it is not a document the user can act on
// (`showableFile`'s rule, applied here through `importOnly`).
//
// HOW THE ENGINE IS CALLED: through `useEngine`'s `collectHealth`, the idle
// lane's stepped sweep.
// The op is a passive, read-only lookup driven by every buffer change, so
// routing it through the commit gate would flush the user's pending page edits
// to disk merely because a document was opened. It is correct without the
// gate for the same reason that read is: the working copy on disk holds
// exactly `buffer` (page-tier edits touch neither until commit), and the row
// is filed under `buffer`, so the ledger and the bytes it describes cannot
// drift apart. This is not the `callRaw` exception — the target IS a workspace
// file. Skipping the queue is not enough on its own: the engine is one serial
// FIFO underneath it, so opening several documents would hand it one traversal
// per document and the user's next operation would wait behind all of them.
// The lane holds the invariant instead — one sweep at a time, submitted a
// bounded step at a time, and each step only while nothing interactive is
// outstanding.
//
// RUN IDENTITY is the pair (buffer, generation). Buffer identity alone cannot
// answer whether a run is still wanted: a re-check retires the row and starts
// again over the SAME bytes, so the superseded run would record its result
// onto the new row and the re-check would silently show the older sweep's
// answer. The generation is bumped per path by `recheck`; a run whose pair no
// longer matches is dropped, and the engine lane drops it before submitting it
// at all when it is superseded while queued.

export interface DocumentHealthApi {
  readonly ledger: HealthLedger;
  /** Discard one document's row and collect again for its current bytes. */
  readonly recheck: (path: string) => void;
}

/** `useEngine`'s stepped idle sweep. Resolves to `null` for a run the lane
 * dropped because `isCurrent` stopped holding — before it was submitted, or at
 * any step boundary within it. */
type IdleHealthCall = (
  file: string,
  isCurrent: () => boolean,
) => Promise<EngineHealthReply | null>;

interface StartedRun {
  readonly buffer: PdfBuffer;
  readonly generation: number;
}

export function useDocumentHealth(
  files: Map<string, OpenFile>,
  collectHealth: IdleHealthCall,
): DocumentHealthApi {
  const [ledger, setLedger] = useState<HealthLedger>(EMPTY_HEALTH_LEDGER);
  // The runs already started, keyed per path by the bytes and the generation
  // they were started for. State cannot serve as this guard: `beginCollection`
  // is queued, so two renders in one tick would both see an untracked row and
  // start twice.
  const started = useRef(new Map<string, StartedRun>());
  // Bumped per path by `recheck`, which is what makes a re-check over
  // unchanged bytes a DIFFERENT run from the one it supersedes.
  const generations = useRef(new Map<string, number>());
  // The live files map, for the currency question an in-flight run has to ask
  // after its await. The generation counter beside it is keyed PER PATH for
  // the same question: one shared counter would let any other document's
  // re-check bump it, and this run would then read itself as superseded and
  // never finish.
  const filesRef = useRef(files);
  filesRef.current = files;
  // Bumped by `recheck`. The collection effect keys off the files map, which a
  // re-check does not touch, so without this the retired row would simply stay
  // empty and the button would do nothing.
  const [recheckNonce, setRecheckNonce] = useState(0);

  useEffect(() => {
    const openPaths = new Set(files.keys());
    setLedger((prev) => pruneHealthLedger(prev, openPaths));
    for (const path of [...started.current.keys()]) {
      if (!openPaths.has(path)) started.current.delete(path);
    }
    for (const path of [...generations.current.keys()]) {
      if (!openPaths.has(path)) generations.current.delete(path);
    }
  }, [files]);

  useEffect(() => {
    for (const [path, f] of files) {
      if (f.importOnly || !f.buffer) continue;
      const buffer = f.buffer;
      const generation = generations.current.get(path) ?? 0;
      const prior = started.current.get(path);
      if (prior && prior.buffer === buffer && prior.generation === generation) continue;
      started.current.set(path, { buffer, generation });
      setLedger((prev) => beginCollection(prev, path, buffer));

      const isCurrent = () =>
        filesRef.current.get(path)?.buffer === buffer &&
        (generations.current.get(path) ?? 0) === generation;

      void (async () => {
        try {
          const parsed = await collectHealth(f.workingPath, isCurrent);
          // `null` is a run the lane abandoned part-way, and a run that
          // finished after being superseded describes a question nobody is
          // asking any more. Neither is evidence about the row standing now.
          if (parsed === null || !isCurrent()) return;
          setLedger((prev) =>
            recordCollection(
              prev,
              path,
              buffer,
              'engine',
              // Both halves, deliberately: a reply this build cannot parse and
              // a reply whose own status says the engine's traversals did not
              // finish are the same verdict, and it is not `collected`.
              parsed.ok && parsed.status === 'collected' ? 'collected' : 'failed',
              parsed.facts,
            ),
          );
        } catch {
          if (!isCurrent()) return;
          setLedger((prev) => recordCollection(prev, path, buffer, 'engine', 'failed', []));
        }
      })();

      void (async () => {
        try {
          // Currency is stated at the cache boundary, never assumed: handing
          // `getDocumentProxy` a superseded buffer would EVICT and DESTROY the
          // live proxy the canvas is drawing from.
          const proxy = await requestDocumentProxy(path, buffer, isCurrent);
          if (!proxy) return; // superseded — the newer generation's run covers it
          const facts = await collectPdfjsFacts(proxy);
          if (!isCurrent()) return;
          // A sweep that ended on `pdfjs.timeout` stopped at the page that
          // overran and read no page after it, so the pages it never reached
          // are unexamined rather than clean. Recording it as `collected`
          // would present that silence as a verdict.
          const finished = !facts.some((f) => f.code === 'pdfjs.timeout');
          setLedger((prev) =>
            recordCollection(
              prev,
              path,
              buffer,
              'pdfjs',
              finished ? 'collected' : 'failed',
              facts,
            ),
          );
        } catch {
          if (!isCurrent()) return;
          // pdf.js could not read these bytes at all. That is a verdict, and
          // it is `undetermined` — never an absence of findings.
          setLedger((prev) => recordCollection(prev, path, buffer, 'pdfjs', 'failed', []));
        }
      })();
    }
  }, [files, collectHealth, recheckNonce]);

  const recheck = useCallback(
    (path: string) => {
      generations.current.set(path, (generations.current.get(path) ?? 0) + 1);
      started.current.delete(path);
      setLedger((prev) => retireHealth(prev, path));
      setRecheckNonce((n) => n + 1);
    },
    [],
  );

  return { ledger, recheck };
}
