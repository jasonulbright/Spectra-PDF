// The accessibility report — one model, two emitters.
//
// Pure formatting, no IO, for the reason the batch and disk-redact logs are:
// a report drawn in a panel dies with the panel, and a sweep over a document
// set needs an artefact that can be read and grepped afterwards. Text ships
// alongside HTML because a greppable artefact is what that sweep actually
// needs; HTML ships because a saved report is what a commercial checker
// offers and a text-only export would be a gap.
//
// Both emitters render the SAME model, so the two formats can never disagree
// about a verdict. Every row carries its check ID beside its localized name,
// so two people reading two locales can talk about the same row. The report
// is read by a human ABOUT a document — it is never written INTO one — so it
// is emitted in the UI locale.
import { currentLanguage, tChrome, textDirection } from '../i18n';

export type Verdict = 'pass' | 'fail' | 'warn' | 'needs_review' | 'not_applicable';

export interface FindingAddress {
  kind: 'struct' | 'content' | 'object';
  path?: number[];
  page?: number | null;
  run?: number;
  annotation?: number;
  field?: string;
}

export interface Finding {
  address: FindingAddress;
  detail_key: string;
  preview: string;
  rect?: [number, number, number, number];
  values?: Record<string, unknown>;
}

export interface Check {
  id: string;
  category: string;
  status: Verdict;
  /** Things the check applied to — the denominator a finding count reads against. */
  counted: number;
  findings: Finding[];
  data?: Record<string, unknown>;
}

export interface Category {
  id: string;
  checks: Check[];
  passed: number;
  applicable: number;
}

export interface ReportSummary {
  passed: number;
  failed: number;
  warnings: number;
  needs_review: number;
  not_applicable: number;
  applicable: number;
  total: number;
}

export interface UnreadablePage {
  page: number;
  stage?: string;
  reason?: string;
}

export interface AccessibilityReport {
  categories: Category[];
  summary: ReportSummary;
  unreadable: UnreadablePage[];
}

/**
 * The engine's check inventory, mirrored: id → category, in report order.
 *
 * The engine is the authority (`engine/accessibility.py`'s CHECK_INVENTORY);
 * this mirror is what derives the catalog keys, so a check the engine reports
 * and this list omits would render nameless. `tests/accessibility-report.test.ts`
 * reads the engine module as source text and fails on any divergence.
 */
export const CHECK_INVENTORY: readonly (readonly [string, string])[] = [
  ['permissions', 'document'],
  ['image_only', 'document'],
  ['tagged', 'document'],
  ['role_map', 'document'],
  ['suspects', 'document'],
  ['structure_nesting', 'document'],
  ['reading_order', 'document'],
  ['lang', 'document'],
  ['title', 'document'],
  ['bookmarks', 'document'],
  ['contrast', 'document'],
  ['tagged_content', 'page_content'],
  ['untagged_graphics', 'page_content'],
  ['artifact_judgement', 'page_content'],
  ['content_grouping', 'page_content'],
  ['content_order', 'page_content'],
  ['tagged_annotations', 'page_content'],
  ['tab_order', 'page_content'],
  ['character_encoding', 'page_content'],
  ['unicode_mapping', 'page_content'],
  ['tagged_multimedia', 'page_content'],
  ['screen_flicker', 'page_content'],
  ['scripts', 'page_content'],
  ['timed_responses', 'page_content'],
  ['navigation_links', 'page_content'],
  ['tagged_form_fields', 'forms'],
  ['field_descriptions', 'forms'],
  ['figures_alt', 'alt_text'],
  ['nested_alt', 'alt_text'],
  ['alt_no_content', 'alt_text'],
  ['alt_hides_annotation', 'alt_text'],
  ['other_elements_alt', 'alt_text'],
  ['table_rows', 'tables'],
  ['table_cells', 'tables'],
  ['table_headers', 'tables'],
  ['table_regularity', 'tables'],
  ['table_summary', 'tables'],
  ['list_items', 'lists'],
  ['list_labels', 'lists'],
  ['list_numbering', 'lists'],
  ['list_item_structure', 'lists'],
  ['list_semantics', 'lists'],
  ['heading_nesting', 'headings'],
  ['heading_tag_mixing', 'headings'],
  ['heading_semantics', 'headings'],
];

