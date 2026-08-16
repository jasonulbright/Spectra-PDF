/**
 * Inventory of the WARN/ERROR rows a run printed, grouped against
 * `log-registry.ts`.
 *
 * Reads saved text rather than a live stream: colour is stripped on redirect,
 * which is how every battery is captured, so the rows survive there while the
 * red that made them noticeable does not.
 *
 * Three groups:
 *   UNEXPLAINED  rows matching no registry entry — the queue to fix.
 *   KNOWN        registered rows, counted, not expanded.
 *   STALE        registry entries that matched nothing in this run.
 *
 * STALE is reported as loudly as UNEXPLAINED: an entry that stops matching is
 * permission still granted for a row nobody is producing, and it keeps
 * suppressing its pattern after the spec that justified it changes meaning.
 *
 * The scanner never decides a run. `wdio.conf.ts` calls it from `onComplete`
 * and swallows anything it throws, so the suite's exit code stays WebdriverIO's
 * verdict alone.
 *
 * Standalone:  npx tsx scan-run-log.ts <path-to-saved-log>
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { KNOWN_LOG_ROWS, type KnownLogRow } from './log-registry.js';

/** `[0-122] 2026-…Z WARN webdriver: WebDriverError: …` — the cid prefix is
 * absent in a per-runner log, so it is optional. */
const ROW_RE =
  /^(?:\[(?<cid>[^\]]+)\]\s+)?\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+(?<level>WARN|ERROR)\s+(?<component>[^\s:]+):\s*(?<message>.*)$/;

/** `[0-122] RUNNING in undefined - file:///…/specs/71-scheduled-runs.spec.ts` */
const RUNNING_RE = /^(?:\[(?<cid>[^\]]+)\]\s+)?RUNNING in .*?\s-\s(?<url>\S+\.spec\.ts)\s*$/;

