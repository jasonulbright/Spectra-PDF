// Carries AcroForm structure through the from-scratch rebuild in pdfx-build.ts.
//
// pdf-lib's copyPages copies each page's object subtree — widget annotations
// included, so form fields keep RENDERING via their /AP pixels — but NOT the
// document-level /AcroForm. Without this module, any committed page edit on a
// form PDF (one rotation suffices) orphans every field: getForm() sees
// nothing, nothing is fillable, every /V is semantically lost. Verified by
// experiment before this was built; design in
// docs/architecture/16-phase2n-canvas-completeness.md § 2n.4(a).
//
// Three-phase contract with the builder:
//   1. prepareSourceForms(source, keptIndices) — on the PRIVATE per-build
//      source instance, BEFORE copyPages: tags every genuine field root (a
//      direct /AcroForm /Fields entry) with a transient marker, and prunes
//      field trees to widgets on kept pages. The prune is not an optimization:
//      the deep copy follows root → /Kids → widget → /P, so an unpruned kid
//      widget on a dropped page would drag a full orphan copy of that page
//      (content streams included) into the output.
//   2. The builder copies each source's kept pages in ONE copyPages call —
//      pdf-lib's object copier caches per call, so a field tree shared by
//      widgets on several kept pages copies once; per-page calls would
//      duplicate the root and fork same-name fields.
//   3. carryAcroForm(output, contributions) — walks the copied pages' widget
//      annotations up their /Parent chains to the marked roots, rebuilds the
//      output /AcroForm (/Fields, merged /DR, /DA, /Q, /SigFlags,
//      /NeedAppearances), resolves cross-source name and resource collisions,
//      and removes the markers. No marked root anywhere -> no /AcroForm is
//      added (a non-form rebuild stays byte-clean).
//
// Documented boundaries (deliberate): /XFA does not survive a rebuild (the
// app's pure-AcroForm posture since 2f — every fill output already strips
// it); document-level form scripts (/CO, /AA) do not survive page-structure
// rebuilds — carrying blind references through arbitrary page surgery is
// worse than dropping them. Field-level keys (incl. per-field /AA) travel
// with the field objects untouched. /SigFlags bit 1 (SignaturesExist) is
// recomputed from the kept fields; bit 2 (AppendOnly) is dropped — its
// precondition, an unbroken signature, cannot survive a rebuild.
import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObjectCopier,
  PDFPage,
  PDFRef,
  PDFString,
} from 'pdf-lib';

// Transient root marker. Set on source /Fields entries so the output-side
// walk can tell a genuine field root from an orphan widget chain (a widget
// that renders but was never registered under /AcroForm must stay an orphan
// — resurrecting it would invent fields the source never exposed). Removed
// from every output dict before the builder saves.
const ROOT_MARKER = PDFName.of('SpectraFieldRoot');

const NAME_PARENT = PDFName.of('Parent');
const NAME_KIDS = PDFName.of('Kids');
const NAME_SUBTYPE = PDFName.of('Subtype');
const NAME_WIDGET = PDFName.of('Widget');
const NAME_ANNOTS = PDFName.of('Annots');
const NAME_FIELDS = PDFName.of('Fields');
const NAME_ACROFORM = PDFName.of('AcroForm');
const NAME_DR = PDFName.of('DR');
const NAME_DA = PDFName.of('DA');
const NAME_Q = PDFName.of('Q');
const NAME_T = PDFName.of('T');
const NAME_FT = PDFName.of('FT');
const NAME_SIG = PDFName.of('Sig');
const NAME_P = PDFName.of('P');
const NAME_SIGFLAGS = PDFName.of('SigFlags');
const NAME_NEEDAPPEARANCES = PDFName.of('NeedAppearances');
const NAME_BASEFONT = PDFName.of('BaseFont');
const NAME_ENCODING = PDFName.of('Encoding');
const NAME_FONTDESCRIPTOR = PDFName.of('FontDescriptor');

// Defensive cap on /Parent / /Kids recursion — matches the field-tree depth
// cap posture in engine/forms.py (MAX_FIELD_DEPTH).
const MAX_DEPTH = 32;

export interface FormContribution {
  /** The private, already-prepared source document this build copied from. */
  source: PDFDocument;
  /** Every page copied out of that source, as it sits in the output. */
  copiedPages: PDFPage[];
}

