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
import { tChrome } from '../i18n';

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
  const outcome = await claims.claimOutputRoot(root);
  if (!outcome.granted) {
    return {
      granted: false,
      message: tChrome('app.window.folderBusy', { folder: root }),
      release: async () => {},
    };
  }
  return {
    granted: true,
    message: '',
    release: async () => {
      try {
        await claims.releaseOutputRoot(root);
      } catch {
        // The claim outlives only this window, which releases everything it
        // held when it is destroyed.
      }
    },
  };
}
