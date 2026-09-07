import React, { useEffect, useRef, useState } from 'react';
import { tChrome } from '../../i18n';
import {
  groupByBoundary,
  type HealthFact,
  type HealthKind,
  type HealthVerdict,
} from '../../lib/doc-health';
import {
  healthBoundaryKey,
  healthKindKey,
  healthMessageKey,
  healthSubject,
} from '../../lib/doc-health-messages';

// The document-health indicator and its panel.
//
// ASK-FIRST, and that is the whole design: a glyph in the status bar that says
// only what state the document is in, and a panel that says the rest ONLY once
// the reader opens it. No toast, no auto-open, nothing said unprompted — the
// audit that registered this work found the opens are already silent, and the
// point is to make them auditable without making them noisy.
//
// OBSERVABILITY ONLY. Nothing on this surface changes the document; the one
// sentence about repair names the Repair tool and does not run it.

/** The glyph per verdict. A count rides beside it only where facts exist. */
const GLYPHS: Readonly<Record<HealthVerdict, string>> = {
  healthy: '✓',
  facts: '⚠',
  undetermined: '?',
  'no-evidence': '·',
};

/** The order facts read in within a boundary: what the reader recovered from,
 * then what stood in, then what was skipped, then what nobody could settle. */
const KIND_ORDER: readonly HealthKind[] = ['recovered', 'font', 'skipped', 'undetermined'];

export interface DocumentHealthSegmentProps {
  verdict: HealthVerdict;
  facts: readonly HealthFact[];
  /** Pages in the document the facts belong to — a page link is offered only
   * for an index this list actually holds. Resolved by the caller from the
   * current selectors, so no page id is ever stored in a fact. */
  pageCount: number;
  onGoToPage: (index: number) => void;
  onRecheck: () => void;
  /** A run for the current bytes is still in flight. */
  collecting: boolean;
}

function FactRow({
  fact,
  pageCount,
  onGoToPage,
}: {
  fact: HealthFact;
  pageCount: number;
  onGoToPage: (index: number) => void;
}): React.JSX.Element {
  const subject = healthSubject(fact.params);
  const page = fact.page;
  const linkable = page !== null && page >= 0 && page < pageCount;
  return (
    <li className={`doc-health-fact doc-health-${fact.severity}`}>
      <span className="doc-health-message">{tChrome(healthMessageKey(fact.code))}</span>
      {subject && <span className="doc-health-subject">{subject}</span>}
      {linkable && (
        <button
          type="button"
          className="doc-health-pagelink"
          title={tChrome('panel.health.goToPage', { page: page + 1 })}
          onClick={() => onGoToPage(page)}
        >
          {tChrome('panel.health.page', { page: page + 1 })}
        </button>
      )}
    </li>
  );
}

export function DocumentHealthSegment(props: DocumentHealthSegmentProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const { verdict, facts } = props;
  const groups = groupByBoundary(facts);
  const title = tChrome('panel.health.title');

  return (
    <div className="canvas-status-health" ref={wrapRef}>
      <button
        type="button"
        data-testid="doc-health-toggle"
        data-verdict={verdict}
        aria-expanded={open}
        aria-label={title}
        title={title}
        onClick={() => setOpen((v) => !v)}
        className={`canvas-status-action canvas-status-quiet doc-health-glyph doc-health-${verdict}`}
      >
        <span aria-hidden="true">{GLYPHS[verdict]}</span>
        {/* A bare numeral: notation in every locale, so it carries no key. */}
        {facts.length > 0 && <span className="doc-health-count">{facts.length}</span>}
      </button>
      {open && (
        <div
          className="canvas-status-health-popover"
          data-testid="doc-health-panel"
          role="group"
          aria-label={title}
        >
          <div className="doc-health-head">
            <span className="canvas-status-snap-title">{title}</span>
            <button
              type="button"
              data-testid="doc-health-recheck"
              className="canvas-status-action canvas-status-quiet"
              onClick={props.onRecheck}
            >
              {tChrome('panel.health.recheck')}
            </button>
          </div>
          {verdict === 'no-evidence' && (
            <p className="doc-health-state">
              {tChrome(props.collecting ? 'panel.health.checking' : 'panel.health.noEvidence')}
            </p>
          )}
          {verdict === 'healthy' && (
            <p className="doc-health-state">{tChrome('panel.health.healthy')}</p>
          )}
          {verdict === 'undetermined' && (
            <p className="doc-health-state">{tChrome('panel.health.undetermined')}</p>
          )}
          {groups.map((group) => (
            <section key={group.boundary} className="doc-health-group">
              <h3 className="canvas-status-snap-title">
                {tChrome(healthBoundaryKey(group.boundary))}
              </h3>
              {KIND_ORDER.filter((kind) => group.facts.some((f) => f.kind === kind)).map(
                (kind) => (
                  <div key={kind} className="doc-health-kind">
                    <div className="doc-health-kind-title">{tChrome(healthKindKey(kind))}</div>
                    <ul className="doc-health-list">
                      {group.facts
                        .filter((f) => f.kind === kind)
                        .map((fact, i) => (
                          <FactRow
                            // Facts carry no identity of their own and are
                            // regenerated wholesale per collection, so the
                            // position within its (boundary, kind) list is the
                            // only honest key.
                            key={`${fact.code}:${fact.page ?? ''}:${i}`}
                            fact={fact}
                            pageCount={props.pageCount}
                            onGoToPage={props.onGoToPage}
                          />
                        ))}
                    </ul>
                  </div>
                ),
              )}
            </section>
          ))}
          <p className="doc-health-hint">{tChrome('panel.health.repairHint')}</p>
        </div>
      )}
    </div>
  );
}