function asDict(doc: PDFDocument, value: unknown): PDFDict | null {
  if (value instanceof PDFRef) {
    const resolved = doc.context.lookup(value);
    return resolved instanceof PDFDict ? resolved : null;
  }
  return value instanceof PDFDict ? value : null;
}

function asArray(doc: PDFDocument, value: unknown): PDFArray | null {
  if (value instanceof PDFRef) {
    const resolved = doc.context.lookup(value);
    return resolved instanceof PDFArray ? resolved : null;
  }
  return value instanceof PDFArray ? value : null;
}

// Resolve one level of indirection, returning whatever the entry actually is
// (undefined stays undefined) — for values whose TYPE matters, like /Encoding
// being a simple name vs a dict.
function resolveDirect(doc: PDFDocument, value: unknown): unknown {
  return value instanceof PDFRef ? doc.context.lookup(value) : value;
}

function acroFormOf(doc: PDFDocument): PDFDict | null {
  try {
    return asDict(doc, doc.catalog.get(NAME_ACROFORM));
  } catch {
    return null;
  }
}

function isWidget(dict: PDFDict): boolean {
  return dict.get(NAME_SUBTYPE) === NAME_WIDGET;
}

/**
 * Tag genuine field roots and prune field trees to the kept pages, on the
 * PRIVATE source instance, before copyPages. Returns true when the source
 * has any form field at all (so callers can skip work for the common
 * non-form file).
 *
 * Keep rules:
 * - A widget is kept iff its /P is a kept page OR it appears in a kept
 *   page's /Annots (union — visible-anywhere wins; /P is optional).
 * - An interior node is kept iff any child survives; its /Kids array is
 *   pruned in place.
 * - A widget-less terminal (a pure-data field with no visual presence on any
 *   page) is kept: it loses nothing by the page edit, and dropping it would
 *   silently discard its /V.
 * - A root whose every widget sat on dropped pages is dropped with them —
 *   what-you-see-is-what-you-keep, same posture as Acrobat's page extract.
 */
export function prepareSourceForms(source: PDFDocument, keptIndices: number[]): boolean {
  const acro = acroFormOf(source);
  if (!acro) return false;
  const fields = asArray(source, acro.get(NAME_FIELDS));
  if (!fields || fields.size() === 0) return false;

  const kept = new Set(keptIndices);
  const pageRefTags = new Set<string>();
  const annotRefTags = new Set<string>();
  const pageCount = source.getPageCount();
  for (let i = 0; i < pageCount; i++) {
    if (!kept.has(i)) continue;
    const page = source.getPage(i);
    pageRefTags.add(page.ref.tag);
    const annots = asArray(source, page.node.get(NAME_ANNOTS));
    if (!annots) continue;
    for (let j = 0; j < annots.size(); j++) {
      const entry = annots.get(j);
      if (entry instanceof PDFRef) annotRefTags.add(entry.tag);
    }
  }
  const allKept = kept.size >= pageCount;

  const widgetKept = (ref: PDFRef | null, dict: PDFDict): boolean => {
    const p = dict.get(NAME_P);
    if (p instanceof PDFRef && pageRefTags.has(p.tag)) return true;
    return ref !== null && annotRefTags.has(ref.tag);
  };

  // Returns whether this node survives; prunes its /Kids in place.
  const surviveNode = (entry: unknown, depth: number): boolean => {
    if (depth > MAX_DEPTH) return false; // malformed/cyclic tree — fail toward dropping
    const ref = entry instanceof PDFRef ? entry : null;
    const dict = asDict(source, entry);
    if (!dict) return false;
    const kids = asArray(source, dict.get(NAME_KIDS));
    if (kids && kids.size() > 0) {
      let any = false;
      for (let i = kids.size() - 1; i >= 0; i--) {
        if (surviveNode(kids.get(i), depth + 1)) any = true;
        else kids.remove(i);
      }
      return any;
    }
    if (isWidget(dict)) return widgetKept(ref, dict);
    return true; // widget-less pure-data terminal — keep
  };

  for (let i = fields.size() - 1; i >= 0; i--) {
    const entry = fields.get(i);
    const survives = allKept ? true : surviveNode(entry, 0);
    if (!survives) {
      fields.remove(i);
      continue;
    }
    const dict = asDict(source, entry);
    if (dict) dict.set(ROOT_MARKER, PDFBool.True);
  }
  return true;
}

