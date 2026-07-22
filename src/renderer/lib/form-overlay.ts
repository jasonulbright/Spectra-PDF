// On-canvas form overlay support (2n.4b): pure projection + pending-value
// bookkeeping, kept out of React so it unit-tests directly.
//
// The pdf.js render path bakes widget appearances as static pixels — there is
// no interactive AnnotationLayer, and none is added. The interactive surface
// is a PageCell overlay sibling in the same display-normalized 0..1 space as
// the annotation/redaction/signature overlays: each widget's PDF-space /Rect
// projects through pdfRectToDisplay at the page's BAKED rotation (this
// module), and PageCell re-projects by the in-memory rotation at render via
// rotateNormalizedRect — exactly the Find-word recipe.
//
// Pending values are name-keyed per file — deliberately NOT the positional-id
// lifecycle of redaction marks/selection: a field NAME is stable across page
// edits, commits, and unrelated whole-file ops, so half-typed values survive
// an Apply-changes (dropping them would punish routine edits). They are
// PRUNED against each re-read of the file's fields (name gone, no longer
// editable, or value shape no longer matches the field's type) and dropped
// with the file (a path absent from the read map). See the phase doc §2n.4(b).
import { pdfRectToDisplay } from './pdfx-build';
import type { FormField, FormFieldType, FormFieldValue } from './forms';

export interface OverlayWidget {
  path: string; // owning file (files-map key)
  fieldName: string;
  type: FormFieldType;
  // The field's CURRENT (on-disk) value — inputs seed from the pending value
  // when one exists, else this.
  value: FormFieldValue;
  // Display-normalized (0..1 of the page cell) at the page's BAKED
  // orientation; PageCell projects by the in-memory rotation at render.
  rect: { x: number; y: number; w: number; h: number };
  editable: boolean;
  readOnly: boolean;
  required: boolean;
  options?: string[];
  multiline?: boolean;
  radioOption?: string;
  sigFilled?: boolean;
}

export interface PageBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Project one field's widgets into per-page overlay entries. `box` and
// `bakedRotate` come from the CURRENT buffer's pdf.js page (the same
// geometry the raster renders with — crop-intersected view + baked /Rotate),
// per page index. Hidden widgets and degenerate rects are skipped: the
// raster shows nothing there, so the overlay must not offer an input.
export function projectFieldWidgets(
  path: string,
  field: FormField,
  geometryFor: (pageIndex: number) => { box: PageBox; bakedRotate: number } | null,
): Map<number, OverlayWidget[]> {
  const byPage = new Map<number, OverlayWidget[]>();
  if (field.type === 'button') return byPage; // never an overlay surface
  for (const w of field.widgets) {
    if (w.hidden) continue;
    const [x0, y0, x1, y1] = w.rect;
    if (x1 - x0 <= 0 || y1 - y0 <= 0) continue;
    const geo = geometryFor(w.pageIndex);
    if (!geo) continue;
    const rect = pdfRectToDisplay(w.rect, geo.box, geo.bakedRotate);
    if (rect.w <= 0 || rect.h <= 0) continue;
    const entry: OverlayWidget = {
      path,
      fieldName: field.name,
      type: field.type,
      value: field.value,
      rect,
      editable: field.editable,
      readOnly: field.readOnly,
      required: field.required,
      ...(field.options ? { options: field.options } : {}),
      ...(field.multiline !== undefined ? { multiline: field.multiline } : {}),
      ...(w.radioOption !== undefined ? { radioOption: w.radioOption } : {}),
      ...(field.type === 'signature' ? { sigFilled: field.filled ?? false } : {}),
    };
    const arr = byPage.get(w.pageIndex);
    if (arr) arr.push(entry);
    else byPage.set(w.pageIndex, [entry]);
  }
  return byPage;
}

// Whether a pending value's SHAPE is still compatible with the field it
// names — the type-level half of pruning (a text field swapped for a radio
// of the same name must not receive the old string blindly; the engine fill
// would route it through the wrong setter).
export function valueShapeMatches(type: FormFieldType, value: FormFieldValue): boolean {
  switch (type) {
    case 'text':
    case 'radio':
    case 'dropdown':
      return typeof value === 'string';
    case 'checkbox':
      return typeof value === 'boolean';
    case 'optionlist':
      return Array.isArray(value);
    default:
      return false; // button / signature — never fillable here
  }
}

// Whether a canvas placement can anchor to (or still trusts) the workspace's
// page ids for a path (2n.4c). Workspace documents carry the buffer they were
// indexed from; when the files map holds a NEWER buffer, a non-authored
// reindex is in flight and will mint a fresh id generation — a placement
// anchored to the current ids dies at SET_WORKSPACE_DOCUMENTS, and a create
// converting sourcePageIndex against the new bytes could land the field on
// the wrong page. Under CPU load that window is wide enough for a whole
// place→create pair to fall into (the 18-canvas-forms load flake), so both
// ends check: placement is refused while stale, create rejects if it became
// stale. Structural shapes so this stays a pure, directly-testable rule.
export function placementDocsCurrent(
  files: ReadonlyMap<string, { buffer: unknown }>,
  documents: readonly { path: string; buffer: unknown }[],
  path: string,
): boolean {
  const buffer = files.get(path)?.buffer;
  if (!buffer) return false;
  return documents.some((d) => d.path === path && d.buffer === buffer);
}

