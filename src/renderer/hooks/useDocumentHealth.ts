import { useCallback, useEffect, useRef, useState } from 'react';
import { requestDocumentProxy } from '../lib/pdfDocCache';
import { collectPdfjsFacts } from '../lib/doc-health-pdfjs';
import { parseEngineHealth } from '../lib/doc-health-engine';
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
// HOW THE ENGINE IS CALLED: through `useEngine`'s `call`, with
// `document_health` registered INTERNAL — the `read_form_fields` precedent.
// The op is a passive, read-only lookup driven by every buffer change, so
// routing it through the commit gate would flush the user's pending page edits
// to disk merely because a document was opened. It is correct without the
// gate for the same reason that read is: the working copy on disk holds
// exactly `buffer` (page-tier edits touch neither until commit), and the row
// is filed under `buffer`, so the ledger and the bytes it describes cannot
// drift apart. This is not the `callRaw` exception — the target IS a workspace
// file, and it goes through `call`.
//
// A run whose result lands after the file's bytes changed is dropped by the
// ledger itself (`recordCollection` checks buffer identity), so a slow sweep
// can never write evidence about dead bytes onto a live row.

export interface DocumentHealthApi {
  readonly ledger: HealthLedger;
  /** Discard one document's row and collect again for its current bytes. */
  readonly recheck: (path: string) => void;
}

type EngineCall = (
  method: string,
  params?: Record<string, unknown>,
) => Promise<unknown>;

export function useDocumentHealth(
  files: Map<string, OpenFile>,
  call: EngineCall,
): DocumentHealthApi {
  const [ledger, setLedger] = useState<HealthLedger>(EMPTY_HEALTH_LEDGER);
  // The runs already started, keyed per path by the bytes they were started
  // for. State cannot serve as this guard: `beginCollection` is queued, so two
  // renders in one tick would both see an untracked row and start twice.
  const started = useRef(new Map<string, PdfBuffer>());
  // The live files map, for the currency question an in-flight run has to ask
  // after its await. A generation counter cannot answer it: any OTHER
  // document's re-check would bump one, and this run would then read itself as
  // superseded and never finish.
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
  }, [files]);

  useEffect(() => {
    for (const [path, f] of files) {
      if (f.importOnly || !f.buffer) continue;
      const buffer = f.buffer;
      if (started.current.get(path) === buffer) continue;
      started.current.set(path, buffer);
      setLedger((prev) => beginCollection(prev, path, buffer));

      void (async () => {
        try {
          const reply = await call('document_health', { file: f.workingPath });
          const parsed = parseEngineHealth(reply);
          setLedger((prev) =>
            recordCollection(
              prev,
              path,
              buffer,
              'engine',
              parsed.ok ? 'collected' : 'failed',
              parsed.facts,
            ),
          );
        } catch {
          setLedger((prev) => recordCollection(prev, path, buffer, 'engine', 'failed', []));
        }
      })();

      void (async () => {
        try {
          // Currency is stated at the cache boundary, never assumed: handing
          // `getDocumentProxy` a superseded buffer would EVICT and DESTROY the
          // live proxy the canvas is drawing from.
          const proxy = await requestDocumentProxy(
            path,
            buffer,
            () => filesRef.current.get(path)?.buffer === buffer,
          );
          if (!proxy) return; // superseded — the newer generation's run covers it
          const facts = await collectPdfjsFacts(proxy);
          setLedger((prev) => recordCollection(prev, path, buffer, 'pdfjs', 'collected', facts));
        } catch {
          // pdf.js could not read these bytes at all. That is a verdict, and
          // it is `undetermined` — never an absence of findings.
          setLedger((prev) => recordCollection(prev, path, buffer, 'pdfjs', 'failed', []));
        }
      })();
    }
  }, [files, call, recheckNonce]);

  const recheck = useCallback(
    (path: string) => {
      started.current.delete(path);
      setLedger((prev) => retireHealth(prev, path));
      setRecheckNonce((n) => n + 1);
    },
    [],
  );

  return { ledger, recheck };
}