export const CATEGORY_IDS: readonly string[] = [
  'document',
  'page_content',
  'forms',
  'alt_text',
  'tables',
  'lists',
  'headings',
];

/** The verdict glyph the panel and the text report share. A needs-review row
 * shows neither a tick nor a cross — it has not been decided. */
export const VERDICT_GLYPH: Record<Verdict, string> = {
  pass: '✓',
  fail: '✕',
  warn: '!',
  needs_review: '?',
  not_applicable: '–',
};

export function checkName(id: string): string {
  return tChrome(`panel.a11y.check.${id}` as Parameters<typeof tChrome>[0]);
}

export function checkExplanation(id: string): string {
  return tChrome(`panel.a11y.explain.${id}` as Parameters<typeof tChrome>[0]);
}

export function categoryName(id: string): string {
  return tChrome(`panel.a11y.category.${id}` as Parameters<typeof tChrome>[0]);
}

export function verdictLabel(status: Verdict): string {
  return tChrome(`panel.a11y.verdict.${status}` as Parameters<typeof tChrome>[0]);
}

/** One finding's sentence, interpolated from its measured `values`.
 *
 * Findings are matched by `detail_key`, never by their rendered sentence:
 * nothing in the checker's control flow reads localized text. */
export function findingDetail(finding: Finding): string {
  const vars: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(finding.values ?? {})) {
    vars[key] = typeof value === 'number' ? value : String(value);
  }
  return tChrome(`panel.a11y.detail.${finding.detail_key}` as Parameters<typeof tChrome>[0], vars);
}

/** Where a finding is, as one readable phrase. */
export function findingWhere(finding: Finding): string {
  const a = finding.address;
  if (a.kind === 'struct') {
    return tChrome('panel.a11y.where.tag', { path: (a.path ?? []).join('.') });
  }
  if (a.kind === 'content') {
    return tChrome('panel.a11y.where.page', { page: String(a.page ?? '') });
  }
  if (a.field !== undefined) return tChrome('panel.a11y.where.field', { name: a.field });
  if (a.annotation !== undefined && a.page !== undefined && a.page !== null) {
    return tChrome('panel.a11y.where.annotation', { page: String(a.page) });
  }
  if (a.page !== undefined && a.page !== null) {
    return tChrome('panel.a11y.where.page', { page: String(a.page) });
  }
  return tChrome('panel.a11y.where.document');
}

export interface ReportRun {
  /** The document the report is about — its display name, not its path. */
  documentName: string;
  runAt: Date;
  report: AccessibilityReport;
}

