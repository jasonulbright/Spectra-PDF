import { decodeMetadata, decodeXmlBytes, encodeXmlBytes } from './metadata-stream';
import type { MetadataInput } from './metadata-stream';
import { transformXmpXml } from './xmp-packet';

export interface MetadataOverrides { producer?: string; title?: string; keywords?: string }
export interface MetadataRequest { input: MetadataInput; overrides: MetadataOverrides }
export type MetadataResult = { changed: false } | { changed: true; bytes: Uint8Array };

/** Shared by the disposable worker and direct core tests. No DOM insertion,
 * callbacks from the document, URI resolution or external entity loading. */
export async function processMetadata(request: MetadataRequest): Promise<MetadataResult> {
  const xml = decodeXmlBytes(await decodeMetadata(request.input));
  const updated = transformXmpXml(xml, request.overrides);
  return updated === xml ? { changed: false } : { changed: true, bytes: encodeXmlBytes(updated) };
}
