// Live field scripting for the on-canvas fill: one sandbox session per open
// document that carries a custom script, driven by the same gestures the
// declarative evaluator already answers.
//
// The values it produces are DERIVED, exactly like the declarative pass's:
// they are layered over what the user typed for drawing and are not written
// into the pending map, because the fill names what that map holds and a
// script-computed Total is routinely read-only.
//
// ONE exception, and it is the point of the phase split: the answer for the
// field the gesture itself touched IS written back, because the document can
// refuse or rewrite what the user entered. A refused keystroke restores the
// pre-change text and a refused commit clears the field; leaving the typed
// characters in the pending map would apply a value the document's own
// validation turned down while the canvas drew something else.
import { useCallback, useEffect, useRef, useState } from 'react';
import { buildSeed, createFieldScriptSession, describeChange } from '../lib/field-js-host';
import type {
  DispatchResult,
  FieldScriptSession,
  FieldScriptWorkerFactory,
} from '../lib/field-js-host';
import { JS_TRIGGERS, fieldNameSet, isDeclarative, scriptInventory } from '../lib/field-js-policy';
import type { JsTrigger } from '../lib/field-js-policy';
import { clearScriptReports, publishScriptReports } from '../lib/field-js-reports';
import type { EngineCall } from '../lib/engine-call';
import type { FormField, FormFieldValue } from '../lib/forms';
import type { FileFormInfo } from './useWorkspaceForms';

/** The staged pdf.js asset tree — the same base `pdfRenderer.ts` resolves, and
 * for the same reason: the URL must be absolute, because the worker's own base
 * is a hashed chunk under `assets/`. */
function wasmBase(): string {
  return new URL('pdfjs/wasm/', document.baseURI).href;
}

interface SessionEntry {
  session: FieldScriptSession;
  fields: readonly FormField[];
  /** The document carries `/Names /JavaScript` helpers, which any field's
   * gesture can reach — so every field in it is dispatchable, not only the
   * ones carrying a custom `/AA` body of their own. */
  hasDocumentScripts: boolean;
}

export interface FieldScriptRunner {
  /** Values the document's own scripts computed, by path and field name. */
  values: ReadonlyMap<string, ReadonlyMap<string, FormFieldValue>>;
  /** Display strings a Format action produced, by path and field name. */
  formatted: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** A character was typed and NOT committed. The AcroForm event model runs
   * the keystroke script alone here — validate, calculate and format belong to
   * the commit — so a rejecting Validate cannot blank the field mid-word. */
  keystroke: (path: string, fieldName: string, prev: string, next: string) => void;
  /** A value was committed into a field — run the document's scripts for it. */
  commit: (path: string, fieldName: string, value: FormFieldValue) => void;
  /** `/Fo` and `/Bl`. Their corpus-dominant use is appearance, which the
   * vendored object model keeps in-memory; see the design doc's boundary. */
  focus: (path: string, fieldName: string, value: FormFieldValue) => void;
  blur: (path: string, fieldName: string, value: FormFieldValue) => void;
}

const EMPTY: ReadonlyMap<string, ReadonlyMap<string, never>> = new Map();

export interface UseFieldScriptsOptions {
  enabled: boolean;
  /** The on-disk copy to read document-level scripts from — the working copy,
   * never the user's original. */
  workingPathFor?: (path: string) => string | undefined;
  onAlert?: (text: string) => void;
  /** The document's own page count, for `this.numPages` and any arithmetic a
   * script does over it. */
  numPagesFor?: (path: string) => number | undefined;
  /** The document refused or rewrote what the user entered: the pending map
   * the fill names must be corrected, or Apply writes a value the document's
   * own validation rejected. Only ever called for the field the gesture
   * touched — every other field the scripts compute stays derived. */
  onCorrectValue?: (path: string, fieldName: string, value: FormFieldValue) => void;
  makeWorker?: FieldScriptWorkerFactory;
  timeoutMs?: number;
}

