// Output-folder ownership for the runs that live OUTSIDE the workspace.
//
// Batch OCR, disk redact, the four folder tools and Guided Actions folder runs
// read original paths by path and write into a mirror tree, or over the
// originals in place. They take neither the commit gate nor the per-file
// engine lock, deliberately — and both of those are per window anyway, so
// neither would serialize two runs sweeping one tree. Two runs writing the
// same tree overwrite each other's results file by file.
//
// The claim belongs to one RUN, not to its window: a window can have a run
// still finishing after its dialog closed while the user starts the next one.
// A run claims every folder it writes, all or none: its mirror tree, its
// source tree when it writes there, and every folder it files originals into.
// A claim per file over a ten-thousand-file tree is not a design. Nested
// folders conflict too, which the Rust side decides by containment rather than
// by string prefix.

import { claims } from './tauri-bridge';
import { createCallOrder } from './window-claims';
import { tChrome } from '../i18n';

// A release that has not answered still holds its run's folders, and nested
// folders conflict, so every output-folder call of this window goes through
// one queue: a claim is never processed ahead of a release sent before it.
const inClaimOrder = createCallOrder();
const CLAIM_QUEUE = 'output-folders';

export interface OutputRootClaim {
  granted: boolean;
  /** The refusal to show when `granted` is false, already localized. */
  message: string;
  /** Give the folders back. A no-op when the claim was refused, and after the
   * first call. */
  release: () => Promise<void>;
}

/** What one run writes, as the claim needs it. */
export interface RunFolders {
  source: string;
  dest: string;
  /** The run writes over its originals and has no mirror tree. */
  inPlace: boolean;
  /** Folders the run moves originals into. Empty entries are skipped. */
  filing?: readonly (string | null | undefined)[];
  /** The run replaces or moves originals inside its source tree. */
  changesSource?: boolean;
}

/** The folders one run writes. A mirror write replaces a same-named file, so
 * a filing folder that another run mirrors into would lose the originals filed
 * there: filing folders are claimed too. */
export function writtenRoots(run: RunFolders): string[] {
  const mirror = run.inPlace ? [] : [run.dest];
  const tree = run.inPlace || run.changesSource ? [run.source] : [];
  const filing = (run.filing ?? []).filter((root): root is string => Boolean(root));
  return [...mirror, ...tree, ...filing];
}

/**
 * Claim every folder one run writes, for the duration of the run. Empty
 * entries are skipped; a run with nothing to claim is granted at once.
 */
export async function claimOutputRoots(roots: readonly string[]): Promise<OutputRootClaim> {
  return claimWritten(roots, (outcome) =>
    outcome.document
      ? tChrome('app.window.folderHasOpenDocument', {
        name: baseName(outcome.document),
        folder: outcome.folder,
      })
      : tChrome(
        outcome.sameWindow ? 'app.window.folderBusyHere' : 'app.window.folderBusy',
        { folder: outcome.folder },
      ));
}

/**
 * Claim one output FILE for the write that creates it, the way Create PDF and
 * Combine reserve their outputs: an open document elsewhere in its folder is
 * no conflict, the file itself open, or a run writing it or its folder, is.
 * The refusal names the file.
 */
export async function claimOutputFile(path: string): Promise<OutputRootClaim> {
  return claimWritten([path], (outcome) => {
    const name = baseName(path);
    if (outcome.document) {
      return tChrome(outcome.sameWindow ? 'app.window.outputOpenHere' : 'app.window.outputOpenElsewhere', { name });
    }
    return tChrome(outcome.sameWindow ? 'app.window.outputBusyHere' : 'app.window.outputBusy', { name });
  });
}

const baseName = (path: string): string => path.split(/[\\/]/).pop() || path;

type Refusal = Awaited<ReturnType<typeof claims.claimOutputRoots>>;

async function claimWritten(
  roots: readonly string[],
  refusal: (outcome: Refusal) => string,
): Promise<OutputRootClaim> {
  const wanted = roots.filter((root) => root !== '');
  if (wanted.length === 0) {
    return { granted: true, message: '', release: async () => {} };
  }
  const outcome = await inClaimOrder(CLAIM_QUEUE, () => claims.claimOutputRoots(wanted));
  if (!outcome.granted) {
    return { granted: false, message: refusal(outcome), release: async () => {} };
  }
  const token = outcome.token;
  let held = true;
  return {
    granted: true,
    message: '',
    release: async () => {
      if (!held) return;
      held = false;
      try {
        await inClaimOrder(CLAIM_QUEUE, () => claims.releaseOutputRoots(token));
      } catch {
        // The claim outlives only this window, which releases every run it
        // held when it is destroyed.
      }
    },
  };
}
