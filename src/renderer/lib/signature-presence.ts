import { PDFArray, PDFDict, PDFName, PDFNull, PDFRef } from 'pdf-lib';
import type { PDFDocument } from 'pdf-lib';
import { rawEntry } from './annotation-fingerprint';
import { pdfNameKey } from './pdf-text-string';

const MAX_FIELD_DEPTH = 32;
const FIELD_TYPES = new Set(['Sig', 'Tx', 'Btn', 'Ch']);

/** Whether a loaded document carries, or cannot exclude, a FILLED signature
 *  field: a terminal `/FT /Sig` (inheritable) with a `/V`, or catalog
 *  certification. Keys are read by their decoded spelling, so a document read
 *  before its names are rewritten (`/Acr#6fForm`) answers as it will after.
 *  Unknown structure answers true. Throws on an unresolvable reference. */
export function docCarriesLiveSignature(doc: PDFDocument): boolean {
  const resolve = (value: unknown): unknown => {
    if (!(value instanceof PDFRef)) return value;
    const resolved = doc.context.lookup(value);
    if (resolved === undefined) throw new Error('unresolved policy reference');
    return resolved;
  };
  const present = (dict: PDFDict, key: string): boolean => {
    const value = rawEntry(dict, key);
    return value !== undefined && value !== PDFNull;
  };
  const asDict = (value: unknown): PDFDict | null => {
    const r = resolve(value);
    return r instanceof PDFDict ? r : null;
  };
  const asArray = (value: unknown): PDFArray | null => {
    const r = resolve(value);
    return r instanceof PDFArray ? r : null;
  };
  const nameOf = (value: unknown): string | undefined => (value instanceof PDFName ? pdfNameKey(value) : undefined);
  // Depth-bounded: a /Kids cycle in a damaged field tree would otherwise
  // recur forever.
  const walk = (field: PDFDict, inheritedFt: unknown, depth: number): boolean => {
    if (depth > MAX_FIELD_DEPTH) return true;
    const ownRaw = rawEntry(field, 'FT');
    const own = ownRaw === PDFNull ? undefined : resolve(ownRaw);
    const ft = own === undefined ? inheritedFt : own;
    if (ft !== undefined && !FIELD_TYPES.has(nameOf(ft) ?? '')) return true;
    // /Kids may be separate widget annotations: /V belongs to their
    // terminal field, not to the leaf widgets. Match the engine's walk.
    const valueRaw = rawEntry(field, 'V');
    const value = valueRaw === PDFNull ? undefined : resolve(valueRaw);
    if (nameOf(ft) === 'Sig' && value !== undefined && value !== PDFNull) return true;
    const kids = asArray(rawEntry(field, 'Kids'));
    if (!kids) return present(field, 'Kids') || ft === undefined;
    if (kids.size() === 0 && ft === undefined) return true;
    for (let i = 0; i < kids.size(); i++) {
      const kid = asDict(kids.get(i));
      if (!kid || walk(kid, ft, depth + 1)) return true;
    }
    return false;
  };
  // Catalog certification and unreadable structures are not unsignedness.
  if (present(doc.catalog, 'Perms')) return true;
  const acro = asDict(rawEntry(doc.catalog, 'AcroForm'));
  const fields = acro && asArray(rawEntry(acro, 'Fields'));
  if (!fields) return present(doc.catalog, 'AcroForm');
  for (let i = 0; i < fields.size(); i++) {
    const field = asDict(fields.get(i));
    if (!field || walk(field, undefined, 0)) return true;
  }
  return false;
}