function stamp(when: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ` +
    `${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())}`
  );
}

/** The summary line both formats print, and the panel shows. */
export function summaryLine(summary: ReportSummary): string {
  return tChrome('panel.a11y.summaryLine', {
    passed: String(summary.passed),
    failed: String(summary.failed),
    warnings: String(summary.warnings),
    review: String(summary.needs_review),
    notApplicable: String(summary.not_applicable),
    applicable: String(summary.applicable),
    total: String(summary.total),
  });
}

/** A category's count, always `passed / applicable` — never `passed / total`.
 * A category with nothing to check says so instead of showing 0/0. */
export function categoryCount(category: Category): string {
  if (category.applicable === 0) return tChrome('panel.a11y.categoryNone');
  return tChrome('panel.a11y.categoryCount', {
    passed: String(category.passed),
    applicable: String(category.applicable),
  });
}

/** The report's own file name, date-first so one folder sorts chronologically
 * (the sweep-log naming shape). */
export function reportFileName(
  documentName: string,
  runAt: Date,
  format: 'txt' | 'html',
): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const date =
    `${runAt.getFullYear()}${pad(runAt.getMonth() + 1)}${pad(runAt.getDate())}` +
    `-${pad(runAt.getHours())}${pad(runAt.getMinutes())}`;
  const base = documentName.replace(/\.[Pp][Dd][Ff]$/, '').replace(/[\\/:*?"<>|]/g, '_');
  return `${base}-accessibility-${date}.${format}`;
}

// ── the ordered model both emitters render ────────────────────────────────

export interface ReportRow {
  category: string;
  check: Check;
}

/** The report's checks in inventory order, category by category. The engine
 * already emits them ordered; this re-derives the order from the mirror so a
 * report assembled from a partial run still renders in one stable order. */
export function orderedRows(report: AccessibilityReport): ReportRow[] {
  const byId = new Map<string, Check>();
  for (const category of report.categories) {
    for (const check of category.checks) byId.set(check.id, check);
  }
  const rows: ReportRow[] = [];
  for (const [id, category] of CHECK_INVENTORY) {
    const check = byId.get(id);
    if (check) rows.push({ category, check });
  }
  return rows;
}

/** The categories in inventory order, each with its checks in inventory order.
 * Both emitters and the panel read the report through this, so a category the
 * engine emitted out of order cannot render in three different sequences. */
export function orderedCategories(report: AccessibilityReport): Category[] {
  const rows = orderedRows(report);
  const out: Category[] = [];
  for (const id of CATEGORY_IDS) {
    const source = report.categories.find((c) => c.id === id);
    if (!source) continue;
    out.push({ ...source, checks: rows.filter((r) => r.category === id).map((r) => r.check) });
  }
  return out;
}

// ── text ──────────────────────────────────────────────────────────────────

export function formatAccessibilityText(run: ReportRun): string {
  const { report } = run;
  const lines: string[] = [
    tChrome('panel.a11y.reportTitle'),
    tChrome('panel.a11y.reportDocument', { name: run.documentName }),
    tChrome('panel.a11y.reportRunAt', { when: stamp(run.runAt) }),
    '',
    summaryLine(report.summary),
    '',
  ];
  for (const category of orderedCategories(report)) {
    lines.push(`${categoryName(category.id)}  —  ${categoryCount(category)}`);
    for (const check of category.checks) {
      lines.push(
        `  [${VERDICT_GLYPH[check.status]}] ${checkName(check.id)}  (${check.id}) ` +
          `— ${verdictLabel(check.status)}`,
      );
      for (const finding of check.findings) {
        const preview = finding.preview ? ` "${finding.preview}"` : '';
        lines.push(`        ${findingWhere(finding)} — ${findingDetail(finding)}${preview}`);
      }
    }
    lines.push('');
  }
  if (report.unreadable.length > 0) {
    lines.push(tChrome('panel.a11y.unreadableHeading'));
    for (const page of report.unreadable) {
      lines.push(`  ${tChrome('panel.a11y.unreadablePage', { page: String(page.page) })}`);
    }
    lines.push('');
  }
  lines.push(tChrome('panel.a11y.reportFooter'));
  return lines.join('\n') + '\n';
}

// ── HTML ──────────────────────────────────────────────────────────────────

/** Escapes for both text nodes and double-quoted attribute values, so one
 * helper covers every interpolation in the document below. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Inline and self-contained: a saved report is opened from a folder, often on
// a machine that is not this one, and a stylesheet reference would resolve to
// nothing there.
const HTML_STYLE = `
:root { color-scheme: light dark; }
body { font: 15px/1.5 system-ui, sans-serif; margin: 2rem auto; max-width: 60rem; padding: 0 1rem; }
h1 { font-size: 1.5rem; margin-bottom: 0.25rem; }
h2 { font-size: 1.1rem; margin: 2rem 0 0.5rem; border-bottom: 1px solid currentColor; padding-bottom: 0.25rem; }
.meta { opacity: 0.75; margin: 0; }
.summary { font-weight: 600; margin: 1.5rem 0; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 0.35rem 0.5rem; vertical-align: top; border-bottom: 1px solid rgba(128,128,128,0.35); }
td.verdict { white-space: nowrap; font-weight: 700; width: 1%; }
code { opacity: 0.7; font-size: 0.85em; }
ul.findings { margin: 0.35rem 0 0; padding-left: 1.1rem; }
li { margin: 0.15rem 0; }
.preview { opacity: 0.75; font-style: italic; }
.na { opacity: 0.55; }
`;

export function formatAccessibilityHtml(run: ReportRun): string {
  const { report } = run;
  const out: string[] = [];
  out.push('<!DOCTYPE html>');
  // The language and the direction come from the runtime, never from a
  // catalog row: a saved report is a document in the UI locale, and a
  // hand-authored tag is one more thing that can disagree with what was
  // actually rendered.
  const language = currentLanguage();
  out.push(
    `<html lang="${escapeHtml(language)}" dir="${escapeHtml(textDirection(language))}"><head>`,
  );
  out.push('<meta charset="utf-8">');
  out.push(
    `<title>${escapeHtml(tChrome('panel.a11y.reportTitle'))} — ` +
      `${escapeHtml(run.documentName)}</title>`,
  );
  out.push(`<style>${HTML_STYLE}</style>`);
  out.push('</head><body>');
  out.push(`<h1>${escapeHtml(tChrome('panel.a11y.reportTitle'))}</h1>`);
  out.push(
    `<p class="meta">${escapeHtml(
      tChrome('panel.a11y.reportDocument', { name: run.documentName }),
    )}</p>`,
  );
  out.push(
    `<p class="meta">${escapeHtml(
      tChrome('panel.a11y.reportRunAt', { when: stamp(run.runAt) }),
    )}</p>`,
  );
  out.push(`<p class="summary">${escapeHtml(summaryLine(report.summary))}</p>`);

  for (const category of orderedCategories(report)) {
    out.push(
      `<h2>${escapeHtml(categoryName(category.id))} <span class="meta">${escapeHtml(
        categoryCount(category),
      )}</span></h2>`,
    );
    out.push('<table><tbody>');
    for (const check of category.checks) {
      const muted = check.status === 'not_applicable' ? ' class="na"' : '';
      out.push(`<tr${muted}>`);
      out.push(
        `<td class="verdict" title="${escapeHtml(verdictLabel(check.status))}">` +
          `${escapeHtml(VERDICT_GLYPH[check.status])}</td>`,
      );
      out.push('<td>');
      out.push(
        `<strong>${escapeHtml(checkName(check.id))}</strong> ` +
          `<code>${escapeHtml(check.id)}</code>`,
      );
      out.push(`<div class="meta">${escapeHtml(checkExplanation(check.id))}</div>`);
      if (check.findings.length > 0) {
        out.push('<ul class="findings">');
        for (const finding of check.findings) {
          const preview = finding.preview
            ? ` <span class="preview">&ldquo;${escapeHtml(finding.preview)}&rdquo;</span>`
            : '';
          out.push(
            `<li>${escapeHtml(findingWhere(finding))} — ` +
              `${escapeHtml(findingDetail(finding))}${preview}</li>`,
          );
        }
        out.push('</ul>');
      }
      out.push('</td>');
      out.push('</tr>');
    }
    out.push('</tbody></table>');
  }

  if (report.unreadable.length > 0) {
    out.push(`<h2>${escapeHtml(tChrome('panel.a11y.unreadableHeading'))}</h2>`);
    out.push('<ul>');
    for (const page of report.unreadable) {
      out.push(
        `<li>${escapeHtml(
          tChrome('panel.a11y.unreadablePage', { page: String(page.page) }),
        )}</li>`,
      );
    }
    out.push('</ul>');
  }
  out.push(`<p class="meta">${escapeHtml(tChrome('panel.a11y.reportFooter'))}</p>`);
  out.push('</body></html>');
  return out.join('\n') + '\n';
}