const ANSI_RE = /\u001b\[[0-9;]*m/g;

export type Level = 'WARN' | 'ERROR';

interface Row {
  level: Level;
  component: string;
  message: string;
  spec: string | null;
}

export interface RowGroup {
  component: string;
  message: string;
  counts: Record<Level, number>;
  /** Occurrences per spec, in first-seen order. Empty when the log carries no
   * attribution for any occurrence. */
  specs: { spec: string; count: number }[];
  /** Occurrences the log could not attribute to a spec. */
  unattributed: number;
}

export interface Inventory {
  totalRows: number;
  unexplained: RowGroup[];
  known: { entry: KnownLogRow; counts: Record<Level, number> }[];
  stale: KnownLogRow[];
}

function parseRows(text: string): Row[] {
  const specByCid = new Map<string, string>();
  const rows: Row[] = [];
  let lastSpec: string | null = null;

  for (const raw of text.replace(ANSI_RE, '').split(/\r?\n/)) {
    const running = RUNNING_RE.exec(raw);
    if (running) {
      const spec = basename(running.groups!.url);
      if (running.groups!.cid) specByCid.set(running.groups!.cid, spec);
      lastSpec = spec;
      continue;
    }
    const row = ROW_RE.exec(raw);
    if (!row) continue;
    const cid = row.groups!.cid;
    rows.push({
      level: row.groups!.level as Level,
      component: row.groups!.component,
      message: row.groups!.message.trim(),
      // A per-runner log has no cid on either line shape, so the running spec
      // is the only attribution available there.
      spec: (cid ? specByCid.get(cid) : lastSpec) ?? null,
    });
  }
  return rows;
}

/** An entry claims a row when the message matches AND — where the log knows
 * which spec produced it — the spec is the one the entry names. */
function claims(entry: KnownLogRow, row: Row): boolean {
  if (!entry.match.test(row.message)) return false;
  return row.spec === null || row.spec === entry.spec;
}

export function buildInventory(
  text: string,
  registry: readonly KnownLogRow[] = KNOWN_LOG_ROWS,
): Inventory {
  const rows = parseRows(text);
  const known = registry.map((entry) => ({ entry, counts: { WARN: 0, ERROR: 0 } as Record<Level, number> }));
  const groups = new Map<string, RowGroup>();

  for (const row of rows) {
    const hit = known.find((k) => claims(k.entry, row));
    if (hit) {
      hit.counts[row.level] += 1;
      continue;
    }
    const key = `${row.component} ${row.message}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        component: row.component,
        message: row.message,
        counts: { WARN: 0, ERROR: 0 },
        specs: [],
        unattributed: 0,
      };
      groups.set(key, group);
    }
    group.counts[row.level] += 1;
    if (row.spec === null) {
      group.unattributed += 1;
    } else {
      const seen = group.specs.find((s) => s.spec === row.spec);
      if (seen) seen.count += 1;
      else group.specs.push({ spec: row.spec, count: 1 });
    }
  }

  const total = (c: Record<Level, number>) => c.WARN + c.ERROR;
  return {
    totalRows: rows.length,
    unexplained: [...groups.values()].sort((a, b) => total(b.counts) - total(a.counts)),
    known: known.filter((k) => total(k.counts) > 0),
    stale: known.filter((k) => total(k.counts) === 0).map((k) => k.entry),
  };
}

function tally(counts: Record<Level, number>): string {
  const parts: string[] = [];
  if (counts.ERROR) parts.push(`${counts.ERROR} ERROR`);
  if (counts.WARN) parts.push(`${counts.WARN} WARN`);
  return parts.join(' + ') || '0';
}

export function formatInventory(inventory: Inventory, source: string): string {
  const out: string[] = [];
  const rule = '='.repeat(70);
  out.push(rule);
  out.push(`e2e log inventory — ${source}`);
  out.push(`${inventory.totalRows} WARN/ERROR row(s) in this run`);
  out.push(rule);

  out.push('');
  if (inventory.unexplained.length === 0) {
    out.push('UNEXPLAINED: none.');
  } else {
    const rows = inventory.unexplained.reduce(
      (n, g) => n + g.counts.WARN + g.counts.ERROR,
      0,
    );
    out.push(
      `UNEXPLAINED — ${inventory.unexplained.length} message(s), ${rows} row(s). These are the ones to fix.`,
    );
    for (const g of inventory.unexplained) {
      out.push(`  [${tally(g.counts)}] ${g.component}: ${g.message}`);
      const where = g.specs.map((s) => `${s.spec} x${s.count}`);
      if (g.unattributed) where.push(`(no spec attributed) x${g.unattributed}`);
      out.push(`      under: ${where.join(', ')}`);
    }
  }

  out.push('');
  if (inventory.known.length === 0) {
    out.push('KNOWN: none matched.');
  } else {
    out.push(`KNOWN — ${inventory.known.length} registry entry/entries matched:`);
    for (const k of inventory.known) {
      out.push(`  [${tally(k.counts)}] ${k.entry.id} (${k.entry.spec})`);
    }
  }

  out.push('');
  if (inventory.stale.length === 0) {
    out.push('STALE: none — every registry entry matched something.');
  } else {
    out.push(
      `STALE — ${inventory.stale.length} registry entry/entries matched NOTHING in this run.`,
    );
    out.push('  An entry that stops matching is standing permission for a row nobody produces.');
    out.push('  Re-verify the spec still provokes it, or delete the entry.');
    for (const entry of inventory.stale) {
      out.push(`  * ${entry.id} (${entry.spec}) ${entry.match}`);
    }
  }

  out.push(rule);
  return out.join('\n');
}

export function scanText(text: string, source: string): string {
  return formatInventory(buildInventory(text), source);
}

export function scanFile(path: string): string {
  return scanText(readFileSync(path, 'utf-8'), path);
}

const invokedDirectly =
  typeof process.argv[1] === 'string' && /scan-run-log\.[cm]?[jt]s$/.test(process.argv[1]);

if (invokedDirectly) {
  const target = process.argv[2];
  if (!target) {
    process.stderr.write('usage: npx tsx scan-run-log.ts <path-to-saved-run-log>\n');
    process.exit(2);
  }
  process.stdout.write(`${scanFile(target)}\n`);
}