// ---- fill-target resolution across the gate commit ------------------------
// (review-caught HIGH) The fill's snapshot runs the commit gate, which can
// bake a PENDING IMPORT into the file — and the 2n.4(a) carry resolves
// field-name collisions by renaming (name -> name+1). A pending value typed
// against the target's own field, keyed by name alone, could then silently
// land on the IMPORTED document's same-named field. Values must follow the
// PHYSICAL field they were typed into, so each pending name is re-resolved
// against the post-commit fields by fingerprint: the field's type, options,
// and widget /Rects — user-space geometry the carry never moves (page
// indexes shift under imports, so they are deliberately excluded). An exact
// same-name+same-fingerprint match fills as-is (the universal no-import
// case); a unique fingerprint match under another name is the renamed same
// field (fill follows it); no match or an ambiguous match (two physically
// identical same-name fields, e.g. a form imported into a copy of itself)
// refuses loudly rather than guessing.

function fingerprintOf(field: FormField): string {
  const rects = field.widgets
    .map((w) => w.rect.map((v) => v.toFixed(1)).join(','))
    .sort()
    .join(';');
  // Options join on NUL (as the escape sequence — a literal NUL byte makes
  // git/grep treat the source as binary): options are free-form author text
  // that can contain spaces and pipes, so a printable delimiter could alias
  // two different option SETS into one fingerprint (the 2n.2 outlinesEqual
  // lesson). Worst case of any residual collision is an over-cautious
  // refusal, never a misfile — family scoping still gates every match.
  return `${field.type}|${(field.options ?? []).join('\u0000')}|${field.multiline ? 'm' : ''}|${rects}`;
}

export interface FillResolution {
  resolved: Record<string, FormFieldValue>;
  skipped: { name: string; reason: string }[];
}

export function resolveFillTargets(
  preFields: FormField[],
  postFields: FormField[],
  values: Record<string, FormFieldValue>,
): FillResolution {
  const preBy = new Map(preFields.map((f) => [f.name, f]));
  const postBy = new Map(postFields.map((f) => [f.name, f]));
  const resolved: Record<string, FormFieldValue> = {};
  const skipped: { name: string; reason: string }[] = [];

  const accept = (target: FormField, name: string, value: FormFieldValue): void => {
    if (!target.editable || !valueShapeMatches(target.type, value)) {
      skipped.push({ name, reason: 'the field is no longer fillable — re-enter the value' });
      return;
    }
    resolved[target.name] = value;
  };

  for (const [name, value] of Object.entries(values)) {
    const pre = preBy.get(name);
    if (!pre) {
      // No pre-commit read to fingerprint against (e.g. the buffer was
      // still settling) — a plain name match is all there is to go on.
      const post = postBy.get(name);
      if (post) accept(post, name, value);
      else skipped.push({ name, reason: 'the field no longer exists' });
      continue;
    }
    const fp = fingerprintOf(pre);
    // Candidates are scoped to the RENAME FAMILY — the name itself plus the
    // carry's name+N variants. A rename only ever moves within the family,
    // and an unrelated field that merely shares the fingerprint (the same
    // text box repeated on every page under different names is common) must
    // never capture the fill or spook it into refusing.
    const isFamilyName = (n: string): boolean =>
      n === name || (n.startsWith(`${name}+`) && /^\d+$/.test(n.slice(name.length + 1)));
    const family = postFields.filter((f) => isFamilyName(f.name) && fingerprintOf(f) === fp);
    if (family.length === 1) {
      // Same name (the universal case) or the commit's rename of the same
      // physical field — either way the fingerprint pins it.
      accept(family[0], name, value);
    } else if (family.length === 0) {
      skipped.push({ name, reason: 'the field changed while applying — re-enter the value' });
    } else {
      skipped.push({
        name,
        reason: 'two identical fields carry this name after a merge — re-enter the value',
      });
    }
  }
  return { resolved, skipped };
}

// Prune pending values against a fresh read of every open file's fields.
// Contract: `formsByPath` holds SETTLED reads for every path that may carry
// pending values (the hook keeps a file's previous read published while a
// re-read is in flight, so a transient gap can't wipe values typed before an
// unrelated commit). Paths absent from the map (closed files, byte-only
// import sources) drop entirely. Returns the same map instance when nothing
// changed, so effect consumers don't churn.
export function pruneFormValues(
  pending: ReadonlyMap<string, ReadonlyMap<string, FormFieldValue>>,
  formsByPath: ReadonlyMap<string, FormField[]>,
): ReadonlyMap<string, ReadonlyMap<string, FormFieldValue>> {
  let changed = false;
  const next = new Map<string, ReadonlyMap<string, FormFieldValue>>();
  for (const [path, values] of pending) {
    const fields = formsByPath.get(path);
    if (!fields) {
      changed = true; // file gone (or never an overlay surface) — drop
      continue;
    }
    const byName = new Map(fields.map((f) => [f.name, f]));
    const kept = new Map<string, FormFieldValue>();
    for (const [name, value] of values) {
      const field = byName.get(name);
      if (!field || !field.editable || !valueShapeMatches(field.type, value)) {
        changed = true;
        continue;
      }
      kept.set(name, value);
    }
    if (kept.size > 0) next.set(path, kept);
    else if (values.size > 0) changed = true;
  }
  return changed ? next : pending;
}
