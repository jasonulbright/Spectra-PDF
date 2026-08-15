// The preflight report — one model, two emitters.
//
// Pure formatting, no IO, for the reason the accessibility report is: a report
// drawn in a panel dies with the panel, and a press job needs an artefact that
// travels with the file and can be read on a machine that does not have this
// app. Text ships alongside HTML because a greppable artefact is what a folder
// sweep actually needs.
//
// Both emitters render the SAME model, so the two formats can never disagree
// about a verdict. Two things are on every row and both are load-bearing:
// the check's ID beside its localized name, so two people reading two locales
// can talk about the same row; and the PARAMETERS it was measured against,
// because a preflight verdict with no rule beside it is unreadable a year
// later by someone who does not have the profile.
//
// Ink names and font names are document content and reach the report verbatim
// — which is why the HTML escaping of one is pinned by a test.
import { currentLanguage, tChrome, textDirection } from '../i18n';
import {
  CATEGORY_IDS,
  CHECK_INVENTORY,
  paramUnit,
  type Verdict,
} from './preflight-profile';

export type { Verdict } from './preflight-profile';

export interface FindingAddress {
  kind: 'page' | 'content' | 'object';
  page?: number | null;
  annotation?: number;
  field?: string;
  /** An ink is addressed by NAME — the plate is the thing, not a position. */
  ink?: string;
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
  /** `fail` or `warn` — what the profile said dirty means for this check. */
  severity: string;
  /** Things the check applied to — the denominator a finding count reads
   * against. */
  counted: number;
  /** The rule this row was measured against, resolved. */
  params: Record<string, unknown>;
  findings: Finding[];
  /** Every finding, including the ones beyond the listed bound. */
  finding_count: number;
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

export interface UnreadableBranch {
  reason: string;
  affects: string[];
}

export interface ReportProfile {
  id: string;
  name: string;
  name_key: string;
  based_on: string;
}

export interface PreflightReport {
  file?: string;
  profile: ReportProfile;
  categories: Category[];
  summary: ReportSummary;
  unreadable: UnreadableBranch[];
  images: number;
  color_families: string[];
}

/** The verdict glyph the panel and both emitters share. A needs-review row
 * shows neither a tick nor a cross — it has not been decided. */
export const VERDICT_GLYPH: Record<Verdict, string> = {
  pass: '✓',
  fail: '✕',
  warn: '!',
  needs_review: '?',
  not_applicable: '–',
};

export function checkName(id: string): string {
  return tChrome(`panel.preflight.check.${id}` as Parameters<typeof tChrome>[0]);
}

export function checkExplanation(id: string): string {
  return tChrome(`panel.preflight.explain.${id}` as Parameters<typeof tChrome>[0]);
}

export function categoryName(id: string): string {
  return tChrome(`panel.preflight.category.${id}` as Parameters<typeof tChrome>[0]);
}

export function verdictLabel(status: Verdict): string {
  return tChrome(`panel.preflight.verdict.${status}` as Parameters<typeof tChrome>[0]);
}

/** A SHIPPED profile's name is a catalog key; a USER profile's name is
 * authored content and is never translated. The schema carries both fields for
 * exactly this reason. */
export function profileName(profile: ReportProfile): string {
  if (profile.name_key) {
    return tChrome(`${profile.name_key}` as Parameters<typeof tChrome>[0]);
  }
  return profile.name || profile.id;
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
  return tChrome(
    `panel.preflight.detail.${finding.detail_key}` as Parameters<typeof tChrome>[0],
    vars,
  );
}

/** Where a finding is, as one readable phrase. */
export function findingWhere(finding: Finding): string {
  const a = finding.address;
  if (a.ink !== undefined) return tChrome('panel.preflight.where.ink', { name: a.ink });
  if (a.field !== undefined) return tChrome('panel.preflight.where.field', { name: a.field });
  if (a.annotation !== undefined && a.page !== undefined && a.page !== null) {
    return tChrome('panel.preflight.where.annotation', { page: String(a.page) });
  }
  if (a.page !== undefined && a.page !== null) {
    return tChrome('panel.preflight.where.page', { page: String(a.page) });
  }
  return tChrome('panel.preflight.where.document');
}

/** One parameter as `label: value unit`, with the unit through the catalog and
 * never concatenated. An empty list reads as "any", because that is what an
 * empty allow-list means. */
export function paramPhrase(name: string, value: unknown): string {
  const label = tChrome(`panel.preflight.param.${name}` as Parameters<typeof tChrome>[0]);
  let rendered: string;
  if (typeof value === 'boolean') {
    rendered = tChrome(value ? 'panel.preflight.yes' : 'panel.preflight.no');
  } else if (Array.isArray(value)) {
    rendered = value.length ? value.join(', ') : tChrome('panel.preflight.anyValue');
  } else if (typeof value === 'number') {
    const unit = paramUnit(name);
    const shown = Number.isInteger(value) ? String(value) : String(value);
    rendered = unit
      ? tChrome(`panel.preflight.unit.${unit}` as Parameters<typeof tChrome>[0], {
          value: shown,
        })
      : shown;
  } else {
    rendered = String(value ?? '') || tChrome('panel.preflight.anyValue');
  }
  return tChrome('panel.preflight.paramPair', { label, value: rendered });
}

/** Every parameter of one check, as one line. This is what makes the artefact
 * legible without the profile. */
export function paramsLine(check: Check): string {
  const parts = Object.entries(check.params ?? {}).map(([name, value]) =>
    paramPhrase(name, value),
  );
  if (parts.length === 0) return '';
  return tChrome('panel.preflight.ruleLine', { rule: parts.join(' · ') });
}

export interface ReportRun {
  /** The document the report is about — its display name, not its path. */
  documentName: string;
  runAt: Date;
  report: PreflightReport;
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
  return tChrome('panel.preflight.summaryLine', {
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
  if (category.applicable === 0) return tChrome('panel.preflight.categoryNone');
  return tChrome('panel.preflight.categoryCount', {
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
  return `${base}-preflight-${date}.${format}`;
}

// ── the ordered model both emitters render ────────────────────────────────

export interface ReportRow {
  category: string;
  check: Check;
}

/** The report's checks in inventory order, category by category. The engine
 * already emits them ordered; this re-derives the order from the mirror so a
 * report assembled from a partial run still renders in one stable order. */
export function orderedRows(report: PreflightReport): ReportRow[] {
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
export function orderedCategories(report: PreflightReport): Category[] {
  const rows = orderedRows(report);
  const out: Category[] = [];
  for (const id of CATEGORY_IDS) {
    const source = report.categories.find((c) => c.id === id);
    if (!source) continue;
    out.push({ ...source, checks: rows.filter((r) => r.category === id).map((r) => r.check) });
  }
  return out;
}

/** How many findings a check has beyond the ones it carries. The panel bounds
 * what it draws; the export carries every one the engine emitted. */
export function hiddenFindings(check: Check): number {
  return Math.max(0, check.finding_count - check.findings.length);
}

// ── text ──────────────────────────────────────────────────────────────────

export function formatPreflightText(run: ReportRun): string {
  const { report } = run;
  const lines: string[] = [
    tChrome('panel.preflight.reportTitle'),
    tChrome('panel.preflight.reportDocument', { name: run.documentName }),
    tChrome('panel.preflight.reportProfile', { name: profileName(report.profile) }),
    tChrome('panel.preflight.reportRunAt', { when: stamp(run.runAt) }),
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
      const rule = paramsLine(check);
      if (rule) lines.push(`        ${rule}`);
      for (const finding of check.findings) {
        const preview = finding.preview ? ` "${finding.preview}"` : '';
        lines.push(`        ${findingWhere(finding)} — ${findingDetail(finding)}${preview}`);
      }
      const hidden = hiddenFindings(check);
      if (hidden > 0) {
        lines.push(`        ${tChrome('panel.preflight.moreFindings', { count: hidden })}`);
      }
    }
    lines.push('');
  }
  if (report.unreadable.length > 0) {
    lines.push(tChrome('panel.preflight.unreadableHeading'));
    for (const branch of report.unreadable) {
      lines.push(`  ${branch.reason}`);
    }
    lines.push('');
  }
  lines.push(tChrome('panel.preflight.reportFooter'));
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
.rule { opacity: 0.75; font-size: 0.85em; }
ul.findings { margin: 0.35rem 0 0; padding-left: 1.1rem; }
li { margin: 0.15rem 0; }
.preview { opacity: 0.75; font-style: italic; }
.na { opacity: 0.55; }
`;

export function formatPreflightHtml(run: ReportRun): string {
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
    `<title>${escapeHtml(tChrome('panel.preflight.reportTitle'))} — ` +
      `${escapeHtml(run.documentName)}</title>`,
  );
  out.push(`<style>${HTML_STYLE}</style>`);
  out.push('</head><body>');
  out.push(`<h1>${escapeHtml(tChrome('panel.preflight.reportTitle'))}</h1>`);
  out.push(
    `<p class="meta">${escapeHtml(
      tChrome('panel.preflight.reportDocument', { name: run.documentName }),
    )}</p>`,
  );
  out.push(
    `<p class="meta">${escapeHtml(
      tChrome('panel.preflight.reportProfile', { name: profileName(report.profile) }),
    )}</p>`,
  );
  out.push(
    `<p class="meta">${escapeHtml(
      tChrome('panel.preflight.reportRunAt', { when: stamp(run.runAt) }),
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
      const rule = paramsLine(check);
      if (rule) out.push(`<div class="rule">${escapeHtml(rule)}</div>`);
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
      const hidden = hiddenFindings(check);
      if (hidden > 0) {
        out.push(
          `<div class="meta">${escapeHtml(
            tChrome('panel.preflight.moreFindings', { count: hidden }),
          )}</div>`,
        );
      }
      out.push('</td>');
      out.push('</tr>');
    }
    out.push('</tbody></table>');
  }

  if (report.unreadable.length > 0) {
    out.push(`<h2>${escapeHtml(tChrome('panel.preflight.unreadableHeading'))}</h2>`);
    out.push('<ul>');
    for (const branch of report.unreadable) {
      out.push(`<li>${escapeHtml(branch.reason)}</li>`);
    }
    out.push('</ul>');
  }
  out.push(`<p class="meta">${escapeHtml(tChrome('panel.preflight.reportFooter'))}</p>`);
  out.push('</body></html>');
  return out.join('\n') + '\n';
}
