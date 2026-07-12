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
// of the same name must not receive the old string blindly; fillFormFields
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