interface CollectedRoot {
  ref: PDFRef;
  dict: PDFDict;
  contribution: number; // index into the contributions array
}

// Walk an output-side widget's /Parent chain to its topmost dict. A direct
// (non-ref) /Parent is malformed per spec; we walk through it anyway and
// register the top dict if it ends up ref-less, so a slightly-broken source
// still round-trips rather than losing the field.
function rootOf(
  output: PDFDocument,
  entry: unknown,
): { ref: PDFRef | null; dict: PDFDict } | null {
  let ref: PDFRef | null = entry instanceof PDFRef ? entry : null;
  let dict = asDict(output, entry);
  if (!dict) return null;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const parent = dict.get(NAME_PARENT);
    if (parent === undefined) return { ref, dict };
    const parentDict = asDict(output, parent);
    if (!parentDict) return { ref, dict };
    ref = parent instanceof PDFRef ? parent : null;
    dict = parentDict;
  }
  return null; // over-deep/cyclic — treat as unrooted
}

// Visit a field dict and every descendant (kids of any depth, widgets
// included — /DA may legally sit at any level).
function walkFieldTree(output: PDFDocument, dict: PDFDict, visit: (d: PDFDict) => void): void {
  const stack: { d: PDFDict; depth: number }[] = [{ d: dict, depth: 0 }];
  const seen = new Set<PDFDict>();
  while (stack.length) {
    const { d, depth } = stack.pop()!;
    if (seen.has(d) || depth > MAX_DEPTH) continue;
    seen.add(d);
    visit(d);
    const kids = asArray(output, d.get(NAME_KIDS));
    if (!kids) continue;
    for (let i = 0; i < kids.size(); i++) {
      const kid = asDict(output, kids.get(i));
      if (kid) stack.push({ d: kid, depth: depth + 1 });
    }
  }
}

