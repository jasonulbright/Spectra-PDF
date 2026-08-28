// A failed open has to say something, and what it says must name the file the
// USER chose. Every engine refusal on the open path is raised against the temp
// WORKING COPY (`create_working_copy` mints a fresh temp directory per open),
// and qpdf prefixes its message with the path it was handed — so passing the
// engine's text through verbatim shows a temp path for a file the user never
// named. These two functions are the whole of that translation and of the
// per-file aggregation, kept pure so both are testable without a DOM.

/** One file's outcome from a single open batch. `reason === null` ⇒ it opened. */
export interface OpenOutcome {
  readonly name: string;
  readonly reason: string | null;
}

export type OpenSummary =
  | { readonly kind: 'none' }
  | { readonly kind: 'single'; readonly name: string; readonly reason: string }
  | {
      readonly kind: 'batch';
      readonly openedCount: number;
      readonly totalCount: number;
      readonly failures: readonly { readonly name: string; readonly reason: string }[];
    };

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A path matcher that is indifferent to separator spelling and case — the
 * working copy travels as a Windows path and can come back from the engine
 * with either separator.
 */
function pathPattern(path: string): RegExp {
  const body = path
    .split(/[\\/]/)
    .map(escapeRegExp)
    .join('[\\\\/]');
  return new RegExp(body, 'gi');
}

// Any remaining absolute path that names a PDF. Reached only when the specific
// paths above did not match (the engine composed the path differently, or the
// throw happened before a working path existed). Anchored on the `.pdf`
// extension so structural text in a qpdf message — `/Root`, `/Pages` — is left
// alone.
const ABSOLUTE_PDF_PATH = /(?:[A-Za-z]:[\\/]|\/)(?:[^\s:*?"<>|]*[\\/])*[^\s:*?"<>|]*\.pdf\b/gi;

/**
 * Rewrites an open failure's message so it names `name` — the file the user
 * chose — wherever it named a path, and drops a leading `<name>: ` prefix the
 * surrounding sentence already supplies. The engine's own reason sentence is
 * otherwise preserved verbatim: it is the only thing that says WHY.
 */
export function translateOpenFailure(
  raw: string,
  opts: { name: string; workingPath?: string | null; path?: string | null },
): string {
  let message = String(raw ?? '').trim();
  for (const candidate of [opts.workingPath, opts.path]) {
    if (candidate) message = message.replace(pathPattern(candidate), opts.name);
  }
  message = message.replace(ABSOLUTE_PDF_PATH, opts.name);
  // qpdf's `<file>: <reason>` shape, now `<name>: <reason>`. The frame around
  // this text already names the file, so a repeat reads as a stutter. Looped:
  // a nested call can leave the prefix twice.
  const prefix = new RegExp('^' + escapeRegExp(opts.name) + '\\s*:\\s*');
  while (prefix.test(message)) message = message.replace(prefix, '');
  return message.trim();
}

/**
 * Collapses a batch's per-file outcomes into ONE description. A single file
 * that failed reads as itself; anything larger reads as counts plus the
 * per-file reasons, so a multi-file open never produces a dialog per file.
 */
export function summarizeOpenOutcomes(outcomes: readonly OpenOutcome[]): OpenSummary {
  const failures = outcomes
    .filter((o): o is OpenOutcome & { reason: string } => o.reason !== null)
    .map((o) => ({ name: o.name, reason: o.reason }));
  if (failures.length === 0) return { kind: 'none' };
  if (outcomes.length === 1) {
    return { kind: 'single', name: failures[0].name, reason: failures[0].reason };
  }
  return {
    kind: 'batch',
    openedCount: outcomes.length - failures.length,
    totalCount: outcomes.length,
    failures,
  };
}
