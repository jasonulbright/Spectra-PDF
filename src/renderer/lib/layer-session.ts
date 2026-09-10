import { PDFArray, PDFDict, PDFDocument, PDFName, PDFObject, PDFRawStream, PDFRef } from 'pdf-lib';
import type { AppState, OpenFile, PdfBuffer } from '../state/types';
import type { PerformOperation } from '../hooks/useOperations';
import type { EngineCall } from './engine-call';
import type { ProcessingStep } from './processing-steps';
import { EDIT_DECLINED } from './edit-text';
import { tChrome } from '../i18n';

export interface Layer { index: number; name: string; visible: boolean; locked: boolean; processing_step: ProcessingStep | null }
const invalid = () => new Error(tChrome('app.operation.unverified'));
const changed = () => new Error(tChrome('app.history.changed'));
export function parseLayerRead(reply: unknown): Layer[] {
  const r = reply as { complete?: unknown; count?: unknown; layers?: unknown; processing_step_count?: unknown } | null;
  if (!r || r.complete !== true || !Array.isArray(r.layers) || r.count !== r.layers.length || r.layers.length > 10000) throw invalid();
  const rows: Layer[] = r.layers.map((l, i) => {
    if (!l || l.index !== i || typeof l.name !== 'string' || typeof l.visible !== 'boolean' || typeof l.locked !== 'boolean'
        || l.processing_step !== null && (!l.processing_step || !['group', 'type', 'status', 'page_element'].every(k => typeof l.processing_step[k] === 'string'))) throw invalid();
    return { index: i, name: l.name, visible: l.visible, locked: l.locked, processing_step: l.processing_step && { ...l.processing_step } };
  });
  if (r.processing_step_count !== rows.filter(l => l.processing_step).length) throw invalid();
  return rows;
}

/** A resource position on a proven surviving page, not a name, binds an OCG.
 * Annotations may be replaced during commit, so they are deliberately not
 * evidence. Missing, many-to-one or inconsistent bindings refuse. */
export async function remapLayerIndex(before: PdfBuffer, after: PdfBuffer, index: number, pairs: [number, number][]): Promise<number> {
  const [src, dst] = await Promise.all([PDFDocument.load(new Uint8Array(before)), PDFDocument.load(new Uint8Array(after))]), N = PDFName.of;
  const groups = (pdf: PDFDocument) => pdf.catalog.lookup(N('OCProperties'), PDFDict).lookup(N('OCGs'), PDFArray).asArray();
  const old = groups(src), next = groups(dst);
  if (old.some(r => !(r instanceof PDFRef)) || next.some(r => !(r instanceof PDFRef)) || !old[index]) throw changed();
  const oldIds = new Set(old.map(r => r.toString())), nextIds = new Set(next.map(r => r.toString()));
  const bindings = new Map<string, Set<string>>(), owners = new Map<string, Set<string>>(), seen = new Set<string>(); let budget = 20000;
  const walk = (a: PDFObject | undefined, b: PDFObject | undefined, depth = 0): void => {
    if (--budget < 0 || depth > 64) throw changed();
    if (a instanceof PDFRef && oldIds.has(a.tag)) {
      if (!(b instanceof PDFRef) || !nextIds.has(b.tag)) throw changed();
      const values = bindings.get(a.tag) ?? new Set<string>(); values.add(b.tag); bindings.set(a.tag, values);
      const sources = owners.get(b.tag) ?? new Set<string>(); sources.add(a.tag); owners.set(b.tag, sources); return;
    }
    if (a instanceof PDFRef && b instanceof PDFRef) { const key = `${a.tag}:${b.tag}`; if (seen.has(key)) return; seen.add(key); }
    const av = a instanceof PDFRef ? src.context.lookup(a) : a, bv = b instanceof PDFRef ? dst.context.lookup(b) : b;
    if (av instanceof PDFRawStream && bv instanceof PDFRawStream) { walk(av.dict, bv.dict, depth + 1); return; }
    if (av instanceof PDFDict && bv instanceof PDFDict) {
      for (const [key, value] of av.entries()) if (!['Parent', 'P'].includes(key.decodeText())) walk(value, bv.get(key), depth + 1);
    } else if (av instanceof PDFArray && bv instanceof PDFArray) {
      if (av.size() !== bv.size()) throw changed();
      av.asArray().forEach((value, i) => walk(value, bv.get(i), depth + 1));
    } else if (av instanceof PDFDict || av instanceof PDFArray || av instanceof PDFRawStream) throw changed();
  };
  for (const [oldPage, newPage] of pairs) walk(src.getPage(oldPage).node.Resources(), dst.getPage(newPage).node.Resources());
  const matches = bindings.get(old[index].toString()); if (matches?.size !== 1) throw changed();
  const target = [...matches][0]; if (owners.get(target)?.size !== 1) throw changed();
  return next.findIndex(r => r.toString() === target);
}

