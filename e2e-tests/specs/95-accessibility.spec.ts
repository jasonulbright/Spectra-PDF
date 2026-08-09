// WCAG 2.1 A/AA evidence, run against the LIVE app: an axe-core sweep
// of every major surface (the shared walk in support/surface-walk.ts: home,
// the open document, every tool and every op panel inside them, every nav
// panel, the find bar, an open menu, the Properties dialog, every
// Preferences category), in all three shipped themes. The gate is DEFINITE
// violations at zero; axe's "incomplete" results (checks it could not
// decide, mostly overlapping/transparent layers like the pdf.js text layer)
// are recorded in the report file for review but do not gate — an
// undecidable is not a defect finding.
//
// The full inventory of every run is written to a11y-report.local.json
// (gitignored) so a failure can be worked from the data instead of re-run.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect } from '@wdio/globals';
import { waitForHarness } from '../support/harness.js';
import { WALK_THEMES, walkSurfaces, stampTheme } from '../support/surface-walk.js';

const REPORT_PATH = resolve(__dirname, '..', 'a11y-report.local.json');
const AXE_SOURCE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf-8');

interface ViolationRecord {
  theme: string;
  surface: string;
  rule: string;
  impact: string;
  help: string;
  nodes: { target: string; summary: string; html: string }[];
}

const violations: ViolationRecord[] = [];
const incomplete: { theme: string; surface: string; rule: string; count: number }[] = [];

async function injectAxe(): Promise<void> {
  const present = await browser.execute(
    () => typeof (window as never as { axe?: unknown }).axe !== 'undefined',
  );
  if (!present) await browser.execute(AXE_SOURCE);
}

async function runAxe(theme: string, surface: string): Promise<void> {
  await injectAxe();
  type AxeOut = {
    violations: {
      id: string;
      impact?: string;
      help: string;
      nodes: { target: unknown[]; failureSummary?: string; html?: string }[];
    }[];
    incomplete: { id: string; nodes: number }[];
  };
  const result = (await browser.executeAsync((done: (r: unknown) => void) => {
    const axe = (window as never as { axe: { run: (ctx: unknown, opts: unknown) => Promise<unknown> } }).axe;
    axe
      .run(document, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
        resultTypes: ['violations', 'incomplete'],
      })
      .then((r) => {
        const rr = r as {
          violations: {
            id: string;
            impact?: string;
            help: string;
            nodes: { target: unknown[]; failureSummary?: string; html?: string }[];
          }[];
          incomplete: { id: string; nodes: unknown[] }[];
        };
        done({
          violations: rr.violations.map((v) => ({
            id: v.id,
            impact: v.impact,
            help: v.help,
            nodes: v.nodes.slice(0, 10).map((n) => ({
              target: n.target,
              failureSummary: n.failureSummary,
              html: (n.html ?? '').slice(0, 300),
            })),
          })),
          incomplete: rr.incomplete.map((i) => ({ id: i.id, nodes: i.nodes.length })),
        });
      })
      .catch((e: unknown) => done({ error: String(e) }));
  })) as AxeOut | { error: string };

  if ('error' in result) {
    throw new Error(`axe.run failed on ${theme}/${surface}: ${result.error}`);
  }
  for (const v of result.violations) {
    violations.push({
      theme,
      surface,
      rule: v.id,
      impact: v.impact ?? 'unknown',
      help: v.help,
      nodes: v.nodes.map((n) => ({
        target: (n.target as string[]).join(' '),
        summary: n.failureSummary ?? '',
        html: n.html ?? '',
      })),
    });
  }
  for (const i of result.incomplete) {
    incomplete.push({ theme, surface, rule: i.id, count: i.nodes });
  }
}

describe('WCAG 2.1 A/AA sweep', () => {
  it('boots with the harness', async () => {
    await waitForHarness();
  });

  for (const theme of WALK_THEMES) {
    it(`sweeps every surface — ${theme}`, async function () {
      this.timeout(300_000);
      await walkSurfaces(theme, runAxe);
    });
  }

  it('found zero definite violations (report: a11y-report.local.json)', async () => {
    // Default theme back in place for whatever runs next in a shared session.
    await stampTheme('dark');
    writeFileSync(
      REPORT_PATH,
      JSON.stringify({ generated: new Date().toISOString(), violations, incomplete }, null, 2),
    );
    const byRule = new Map<string, number>();
    for (const v of violations) {
      byRule.set(`${v.rule} [${v.impact}]`, (byRule.get(`${v.rule} [${v.impact}]`) ?? 0) + v.nodes.length);
    }
    const summary = [...byRule.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k} × ${n}`)
      .join('; ');
    if (violations.length > 0) {
      throw new Error(
        `axe found ${violations.length} WCAG A/AA violation records: ${summary} — full detail in a11y-report.local.json`,
      );
    }
    expect(violations.length).toBe(0);
  });
});
