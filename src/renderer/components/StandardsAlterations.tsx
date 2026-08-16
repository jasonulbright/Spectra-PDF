import React from 'react';
import { useTranslation } from 'react-i18next';
import { tChrome, tNumber } from '../i18n';
import {
  countIsMeaningful,
  detailLines,
  rowLabel,
  type AlterationRow,
  type StandardsReport,
} from '../lib/standards-report';

// What a PDF/A or PDF/X conversion cost the document, shown beside the
// result that reports success.
//
// A conversion reaches conformance partly by DELETING content, and the file it
// writes carries a machine-readable conformance claim either way — so a result
// line reporting only success leaves the loss invisible to the one person
// converting a document in order to keep it. Every row the engine reports is
// drawn: a loss states what went, and a check that could not run says so
// instead of being absent, because an absent row and a clean row would look
// the same.
//
// Producer text is quoted, never paraphrased: it is another program's wording,
// unrecognized and untranslated, and presenting it as this app's own words
// would attribute a claim nobody here made.

function AlterationEntry({ row }: { row: AlterationRow }): React.ReactElement {
  const lines = detailLines(row);
  return (
    <li
      data-testid={`standards-row-${row.kind}`}
      data-standards-kind={row.kind}
      data-standards-undetermined={row.undetermined ? 'true' : 'false'}
      className="flex flex-col gap-0.5"
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className={row.undetermined ? 'text-amber-400' : 'text-neutral-200'}>
          {rowLabel(row.kind)}
        </span>
        {!row.undetermined && countIsMeaningful(row) && (
          <span className="shrink-0 tabular-nums text-neutral-400">{tNumber(row.count)}</span>
        )}
      </div>
      {row.undetermined && (
        <div className="text-xs text-amber-400/80">{tChrome('panel.standards.undetermined')}</div>
      )}
      {row.undetermined && row.reason && (
        <div className="font-mono text-xs text-neutral-500 break-words">{row.reason}</div>
      )}
      {lines.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {lines.map((line, i) => (
            <li
              key={i}
              className={`text-xs break-words ${
                line.verbatim ? 'font-mono text-neutral-500' : 'text-neutral-400'
              }`}
            >
              {line.text}
            </li>
          ))}
        </ul>
      )}
      {row.detail_truncated && (
        <div className="text-xs text-neutral-500">
          {tChrome('panel.standards.detailTruncated', { count: String(lines.length) })}
        </div>
      )}
    </li>
  );
}

export function StandardsAlterations({
  report,
}: {
  report: StandardsReport | null;
}): React.ReactElement | null {
  // Re-render on language change; strings resolve via tChrome.
  useTranslation();
  if (!report) return null;
  const notices = report.producer_notices;
  return (
    <section data-testid="standards-alterations" className="flex flex-col gap-2 text-sm">
      <div className="text-neutral-400">{tChrome('panel.standards.heading')}</div>
      {report.altered.length === 0 ? (
        <div data-testid="standards-clean" className="text-neutral-300">
          {tChrome('panel.standards.clean')}
        </div>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {report.altered.map((row, i) => (
            <AlterationEntry key={`${row.kind}:${i}`} row={row} />
          ))}
        </ul>
      )}
      {notices.length > 0 && (
        <details data-testid="standards-notices">
          <summary className="cursor-pointer text-xs text-neutral-400">
            {tChrome('panel.standards.notices')}
          </summary>
          <ul className="mt-1 flex flex-col gap-0.5">
            {notices.map((notice, i) => (
              <li key={i} className="font-mono text-xs text-neutral-500 break-words">
                {notice}
              </li>
            ))}
          </ul>
          {report.notices_truncated && (
            <div className="mt-1 text-xs text-neutral-500">
              {tChrome('panel.standards.noticesTruncated', { count: String(notices.length) })}
            </div>
          )}
        </details>
      )}
    </section>
  );
}