function daStringOf(dict: PDFDict): string | null {
  const da = dict.get(NAME_DA);
  if (da instanceof PDFString || da instanceof PDFHexString) return da.decodeText();
  return null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Replace /oldName tokens in a /DA appearance string. A PDF name token ends
// at whitespace or a delimiter, so "/Helv" must not rewrite "/HelvB".
// ONE pass over the original string, all renames as a single alternation
// with a replacer FUNCTION (review-caught, both verified live):
// (1) sequential per-rename .replace() passes feed each other — when a
//     rename's TARGET equals another rename's OLD name (the natural shape of
//     a document that already went through one merge, e.g. F1→F1_1 alongside
//     a pre-existing F1_1→F1_1_1), the second pass re-matches the first
//     pass's output and a field silently lands on a DIFFERENT field's font;
//     a single pass can never re-match its own substitutions.
// (2) a plain replacement STRING treats $$ / $& as patterns — a legal PDF
//     name containing '$' mangled the rewrite; a function's return value is
//     always literal.
function rewriteDaFonts(da: string, renames: Map<string, string>): string {
  if (renames.size === 0) return da;
  const alternation = [...renames.keys()]
    .sort((a, b) => b.length - a.length) // longest-first; belt to the lookahead's braces
    .map(escapeRegExp)
    .join('|');
  return da.replace(
    new RegExp(`/(${alternation})(?=[\\s/\\[\\]()<>{}%]|$)`, 'g'),
    (_m, name: string) => `/${renames.get(name)!}`,
  );
}

// Font subtypes that MAY be treated as interchangeable when everything else
// agrees — the simple, metadata-describable kinds. An ALLOW-list, not a
// deny-list (review-caught, round 2): rendering-defining data hides in
// subtype-specific places a top-level check can't see — Type0/CID fonts
// carry /FontDescriptor nested under /DescendantFonts (two different
// embedded CJK fonts deduped to one entry produce GARBLED index-based
// glyphs, not just a wrong face), and Type3 fonts have no descriptor at all
// (their rendering IS their /CharProcs streams). Any subtype not listed —
// including future/unknown ones — defaults to "never equivalent": a
// duplicate /DR entry is bloat; a false merge corrupts a field's glyphs.
const SIMPLE_FONT_SUBTYPES = new Set([
  PDFName.of('Type1'),
  PDFName.of('TrueType'),
  PDFName.of('MMType1'),
]);

// Two /DR font entries are interchangeable only when they are SIMPLE fonts
// (allow-list above) whose BaseFont, Subtype, and Encoding all agree and
// neither embeds a font program — the ubiquitous case of every source
// defining /Helv as unembedded WinAnsi Helvetica. Anything else stays
// "different" and gets renamed; claiming a wrong face — or a wrong glyph MAP
// (review-caught: same-named Helvetica entries differing only in /Encoding,
// e.g. a custom /Differences remap, were deduplicated onto the first
// source's encoding) — is the failure mode 2l's review flagged as HIGH.
function fontsEquivalent(output: PDFDocument, a: unknown, b: unknown): boolean {
  const da = asDict(output, a);
  const db = asDict(output, b);
  if (!da || !db) return false;
  const subA = da.get(NAME_SUBTYPE);
  const subB = db.get(NAME_SUBTYPE);
  if (!(subA instanceof PDFName) || subB !== subA || !SIMPLE_FONT_SUBTYPES.has(subA)) {
    return false;
  }
  // An embedded font program is never assumed equivalent to anything — only
  // the subset-tag naming convention would distinguish two, and that is a
  // convention, not a guarantee.
  if (da.get(NAME_FONTDESCRIPTOR) !== undefined || db.get(NAME_FONTDESCRIPTOR) !== undefined) {
    return false;
  }
  const encA = resolveDirect(output, da.get(NAME_ENCODING));
  const encB = resolveDirect(output, db.get(NAME_ENCODING));
  // Encodings must be the SAME simple name, or both absent (both then fall
  // to the same standard font's built-in). A dict encoding (custom
  // /Differences) never matches — deep-comparing one is not worth a
  // wrong-glyph-map risk.
  const encodingsMatch =
    (encA === undefined && encB === undefined) ||
    (encA instanceof PDFName && encB instanceof PDFName && encA === encB);
  if (!encodingsMatch) return false;
  const baseA = da.get(NAME_BASEFONT);
  const baseB = db.get(NAME_BASEFONT);
  return baseA instanceof PDFName && baseB instanceof PDFName && baseA === baseB;
}

// Does any field in this root's tree resolve to /FT /Sig (with inheritance —
// /FT may live on an ancestor)?
function treeHasSigField(output: PDFDocument, root: PDFDict): boolean {
  let found = false;
  const walk = (d: PDFDict, inheritedFt: PDFName | null, depth: number): void => {
    if (found || depth > MAX_DEPTH) return;
    const own = d.get(NAME_FT);
    const ft = own instanceof PDFName ? own : inheritedFt;
    const kids = asArray(output, d.get(NAME_KIDS));
    if (!kids || kids.size() === 0) {
      if (ft === NAME_SIG) found = true;
      return;
    }
    for (let i = 0; i < kids.size(); i++) {
      const kid = asDict(output, kids.get(i));
      if (kid) walk(kid, ft, depth + 1);
    }
  };
  walk(root, null, 0);
  return found;
}

function fieldName(dict: PDFDict): string | null {
  const t = dict.get(NAME_T);
  if (t instanceof PDFString || t instanceof PDFHexString) return t.decodeText();
  return null;
}

// Whether any node of this SOURCE-side field subtree is a widget. A marked
// root with widgets is always reachable from a copied page (prune dropped it
// otherwise), so the output-side walk finds it; a fully widget-less root is
// reachable from nothing and must be copied explicitly or its /V is lost.
function subtreeHasWidget(doc: PDFDocument, root: PDFDict): boolean {
  let found = false;
  const walk = (d: PDFDict, depth: number): void => {
    if (found || depth > MAX_DEPTH) return;
    if (isWidget(d)) {
      found = true;
      return;
    }
    const kids = asArray(doc, d.get(NAME_KIDS));
    if (!kids) return;
    for (let i = 0; i < kids.size(); i++) {
      const kid = asDict(doc, kids.get(i));
      if (kid) walk(kid, depth + 1);
    }
  };
  walk(root, 0);
  return found;
}

/**
 * Rebuild the output /AcroForm from the copied pages' widgets. Call after
 * every page has been copied and added. No marked roots anywhere -> no-op
 * (a non-form rebuild gains no /AcroForm key).
 */
export function carryAcroForm(output: PDFDocument, contributions: FormContribution[]): void {
  // ---- collect marked roots, in contribution order then first-seen order --
  const roots: CollectedRoot[] = [];
  const seenRootTags = new Set<string>();
  contributions.forEach((contribution, ci) => {
    for (const page of contribution.copiedPages) {
      const annots = asArray(output, page.node.get(NAME_ANNOTS));
      if (!annots) continue;
      for (let i = 0; i < annots.size(); i++) {
        const entry = annots.get(i);
        const dict = asDict(output, entry);
        if (!dict || !isWidget(dict)) continue;
        const top = rootOf(output, entry);
        if (!top || top.dict.get(ROOT_MARKER) === undefined) continue; // orphan widget — stays an orphan
        let ref = top.ref;
        if (ref === null) {
          // Malformed direct-object root — /Fields entries must be indirect.
          ref = output.context.register(top.dict);
        }
        if (seenRootTags.has(ref.tag)) continue;
        seenRootTags.add(ref.tag);
        roots.push({ ref, dict: top.dict, contribution: ci });
      }
    }
  });
  // Widget-less pure-data roots survived the prune but are reachable from no
  // page — copy them explicitly (a fresh copier is safe here: such a tree
  // shares no objects with any page subtree).
  contributions.forEach((contribution, ci) => {
    const srcAcro = acroFormOf(contribution.source);
    if (!srcAcro) return;
    const srcFields = asArray(contribution.source, srcAcro.get(NAME_FIELDS));
    if (!srcFields) return;
    let copier: ReturnType<typeof PDFObjectCopier.for> | null = null;
    for (let i = 0; i < srcFields.size(); i++) {
      const dict = asDict(contribution.source, srcFields.get(i));
      if (!dict || dict.get(ROOT_MARKER) === undefined) continue;
      if (subtreeHasWidget(contribution.source, dict)) continue; // widget walk found/finds it
      copier ??= PDFObjectCopier.for(contribution.source.context, output.context);
      const copied = copier.copy(dict);
      roots.push({ ref: output.context.register(copied), dict: copied, contribution: ci });
    }
  });
  if (roots.length === 0) return;

  // ---- resolve cross-source field-NAME collisions ------------------------
  // Two roots sharing a fully-qualified /T would make readers treat unrelated
  // fields as one logical field (same-name fields share /V per spec) — the
  // import machinery makes this reachable. Deterministic rename with the
  // same name+1 convention pikepdf's add_pages_from uses engine-side, so a
  // canvas import and a CLI merge of the same files agree.
  const takenNames = new Set<string>();
  for (const root of roots) {
    const name = fieldName(root.dict);
    if (name === null) continue; // nameless root — nothing to collide on
    if (!takenNames.has(name)) {
      takenNames.add(name);
      continue;
    }
    let n = 1;
    while (takenNames.has(`${name}+${n}`)) n++;
    const renamed = `${name}+${n}`;
    takenNames.add(renamed);
    root.dict.set(NAME_T, PDFHexString.fromText(renamed));
  }

  // ---- merge /DR across contributing sources -----------------------------
  const contributing = new Set(roots.map((r) => r.contribution));
  const mergedDR = output.context.obj({}) as PDFDict;
  let mergedAny = false;
  // Per-contribution font renames that /DA strings must follow.
  const daRenames = new Map<number, Map<string, string>>();
  for (const ci of [...contributing].sort((a, b) => a - b)) {
    const srcAcro = acroFormOf(contributions[ci].source);
    if (!srcAcro) continue;
    const srcDR = asDict(contributions[ci].source, srcAcro.get(NAME_DR));
    if (!srcDR) continue;
    // A private copier per source: its cache keeps THIS copy internally
    // consistent. Resources also reachable from copied /AP streams duplicate
    // once per source (copyPages used its own cache) — bloat, not
    // incorrectness, and unavoidable without pdf-lib exposing its copier.
    const copier = PDFObjectCopier.for(contributions[ci].source.context, output.context);
    const copiedDR = copier.copy(srcDR);
    for (const [groupName, groupVal] of copiedDR.entries()) {
      const group = asDict(output, groupVal);
      if (!group) {
        // Non-dict resource entry (e.g. the obsolete /ProcSet array) — first
        // contributor wins.
        if (mergedDR.get(groupName) === undefined) {
          mergedDR.set(groupName, groupVal);
          mergedAny = true;
        }
        continue;
      }
      let target = asDict(output, mergedDR.get(groupName));
      if (!target) {
        target = output.context.obj({}) as PDFDict;
        mergedDR.set(groupName, target);
      }
      const isFontGroup = groupName === PDFName.of('Font');
      for (const [resName, resVal] of group.entries()) {
        const existing = target.get(resName);
        if (existing === undefined) {
          target.set(resName, resVal);
          mergedAny = true;
          continue;
        }
        if (isFontGroup && fontsEquivalent(output, existing, resVal)) continue; // reuse
        // Genuine collision — rename the incoming resource (same base_1
        // convention as pikepdf's engine-side carry).
        const base = resName.decodeText();
        let n = 1;
        while (target.get(PDFName.of(`${base}_${n}`)) !== undefined) n++;
        const renamed = `${base}_${n}`;
        target.set(PDFName.of(renamed), resVal);
        mergedAny = true;
        if (isFontGroup) {
          const forSource = daRenames.get(ci) ?? new Map<string, string>();
          forSource.set(base, renamed);
          daRenames.set(ci, forSource);
        }
      }
    }
  }

  // ---- rewrite /DA strings for renamed fonts ------------------------------
  for (const root of roots) {
    const renames = daRenames.get(root.contribution);
    if (!renames || renames.size === 0) continue;
    walkFieldTree(output, root.dict, (d) => {
      const da = daStringOf(d);
      if (da === null) return;
      const rewritten = rewriteDaFonts(da, renames);
      if (rewritten !== da) d.set(NAME_DA, PDFHexString.fromText(rewritten));
    });
  }

  // ---- AcroForm-level /DA and /Q ------------------------------------------
  // Taken from the FIRST contributing source; a later source whose own
  // AcroForm-level defaults differ gets them pushed down onto its roots that
  // lack their own — fields must not silently change face, size, or
  // alignment because a rebuild picked another source's defaults.
  const sortedContribs = [...contributing].sort((a, b) => a - b);
  const acroLevel = new Map<number, { da: string | null; q: number | null }>();
  for (const ci of sortedContribs) {
    const srcAcro = acroFormOf(contributions[ci].source);
    let da: string | null = null;
    let q: number | null = null;
    if (srcAcro) {
      da = daStringOf(srcAcro);
      if (da !== null) da = rewriteDaFonts(da, daRenames.get(ci) ?? new Map());
      const qVal = srcAcro.get(NAME_Q);
      if (qVal instanceof PDFNumber) q = qVal.asNumber();
    }
    acroLevel.set(ci, { da, q });
  }
  const first = acroLevel.get(sortedContribs[0])!;
  for (const ci of sortedContribs.slice(1)) {
    const own = acroLevel.get(ci)!;
    const daDiffers = own.da !== first.da && own.da !== null;
    const qDiffers = own.q !== first.q && own.q !== null;
    if (!daDiffers && !qDiffers) continue;
    for (const root of roots) {
      if (root.contribution !== ci) continue;
      if (daDiffers && daStringOf(root.dict) === null) {
        root.dict.set(NAME_DA, PDFHexString.fromText(own.da!));
      }
      if (qDiffers && root.dict.get(NAME_Q) === undefined) {
        root.dict.set(NAME_Q, PDFNumber.of(own.q!));
      }
    }
  }

  // ---- /NeedAppearances (OR) and /SigFlags bit 1 (recomputed) -------------
  let needAppearances = false;
  for (const ci of contributing) {
    const srcAcro = acroFormOf(contributions[ci].source);
    if (srcAcro && srcAcro.get(NAME_NEEDAPPEARANCES) === PDFBool.True) needAppearances = true;
  }
  const hasSig = roots.some((r) => treeHasSigField(output, r.dict));

  // ---- strip markers and assemble -----------------------------------------
  for (const root of roots) root.dict.delete(ROOT_MARKER);

  const fieldsArr = output.context.obj(roots.map((r) => r.ref)) as PDFArray;
  const acroDict = output.context.obj({}) as PDFDict;
  acroDict.set(NAME_FIELDS, fieldsArr);
  if (mergedAny) acroDict.set(NAME_DR, mergedDR);
  if (first.da !== null) acroDict.set(NAME_DA, PDFHexString.fromText(first.da));
  if (first.q !== null) acroDict.set(NAME_Q, PDFNumber.of(first.q));
  if (needAppearances) acroDict.set(NAME_NEEDAPPEARANCES, PDFBool.True);
  if (hasSig) acroDict.set(NAME_SIGFLAGS, PDFNumber.of(1));
  output.catalog.set(NAME_ACROFORM, output.context.register(acroDict));
}
