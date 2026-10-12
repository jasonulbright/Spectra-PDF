// pdf-lib's parser decodes a name's `#` escapes (ISO 32000-2 7.3.5) only when
// the pair is decimal digits or uppercase hex letters, and keeps a pair
// holding a lowercase a-f as the three characters; its writer then writes
// that `#` as `#23`. A file key `/B#6frder` (`Border` to pdf.js) is therefore
// saved as `/B#236frder`, which every reader takes as `B#6frder`, on every
// save. `normalizeEscapedNames` rewrites each such name, key or value, to its
// decoded spelling right after a load, so the document model and the saved
// bytes read as pdf.js reads the file.
//
// A file that wrote `#23` before such a pair (`/B#236frder`, which pdf.js
// reads as `B#6frder`) parses to the same name and is re-read as the decoded
// `Border`. A dictionary in which a rewritten key would meet a key it already
// holds is left as it is: which of the two pdf.js keeps depends on file order
// the parse no longer holds.
import { PDFArray, PDFDict, PDFName, PDFStream } from 'pdf-lib';
import type { PDFDocument, PDFObject } from 'pdf-lib';
import { pdfNameKey } from './pdf-text-string';

const isLowerHexLetter = (code: number): boolean => code >= 0x61 && code <= 0x66;
const isHexCode = (code: number): boolean =>
  (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x46) || isLowerHexLetter(code);

/** Whether a parsed name still holds an escape the parser left undecoded. */
export function holdsLowercaseEscape(name: PDFName): boolean {
  const text = name.asString();
  if (!text.includes('#')) return false;
  const bytes = name.asBytes();
  for (let i = 0; i + 2 < bytes.length; i++) {
    if (bytes[i] !== 0x23) continue;
    const first = bytes[i + 1];
    const second = bytes[i + 2];
    if (isHexCode(first) && isHexCode(second) && (isLowerHexLetter(first) || isLowerHexLetter(second))) return true;
  }
  return false;
}

/** The decoded name for one that holds an undecoded escape, else the name.
 *  `PDFName.of` decodes `#` pairs in the text it is given, so each `#` left in
 *  the decoded spelling is handed over as `#23`. */
function decoded(name: PDFName): PDFName {
  return holdsLowercaseEscape(name) ? PDFName.of(pdfNameKey(name).replace(/#/g, '#23')) : name;
}

function visitDict(dict: PDFDict): void {
  const entries = dict.entries();
  let renamed = false;
  for (const [key, value] of entries) {
    if (value instanceof PDFName) {
      const next = decoded(value);
      if (next !== value) dict.set(key, next);
    } else visit(value);
    if (!renamed && holdsLowercaseEscape(key)) renamed = true;
  }
  if (!renamed) return;
  const keys = entries.map(([key]) => decoded(key));
  if (new Set(keys).size !== keys.length) return;
  for (let i = 0; i < entries.length; i++) {
    const [key] = entries[i];
    if (keys[i] === key) continue;
    const value = dict.get(key, true);
    dict.delete(key);
    if (value !== undefined) dict.set(keys[i], value);
  }
}

function visitArray(array: PDFArray): void {
  for (let i = 0; i < array.size(); i++) {
    const value = array.get(i);
    if (value instanceof PDFName) {
      const next = decoded(value);
      if (next !== value) array.set(i, next);
    } else visit(value);
  }
}

function visit(value: PDFObject | undefined): void {
  if (value instanceof PDFDict) visitDict(value);
  else if (value instanceof PDFArray) visitArray(value);
  else if (value instanceof PDFStream) visitDict(value.dict);
}

/** Rewrites every name the parser left with an undecoded escape, in every
 *  indirect object and the trailer, to its decoded spelling. A document with
 *  no such name is walked once and gains no new name. */
export function normalizeEscapedNames(doc: PDFDocument): void {
  for (const [, object] of doc.context.enumerateIndirectObjects()) visit(object);
  const trailer = doc.context.trailerInfo;
  for (const value of [trailer.Root, trailer.Info, trailer.Encrypt, trailer.ID]) visit(value);
}