export function useFieldScripts(
  workspaceForms: ReadonlyMap<string, FileFormInfo>,
  call: EngineCall,
  options: UseFieldScriptsOptions,
): FieldScriptRunner {
  const {
    enabled,
    onAlert,
    makeWorker,
    timeoutMs,
    workingPathFor,
    numPagesFor,
    onCorrectValue,
  } = options;
  const sessions = useRef(new Map<string, SessionEntry>());
  const [values, setValues] = useState<ReadonlyMap<string, ReadonlyMap<string, FormFieldValue>>>(
    EMPTY as ReadonlyMap<string, ReadonlyMap<string, FormFieldValue>>,
  );
  const [formatted, setFormatted] = useState<ReadonlyMap<string, ReadonlyMap<string, string>>>(
    EMPTY as ReadonlyMap<string, ReadonlyMap<string, string>>,
  );
  const alertRef = useRef(onAlert);
  alertRef.current = onAlert;
  const workingPathRef = useRef(workingPathFor);
  workingPathRef.current = workingPathFor;
  const numPagesRef = useRef(numPagesFor);
  numPagesRef.current = numPagesFor;
  const correctRef = useRef(onCorrectValue);
  correctRef.current = onCorrectValue;

  // A session belongs to ONE read of ONE document: the seed carries the
  // document's fields and its /CO, so a re-read (new bytes, a commit, a
  // rename) invalidates every value the old sandbox holds. Rebuilding is
  // cheaper to reason about than reconciling, and a document with no custom
  // script never builds one at all.
  useEffect(() => {
    if (!enabled) {
      for (const [path, entry] of sessions.current) {
        entry.session.dispose();
        clearScriptReports(path);
      }
      sessions.current.clear();
      setValues(EMPTY as ReadonlyMap<string, ReadonlyMap<string, FormFieldValue>>);
      setFormatted(EMPTY as ReadonlyMap<string, ReadonlyMap<string, string>>);
      return;
    }
    let alive = true;
    for (const [path, entry] of [...sessions.current]) {
      const info = workspaceForms.get(path);
      if (!info || info.fields !== entry.fields) {
        entry.session.dispose();
        sessions.current.delete(path);
        clearScriptReports(path);
      }
    }
    void (async () => {
      for (const [path, info] of workspaceForms) {
        if (sessions.current.has(path)) continue;
        const inventory = scriptInventory(info.fields);
        let documentScripts: string[];
        try {
          const target = workingPathRef.current?.(path) ?? path;
          const res = (await call('list_document_js', { file: target })) as unknown as {
            scripts?: { name: string; js: string }[];
          };
          documentScripts = (res?.scripts ?? []).map((s) => s.js);
        } catch {
          // A document whose name tree cannot be read carries no helpers this
          // run can call; the field scripts still run without them.
          documentScripts = [];
        }
        if (!alive) return;
        if (inventory.custom.length === 0 && documentScripts.length === 0) continue;
        if (sessions.current.has(path)) continue;
        const session = createFieldScriptSession({
          seed: buildSeed({
            fields: info.fields,
            calculationOrder: info.calculation.order,
            documentScripts,
            numPages: numPagesRef.current?.(path) ?? 1,
            filename: path,
            language: 'en-US',
          }),
          wasmUrl: wasmBase(),
          ...(makeWorker ? { makeWorker } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          bodies: inventory.custom.map((e) => ({
            field: e.field,
            trigger: e.trigger,
            js: e.js,
          })),
        });
        sessions.current.set(path, {
          session,
          fields: info.fields,
          hasDocumentScripts: documentScripts.length > 0,
        });
        // The document `Open` event evaluates the document-level declarations
        // and runs the initial format pass. It has to happen before any field
        // gesture, or a field action calls a helper that does not exist yet.
        const result = await session.open();
        if (!alive) return;
        publishScriptReports(path, result.reports);
        for (const text of result.alerts) alertRef.current?.(text);
      }
    })();
    return () => {
      alive = false;
    };
  }, [workspaceForms, enabled, call, makeWorker, timeoutMs]);

  // Unmount: the worker outlives React otherwise.
  useEffect(() => {
    const live = sessions.current;
    return () => {
      for (const entry of live.values()) entry.session.dispose();
      live.clear();
    };
  }, []);

  /** One gesture, dispatched and folded back in. `gestured` is what the user's
   * own action put into the pending map for `fieldName`, or undefined for a
   * gesture that changed no value (focus, blur) — when the document answers
   * with something else for that field, the pending map is corrected to it. */
  const run = useCallback(
    (
      path: string,
      fieldName: string,
      gestured: FormFieldValue | undefined,
      dispatch: (session: FieldScriptSession) => Promise<DispatchResult>,
    ): Promise<FormFieldValue | undefined> => {
      const entry = sessions.current.get(path);
      if (!entry) return Promise.resolve(undefined);
      let accepted: FormFieldValue | undefined;
      return dispatch(entry.session).then((result) => {
        publishScriptReports(path, result.reports);
        for (const text of result.alerts) alertRef.current?.(text);
        if (gestured !== undefined) {
          // The object model answers for the field the gesture touched with
          // what the document actually accepted: the merged keystroke, the
          // pre-change text a refused keystroke restores, or the empty value a
          // refused commit clears to. That answer, not what was typed, is what
          // the fill must name.
          const answered = result.values.get(fieldName);
          const settled = result.rejected.has(fieldName) ? '' : answered;
          if (settled !== undefined && settled !== gestured) {
            correctRef.current?.(path, fieldName, settled);
          }
          if (settled !== undefined) accepted = settled;
        }
        if (result.values.size > 0) {
          setValues((prev) => {
            const next = new Map(prev);
            const inner = new Map(next.get(path) ?? []);
            for (const [name, v] of result.values) inner.set(name, v);
            if (result.rejected.has(fieldName)) inner.set(fieldName, '');
            next.set(path, inner);
            return next;
          });
        }
        if (result.formatted.size > 0) {
          setFormatted((prev) => {
            const next = new Map(prev);
            const inner = new Map(next.get(path) ?? []);
            for (const [name, v] of result.formatted) inner.set(name, v);
            next.set(path, inner);
            return next;
          });
        }
        return accepted;
      });
    },
    [],
  );

  // A keystroke's answer is what the field HOLDS, and a commit that arrives
  // before that answer has to commit it rather than the text the gesture
  // started from — otherwise a fast blur (or a harness that types and commits
  // in one call) discards what the document's own keystroke script produced.
  const inFlight = useRef(new Map<string, Promise<FormFieldValue | undefined>>());

  /** Whether this field is one the sandbox owns. A field whose every script is
   * declarative is `af-calc`'s — dispatching it here would run the calculate
   * pass under two evaluators — but a document-level helper can still drive
   * any field, so a document that carries one dispatches for all of them. */
  const dispatchable = useCallback((path: string, fieldName: string): boolean => {
    const entry = sessions.current.get(path);
    if (!entry) return false;
    const field = entry.fields.find((f) => f.name === fieldName);
    if (!field) return entry.hasDocumentScripts;
    if (entry.hasDocumentScripts) return true;
    const names = fieldNameSet(entry.fields);
    return JS_TRIGGERS.some((t) => {
      const js = field.actions?.[t as JsTrigger];
      return typeof js === 'string' && js.trim() !== '' && !isDeclarative(js, names);
    });
  }, []);

  const keystroke = useCallback(
    (path: string, fieldName: string, prev: string, next: string): void => {
      if (!dispatchable(path, fieldName)) return;
      const { change, selStart, selEnd } = describeChange(prev, next);
      const key = `${path} ${fieldName}`;
      const settled = run(path, fieldName, next, (session) =>
        session.keystroke(fieldName, prev, change, selStart, selEnd),
      );
      inFlight.current.set(key, settled);
      void settled.finally(() => {
        if (inFlight.current.get(key) === settled) inFlight.current.delete(key);
      });
    },
    [dispatchable, run],
  );

  const commit = useCallback(
    (path: string, fieldName: string, value: FormFieldValue): void => {
      if (!dispatchable(path, fieldName)) return;
      const waiting = inFlight.current.get(`${path} ${fieldName}`);
      if (!waiting) {
        void run(path, fieldName, value, (session) => session.commit(fieldName, value));
        return;
      }
      void waiting.then((settled) => {
        const committed = settled ?? value;
        void run(path, fieldName, committed, (session) =>
          session.commit(fieldName, committed),
        );
      });
    },
    [dispatchable, run],
  );

  const focus = useCallback(
    (path: string, fieldName: string, value: FormFieldValue): void => {
      if (!dispatchable(path, fieldName)) return;
      void run(path, fieldName, undefined, (session) => session.focus(fieldName, value));
    },
    [dispatchable, run],
  );

  const blur = useCallback(
    (path: string, fieldName: string, value: FormFieldValue): void => {
      if (!dispatchable(path, fieldName)) return;
      void run(path, fieldName, undefined, (session) => session.blur(fieldName, value));
    },
    [dispatchable, run],
  );

  return { values, formatted, keystroke, commit, focus, blur };
}
