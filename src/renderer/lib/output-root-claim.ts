// Output-folder ownership for the runs that live OUTSIDE the workspace.
//
// Batch OCR, disk redact and the four folder tools read original paths by path
// and write into a mirror or output tree. They take neither the commit gate
// nor the per-file engine lock, deliberately — and both of those are per
// window anyway, so neither would serialize two windows sweeping one tree.
// What they share is the DESTINATION, and two runs writing the same output
// tree overwrite each other's results file by file.
//
// The claim is on the output ROOT, not on the inputs: a claim per file over a
// ten-thousand-file tree is not a design, and inputs are read-only. Nested
// roots conflict too, which the Rust side decides by containment rather than
// by string prefix.

import { claims } from './tauri-bridge';
import { createCallOrder, createClaimHolds } from './window-claims';
import { tChrome } from '../i18n';

// The arbiter's root claim is idempotent per window and its release drops the
// window's claim whatever preceded it. A dialog shows its finished phase while
// the run's release is still in flight, so the next run's claim can be
// processed first and then lose to that release, leaving the run unclaimed.
// Each call on a root is sent only after the previous call on that root from
// this window has answered, and a release is sent only when no run of this
// window holds the root at its turn: a run that is still stopping after its
// dialog closed must not take the next run's claim with it.
const inRootOrder = createCallOrder();
const rootHolds = createClaimHolds();

export interface OutputRootClaim {
  granted: boolean;
  /** The refusal to show when `granted` is false, already localized. */
  message: string;
  /** Give the root back. A no-op when the claim was refused. */
  release: () => Promise<void>;
}

/**
 * Claim `root` for the duration of a run. `root` may be empty — an in-place
 * run writes over its own sources and has no output tree to own.
 */
export async function claimOutputRoot(root: string): Promise<OutputRootClaim> {
  if (!root) {
    return { granted: true, message: '', release: async () => {} };
  }
  rootHolds.hold([root]);
  let outcome: Awaited<ReturnType<typeof claims.claimOutputRoot>>;
  try {
    outcome = await inRootOrder(root, () => claims.claimOutputRoot(root));
  } catch (error) {
    rootHolds.drop([root]);
    throw error;
  }
  if (!outcome.granted) {
    rootHolds.drop([root]);
    return {
      granted: false,
      message: tChrome('app.window.folderBusy', { folder: root }),
      release: async () => {},
    };
  }
  let held = true;
  return {
    granted: true,
    message: '',
    release: async () => {
      if (!held) return;
      held = false;
      rootHolds.drop([root]);
      try {
        await inRootOrder(root, async () => {
          if (!rootHolds.held(root)) await claims.releaseOutputRoot(root);
        });
      } catch {
        // The claim outlives only this window, which releases everything it
        // held when it is destroyed.
      }
    },
  };
}
