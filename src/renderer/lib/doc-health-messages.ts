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
  'document.xfa': 'panel.health.code.documentXfa',
  'document.encrypted': 'panel.health.code.documentEncrypted',
  'document.unreadable': 'panel.health.code.documentUnreadable',
  'document.metadataUnreadable': 'panel.health.code.partUnreadable',
  // The traversals that stopped part-way. They differ only in WHICH branch
  // would not read, which the page chip already says; one sentence covers
  // them rather than four that read the same.
  'page.unreadable': 'panel.health.code.partUnreadable',
  'page.resourcesUnreadable': 'panel.health.code.partUnreadable',
  'pages.unreadable': 'panel.health.code.partUnreadable',
  'fonts.unenumerable': 'panel.health.code.partUnreadable',
  'warnings.unreadable': 'panel.health.code.partUnreadable',
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
