// N11 slice D — symbol sets as FILES: the impure edge of `symbol-library.ts`.
//
// Separate from the library for the reason every other leaf split here is:
// the library is pure enough to unit-test (schema, refusals, lookup, search),
// and this is the part that touches the filesystem and the catalog. It is also
// the ONE implementation the palette, the panel and the e2e harness all call,
// so an import driven by a spec runs exactly the code a user's import runs —
// only the native file picker is skipped.

import { file } from './tauri-bridge';
import { tChrome } from '../i18n';
import type { UiKey } from '../i18n';
import {
  addSymbolSet,
  parseSymbolSetFile,
  symbolSetToJson,
  type SymbolSet,
} from './symbol-library';

export interface SymbolSetImport {
  set: SymbolSet;
  outcome: 'added' | 'updated';
}

/**
 * Read, validate and store a symbol-set file.
 *
 * Refusals are LOUD (the guided-actions import precedent): the library
 * returns a catalog key plus the offending symbol id, and it is resolved here,
 * at the boundary that has the i18n layer. A file that cannot be imported
 * imports NOTHING — never a partial set, because a symbol silently missing
 * from a set is a symbol the drafter will look for and not find.
 */
export async function importSymbolSetFromPath(path: string): Promise<SymbolSetImport> {
  const bytes = await file.readBuffer(path);
  const parsed = parseSymbolSetFile(new TextDecoder().decode(bytes));
  if (!parsed.ok) {
    throw new Error(tChrome(parsed.refusal.key as UiKey, parsed.refusal.vars));
  }
  const outcome = addSymbolSet(parsed.set);
  return { set: parsed.set, outcome };
}

/** Write a set out in the same shape the import accepts — that is what makes
 * "a firm's standard set" portable between machines. */
export async function exportSymbolSetToPath(set: SymbolSet, path: string): Promise<void> {
  await file.writeBuffer(path, new TextEncoder().encode(symbolSetToJson(set)));
}
