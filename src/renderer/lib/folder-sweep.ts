// What every folder sweep shares — the pieces a second sweep would otherwise
// copy.
//
// A sweep reads a picked tree BY PATH (never through the workspace), decides
// per file whether it may write, mirrors what it produced, and reports one
// result per file. The walk, the copy and the identity check are the shipped
// Rust commands; what lives here is the small amount of reasoning between
// them, so the mirror key, the eligibility rule and the signature vocabulary
// have ONE implementation across every sweep.

import { rawEngineMessage } from './engine-messages';
import type { SignedEditReason } from './signatures';

export interface DiskEntry {
  /** Canonical absolute source path (engine input, copy input). */
  abs: string;
  /** Tree position relative to the source root (the mirror key). */
  rel: string;
}

/** What a file's own signatures said about the write a run intends. */
export interface SignedNote {
  reason: SignedEditReason;
  count: number;
  /** The decision refuses outright — no consent makes this file writable. */
  refused: boolean;
}

/** The two properties every sweep result carries about whether it may be
 * written: the engine's own English for a file that could not be read, and
 * what the file's signatures said. */
export interface SweepEligibility {
  skipReason: string | null;
  signed: SignedNote | null;
}

export interface SweepRunOptions<Progress> {
  onProgress?: (p: Progress) => void;
  /** Polled between files; a true return stops after the in-flight one. */
  isCancelled?: () => boolean;
}

/** Join a mirror destination from the root and a source-relative key, in the
 * separator style the root already uses (the rel arrives from the Rust walk
 * with platform separators). */
export function joinDest(destRoot: string, rel: string): string {
  const sep = destRoot.includes('/') && !destRoot.includes('\\') ? '/' : '\\';
  const trimmed =
    destRoot.endsWith('\\') || destRoot.endsWith('/') ? destRoot.slice(0, -1) : destRoot;
  return `${trimmed}${sep}${rel}`;
}

/** The English text of a failure, for the report and the log — byte-identical
 * to what the engine sent, whatever language the UI is in. */
export function engineMessageOf(err: unknown): string {
  return rawEngineMessage(err);
}

/** English for a signature decision, for the log and the report. A surface
 * renders its own catalog string from the same `reason`. */
export function signedReasonText(note: SignedNote): string {
  switch (note.reason) {
    case 'certified-no-changes':
      return 'certified to allow no changes';
    case 'certified-form-fill':
      return 'certified for form filling only';
    case 'certified-annotate':
      return 'certified for annotation only';
    case 'certified-unknown':
      return 'certified at a level this build cannot read';
    case 'signed':
      return `signed (${note.count} signature${note.count === 1 ? '' : 's'})`;
  }
}

/** Is this file writable by this run? A refusing signature decision is never
 * consentable; a warning one is, once the run says signed documents are in. */
export function fileIsEligible(file: SweepEligibility, includeSigned: boolean): boolean {
  if (file.skipReason !== null) return false;
  if (file.signed === null) return true;
  return !file.signed.refused && includeSigned;
}

/** The English reason a file cannot be written, or null when it can. */
export function ineligibleReason(
  file: SweepEligibility,
  includeSigned: boolean,
): string | null {
  if (file.skipReason !== null) return file.skipReason;
  if (file.signed === null) return null;
  if (fileIsEligible(file, includeSigned)) return null;
  return signedReasonText(file.signed);
}