export interface LayerSession { path: string; workingPath: string; buffer: PdfBuffer | null; layers: Layer[];
  loaded: boolean; loading: object | null; busy: boolean; error: string; status: string }
export function createLayerSessions(readState: () => AppState) {
  const entries = new Map<string, LayerSession>(), listeners = new Set<() => void>(); let version = 0;
  const notify = () => { version++; for (const fn of listeners) fn(); };
  const live = (s: LayerSession) => entries.get(s.workingPath) === s && readState().files.get(s.path)?.workingPath === s.workingPath;
  const at = (s: LayerSession, buffer = s.buffer) => live(s) && !!buffer && readState().files.get(s.path)?.buffer === buffer;
  const reconcile = () => { let removed = false; for (const [key, s] of entries) if (!live(s)) { entries.delete(key); removed = true; } if (removed) notify(); };
  const get = (file: OpenFile | null) => {
    if (!file?.buffer || file.importOnly || readState().files.get(file.path)?.workingPath !== file.workingPath) return null;
    let s = entries.get(file.workingPath);
    if (!s || s.path !== file.path) { s = { path: file.path, workingPath: file.workingPath, buffer: null, layers: [], loaded: false,
      loading: null, busy: false, error: '', status: '' }; entries.set(file.workingPath, s); } return s;
  };
  const load = async (s: LayerSession, call: EngineCall) => {
    if (!live(s) || s.busy || s.loading || s.error || s.loaded && at(s)) return;
    const buffer = readState().files.get(s.path)?.buffer; if (!buffer) return;
    const token = {}; s.loading = token; notify();
    const accepts = () => at(s, buffer) && s.loading === token && !readState().pageDirtyPaths.includes(s.path);
    try { const reply = await call('list_layers', { file: s.workingPath, for_edit: true }); if (!accepts()) return;
      s.layers = parseLayerRead(reply); s.buffer = buffer; s.loaded = true; s.status = '';
    } catch (e) { if (accepts()) { s.loaded = false; s.error = e instanceof Error ? e.message : String(e); } }
    finally { if (live(s) && s.loading === token) { s.loading = null; notify(); } }
  };
  const cancelLoad = (s: LayerSession) => { if (live(s) && s.loading) { s.loading = null; notify(); } };
  const toggle = async (s: LayerSession, layer: Layer, buffer: PdfBuffer | null, operation: PerformOperation, call: EngineCall, commit: () => Promise<void>) => {
    if (!live(s) || s.busy) return;
    s.busy = true; s.error = ''; s.status = ''; notify();
    try {
      if (!s.loaded || !at(s, buffer) || s.buffer !== buffer || s.layers[layer.index] !== layer || layer.locked) throw changed();
      const byId = new Map<string, number>();
      for (const doc of readState().workspace.documents) if (doc.buffer === buffer) for (const page of doc.pages) if (page.sourceDocId === s.path) {
        if (byId.has(page.id)) throw changed(); byId.set(page.id, page.sourcePageIndex);
      }
      await commit(); if (!live(s) || readState().pageDirtyPaths.includes(s.path)) throw changed();
      const file = readState().files.get(s.path)!; let index = layer.index;
      if (file.buffer !== buffer) {
        const edge = file.authoredIdentity;
        if (!edge || edge.sourceBuffer !== buffer || edge.buffer !== file.buffer || edge.pages.length !== file.pageCount
            || new Set(edge.pages).size !== edge.pages.length || edge.pages.some(id => !byId.has(id))) throw changed();
        index = await remapLayerIndex(buffer!, file.buffer!, index, edge.pages.map((id, i) => [byId.get(id)!, i]));
        const rows = parseLayerRead(await call('list_layers', { file: s.workingPath, for_edit: true }));
        if (!at(s, file.buffer) || readState().pageDirtyPaths.includes(s.path)) throw changed();
        const mapped = rows[index];
        if (!mapped || JSON.stringify({ ...mapped, index: layer.index }) !== JSON.stringify(layer)) throw changed();
        s.layers = rows; s.buffer = file.buffer; notify();
      }
      const result = await operation(s.path, 'set_layer_visibility', { index, visible: !layer.visible },
        { expectedWorkingPath: s.workingPath, expectedBuffer: s.buffer! });
      if (!live(s) || result === EDIT_DECLINED || result === null) return;
      if (!result.publication?.buffer || result.publication.path !== s.path || result.publication.workingPath !== s.workingPath) throw invalid();
      s.loaded = false; s.buffer = result.publication.buffer;
    } catch (e) { if (live(s)) s.error = e instanceof Error ? e.message : String(e); }
    finally { if (live(s)) { s.busy = false; notify(); } }
  };
  const retry = (s: LayerSession) => { if (live(s) && !s.busy) { s.error = ''; s.loaded = false; s.loading = null; notify(); } };
  return { get, at, reconcile, load, cancelLoad, toggle, retry,
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; }, snapshot: () => version };
}
export type LayerSessions = ReturnType<typeof createLayerSessions>;
