// Preserve format requirements of the own document and every retained source.
// ISO 32000-2 7.7.2/Table 29 and 7.12/Tables 48-49. This carries declarations,
// not a conformance certification, and never follows documentation URLs.
import { PDFArray, PDFBool, PDFDict, PDFDocument, PDFHeader, PDFHexString, PDFName, PDFNull, PDFNumber, PDFObject, PDFString } from 'pdf-lib';
import { tChrome } from '../i18n';

const N = PDFName.of;
const refuse = () => new Error(tChrome('app.operation.unverified'));
const versionPattern = /^(?:1\.[0-7]|2\.0)$/;
const isText = (value: PDFObject | undefined): value is PDFString | PDFHexString => value instanceof PDFString || value instanceof PDFHexString;
const versionOf = (value: PDFObject | undefined): string => {
  if (!(value instanceof PDFName) || !versionPattern.test(value.decodeText())) throw refuse();
  return value.decodeText();
};
const headerVersion = (doc: PDFDocument): string => {
  const match = /^%PDF-(1\.[0-7]|2\.0)(?:\r|\n|$)/.exec(doc.context.header.toString());
  if (!match) throw refuse();
  return match[1];
};

interface Budget { objects: number; bytes: number }
function charge(budget: Budget, bytes = 0) {
  budget.objects++;
  budget.bytes += bytes;
  if (budget.objects > 8000 || budget.bytes > 1024 * 1024) throw refuse();
}

// Extensions and every descendant must be direct objects. This intentionally
// does not dereference even an apparently harmless indirect scalar. Traversal
// charges every edge and bounds depth before allocating output containers.
function directCopy(output: PDFDocument, value: PDFObject, budget: Budget, depth = 0): PDFObject {
  if (depth > 32) throw refuse();
  charge(budget);
  if (value === PDFNull) return PDFNull;
  if (value instanceof PDFName || isText(value)) {
    charge(budget, value.asString().length);
    return value.clone();
  }
  if (value instanceof PDFNumber) {
    if (!Number.isFinite(value.asNumber())) throw refuse();
    return value.clone();
  }
  if (value instanceof PDFBool) return value.clone();
  if (value instanceof PDFArray) {
    const result = PDFArray.withContext(output.context);
    for (let i = 0; i < value.size(); i++) result.push(directCopy(output, value.get(i), budget, depth + 1));
    return result;
  }
  if (value instanceof PDFDict) {
    const result = PDFDict.withContext(output.context);
    for (const [key, child] of value.entries()) {
      charge(budget, key.asString().length);
      result.set(key, directCopy(output, child, budget, depth + 1));
    }
    return result;
  }
  throw refuse();
}

function validateDescriptor(dict: PDFDict, declaredVersion: string) {
  const type = dict.get(N('Type'));
  if (type !== undefined && type !== N('DeveloperExtensions')) throw refuse();
  const base = versionOf(dict.get(N('BaseVersion')));
  if (base > declaredVersion) throw refuse();
  const level = dict.get(N('ExtensionLevel'));
  if (!(level instanceof PDFNumber) || !Number.isSafeInteger(level.asNumber())) throw refuse();
  for (const key of ['URL', 'ExtensionRevision']) {
    const value = dict.get(N(key));
    if (value !== undefined && !isText(value)) throw refuse();
  }
}

// Dictionary order is immaterial; string encodings and extension values are
// not normalized. Bounded directCopy has already validated the whole graph.
function identity(value: PDFObject): string {
  const tree = (item: PDFObject): unknown => {
    if (item instanceof PDFDict) return ['dict', item.entries().sort(([a], [b]) => a.asString() < b.asString() ? -1 : a.asString() > b.asString() ? 1 : 0).map(([k, v]) => [k.asString(), tree(v)])];
    if (item instanceof PDFArray) return ['array', item.asArray().map(tree)];
    return [item.constructor.name, item.toString()];
  };
  // Serialize once. Re-encoding a child JSON string at every level would
  // exponentially escape its quotes despite a bounded input object graph.
  return JSON.stringify(tree(value));
}

/** Invoke after the actual page/root carriers. Sources must include the owner
 * even with zero remaining own pages, and every source contributing pages. */
