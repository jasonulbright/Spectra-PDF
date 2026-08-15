// Preflight profiles as FILES: the impure edge of `preflight-profile.ts`.
//
// Separate from the model for the reason every other leaf split here is: the
// model is pure enough to unit-test (the file shape, the refusals, deriving,
// the picker order), and this is the part that touches the filesystem and the
// catalog. It is also the ONE implementation the panel and the e2e harness
// both call, so an import driven by a spec runs exactly the code a user's
// import runs — only the native file picker is skipped.
//
// **A profile file is what makes a print shop's rule hand-able to its
// customers**, which is the entire point of having profiles at all. So the
// export writes exactly the shape the import accepts, and the import refuses
// loudly and stores NOTHING on failure — a half-read rule set is a rule
// nobody wrote.

import { file } from './tauri-bridge';
import { tChrome } from '../i18n';
import type { UiKey } from '../i18n';
import {
  parseProfileFile,
  profileToJson,
  storeProfile,
  type PreflightProfile,
} from './preflight-profile';

/** Read, validate and store a profile file.
 *
 * Two validations, and they answer different questions. This module asks
 * whether the FILE is a profile; the engine asks whether the RULE is one it
 * can run, and it is the only thing that ever answers that. A file that
 * passes here and fails there is stored by neither.
 */
export async function importProfileFromPath(path: string): Promise<PreflightProfile> {
  const bytes = await file.readBuffer(path);
  const parsed = parseProfileFile(new TextDecoder().decode(bytes));
  if (!parsed.ok) {
    throw new Error(tChrome(parsed.refusal.key as UiKey, parsed.refusal.vars));
  }
  return parsed.profile;
}

/** Store a profile the engine has already accepted. */
export function keepProfile(profile: PreflightProfile): PreflightProfile[] {
  return storeProfile(profile);
}

/** Write a profile out in the same shape the import accepts. */
export async function exportProfileToPath(
  profile: PreflightProfile,
  path: string,
): Promise<void> {
  await file.writeBuffer(path, new TextEncoder().encode(profileToJson(profile)));
}
