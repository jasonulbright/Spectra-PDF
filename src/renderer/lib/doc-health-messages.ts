import type { UiKey } from '../i18n';
import type { HealthBoundary, HealthKind } from './doc-health';

// Stable fact CODE → catalog key. The boundaries speak English and emit codes;
// the sentence a reader sees is chosen here and rendered from the catalog, so
// no control flow anywhere matches a localized string, and no engine text is
// ever shown as if it were UI copy.
//
// A code with no row is not an error and is not silently dropped: it renders
// as `code.unknown`, which says a reader reported something this build does
// not recognize. A newer engine talking to an older renderer must degrade to
// "something was reported", never to "nothing was reported".
const CODE_KEYS: Readonly<Record<string, UiKey>> = {
  'xref.reconstructed': 'panel.health.code.xrefReconstructed',
  'structure.repaired': 'panel.health.code.structureRepaired',
  'font.notEmbedded': 'panel.health.code.fontNotEmbedded',
  'font.substituted': 'panel.health.code.fontSubstituted',
  'font.unreadable': 'panel.health.code.fontUnreadable',
  'page.mediaBoxMissing': 'panel.health.code.pageMediaBoxMissing',
  'page.contentUnreadable': 'panel.health.code.pageContentUnreadable',
  'page.imageUnreadable': 'panel.health.code.pageImageUnreadable',
  'page.formUnreadable': 'panel.health.code.pageFormUnreadable',
  'page.appearanceUnreadable': 'panel.health.code.pageAppearanceUnreadable',
  'page.traversalLimit': 'panel.health.code.pageTraversalLimit',
  'document.xfa': 'panel.health.code.documentXfa',
  'document.imagesNotDecoded': 'panel.health.code.imagesNotDecoded',
  'document.encrypted': 'panel.health.code.documentEncrypted',
  'document.encryptedOwner': 'panel.health.code.documentEncryptedOwner',
  'document.unreadable': 'panel.health.code.documentUnreadable',
  'document.metadataUnreadable': 'panel.health.code.partUnreadable',
  // The traversals that stopped part-way. They differ only in WHICH branch
  // would not read, which the page chip already says; one sentence covers
  // them rather than four that read the same.
  'page.unreadable': 'panel.health.code.partUnreadable',
  'page.resourcesUnreadable': 'panel.health.code.partUnreadable',
  'document.acroFormUnreadable': 'panel.health.code.partUnreadable',
  'document.xfaUnreadable': 'panel.health.code.partUnreadable',
  // The reader said something no rule here classifies. That is exactly what
  // `unknown` states, so it is the same sentence rather than a second one.
  'qpdf.unclassifiedWarning': 'panel.health.code.unknown',
  'pages.unreadable': 'panel.health.code.partUnreadable',
  'fonts.unenumerable': 'panel.health.code.partUnreadable',
  'warnings.unreadable': 'panel.health.code.partUnreadable',
  // A stepped run the engine no longer holds. What it would have inspected was
  // not inspected, which is the same sentence as any other traversal that
  // stopped.
  'health.runLost': 'panel.health.code.partUnreadable',
  // The inspection cost more than the engine spends on a passive observation
  // and stopped where it stopped. Same sentence as any other traversal that
  // stopped part-way, because that is exactly what it is.
  'document.inspectionBudget': 'panel.health.code.partUnreadable',
  // A worker await that never settled. Not a refusal and not a clean result:
  // the sweep stopped where it stopped, and the pages after it were never
  // asked about.
  'pdfjs.timeout': 'panel.health.code.pdfjsTimeout',
};

export function healthMessageKey(code: string): UiKey {
  return CODE_KEYS[code] ?? 'panel.health.code.unknown';
}

const BOUNDARY_KEYS: Readonly<Record<HealthBoundary, UiKey>> = {
  pdfjs: 'panel.health.boundary.pdfjs',
  qpdf: 'panel.health.boundary.qpdf',
  engine: 'panel.health.boundary.engine',
};

export function healthBoundaryKey(boundary: HealthBoundary): UiKey {
  return BOUNDARY_KEYS[boundary];
}

const KIND_KEYS: Readonly<Record<HealthKind, UiKey>> = {
  recovered: 'panel.health.kind.recovered',
  font: 'panel.health.kind.font',
  skipped: 'panel.health.kind.skipped',
  undetermined: 'panel.health.kind.undetermined',
};

export function healthKindKey(kind: HealthKind): UiKey {
  return KIND_KEYS[kind];
}

/**
 * The DATA a fact names, shown beside its sentence rather than inside it: a
 * font's own name, or the resource key of an object that would not read.
 * Never translated — it is what the document itself calls the thing.
 */
export function healthSubject(params: Readonly<Record<string, string | number>>): string {
  const value = params.font ?? params.name ?? '';
  return typeof value === 'string' ? value : String(value);
}