export function carryFormatDeclarations(output: PDFDocument, sources: readonly PDFDocument[]): void {
  let requiredVersion = '1.7'; // pinned writer's baseline, never downgraded
  const budget = { objects: 0, bytes: 0 };
  const extensions = PDFDict.withContext(output.context);
  const byPrefix = new Map<string, { key: PDFName; entries: PDFDict[]; wasArray: boolean; identities: Map<string, string> }>();
  let hadExtensions = false, hadType = false, hadCatalogVersion = false;
  for (const source of new Set(sources)) {
    charge(budget);
    const header = headerVersion(source);
    const rawVersion = source.catalog.get(N('Version'));
    const resolvedVersion = rawVersion === undefined ? undefined : source.context.lookup(rawVersion);
    const catalog = resolvedVersion === undefined || resolvedVersion === PDFNull ? undefined : versionOf(resolvedVersion);
    if (catalog !== undefined) hadCatalogVersion = true;
    requiredVersion = [requiredVersion, header, catalog ?? header].sort().at(-1)!;
    const raw = source.catalog.get(N('Extensions'));
    if (raw === undefined || raw === PDFNull) continue;
    const copied = directCopy(output, raw, budget);
    if (!(copied instanceof PDFDict)) throw refuse();
    hadExtensions = true;
    const type = copied.get(N('Type'));
    if (type !== undefined) {
      if (type !== N('Extensions')) throw refuse();
      hadType = true;
    }
    for (const [key, value] of copied.entries()) {
      if (key === N('Type')) continue;
      let group = byPrefix.get(key.asString());
      if (!group) {
        group = { key, entries: [], wasArray: false, identities: new Map() };
        byPrefix.set(key.asString(), group);
      }
      const entries = value instanceof PDFArray ? value.asArray() : [value];
      if (value instanceof PDFArray) { group.wasArray = true; requiredVersion = '2.0'; }
      for (const entry of entries) {
        if (!(entry instanceof PDFDict)) throw refuse();
        // 7.12.4 constrains BaseVersion against both source declarations.
        validateDescriptor(entry, catalog === undefined || header < catalog ? header : catalog);
        const keyIdentity = `${versionOf(entry.get(N('BaseVersion')))}:${(entry.get(N('ExtensionLevel')) as PDFNumber).asNumber()}`;
        const valueIdentity = identity(entry), previous = group.identities.get(keyIdentity);
        if (previous !== undefined && previous !== valueIdentity) throw refuse();
        if (previous === undefined) { group.entries.push(entry); group.identities.set(keyIdentity, valueIdentity); }
      }
    }
  }
  if (hadType) extensions.set(N('Type'), N('Extensions'));
  for (const group of byPrefix.values()) {
    if (group.wasArray || group.entries.length !== 1) {
      extensions.set(group.key, output.context.obj(group.entries)); requiredVersion = '2.0';
    } else extensions.set(group.key, group.entries[0]);
  }
  // These page/root fields are defined in PDF 2.0 even if a malformed source
  // omitted its declaration. Their presence must not become a 1.7 claim.
  if (output.getPages().some(page => page.node.has(N('OutputIntents')))) requiredVersion = '2.0';
  const structure = output.catalog.lookup(N('StructTreeRoot'));
  if (structure instanceof PDFDict && structure.has(N('Namespaces'))) requiredVersion = '2.0';
  output.context.header = PDFHeader.forVersion(...requiredVersion.split('.').map(Number) as [number, number]);
  if (hadCatalogVersion || requiredVersion === '2.0') output.catalog.set(N('Version'), N(requiredVersion));
  else output.catalog.delete(N('Version'));
  if (hadExtensions) output.catalog.set(N('Extensions'), extensions);
  else output.catalog.delete(N('Extensions'));
}

/** pdf-lib 1.17.1 hardcodes its serialized header to 1.7, ignoring context.header.
 * Replace only the equal-width version bytes after serialization. Every xref
 * offset and object byte remains unchanged; callers publish only these bytes. */
export async function saveWithFormatDeclarations(output: PDFDocument): Promise<Uint8Array> {
  const required = headerVersion(output), bytes = await output.save();
  if (new TextDecoder().decode(bytes.subarray(0, 8)) !== '%PDF-1.7') throw refuse();
  bytes.set(new TextEncoder().encode(`%PDF-${required}`), 0);
  return bytes;
}
