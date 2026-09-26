// A document opened with its USER password keeps an encrypted working copy
// (ISO 32000-2 7.6.4.1). pdf-lib reads no encrypted file and writes no
// encryption, so the renderer's own builders (page-tier commit, canvas
// annotations, field creation) run on the decrypted bytes the engine hands
// them (`sealed_plaintext`), and the engine writes their output back under
// the working copy's own /Encrypt (`sealed_reseal`). The decrypted bytes live
// in memory only; no plaintext file is ever staged.
//
// An unencrypted or owner-opened document never reaches here: its builders
// run on its own bytes and write them as before.
import type { OpenFile } from '../state/types';
import type { ExportPage } from './pdfx-format';
import { deniedPermission } from './document-permissions';

export type SealedCapability = 'pageTier' | 'commentTier' | 'formAuthoring';

export type SealedCall = (method: string, params: Record<string, unknown>) => Promise<unknown>;

export function isSealed(file: Pick<OpenFile, 'security'> | undefined): boolean {
  return file?.security?.opener === 'user';
}

const CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export async function sealedPlaintext(
  call: SealedCall,
  workingPath: string,
  capabilities: readonly SealedCapability[],
): Promise<Uint8Array> {
  const reply = await call('sealed_plaintext', { path: workingPath, capabilities: [...capabilities] });
  const data = reply && typeof reply === 'object' ? (reply as Record<string, unknown>).data : undefined;
  if (typeof data !== 'string') throw new Error('invalid sealed_plaintext response');
  return base64ToBytes(data);
}

let reader: SealedCall | null = null;

/** Registered by App with its ungated engine transport, for the workspace
 * index, which reads annotation dictionaries pdf.js does not surface. */
export function setSealedReader(next: SealedCall | null): void {
  reader = next;
}

/** `buffer`, decrypted, when it is a user-opened file's encrypted bytes and
 * the document allows `capability`; otherwise `buffer` itself. pdf-lib reads
 * an encrypted file's strings as ciphertext and cannot load some at all, so
 * the renderer's own readers of a user-opened file's bytes (the raw-style
 * annotation read, the layer remap after a page commit) take these bytes. */
export async function readableBytes(
  file: Pick<OpenFile, 'security' | 'workingPath'>,
  buffer: Uint8Array,
  capability: SealedCapability = 'commentTier',
): Promise<Uint8Array> {
  if (!isSealed(file) || !reader || deniedPermission(file.security!, capability)) return buffer;
  const reply = await reader('sealed_plaintext', {
    path: file.workingPath,
    capabilities: [capability],
    data: bytesToBase64(buffer),
  }).catch(() => null);
  const data = reply && typeof reply === 'object' ? (reply as Record<string, unknown>).data : undefined;
  return typeof data === 'string' ? base64ToBytes(data) : buffer;
}

export async function sealedReseal(
  call: SealedCall,
  workingPath: string,
  bytes: Uint8Array,
  output: string,
  capabilities: readonly SealedCapability[],
): Promise<void> {
  const reply = await call('sealed_reseal', {
    path: workingPath,
    data: bytesToBase64(bytes),
    output,
    capabilities: [...capabilities],
  });
  if (!reply || typeof reply !== 'object' || (reply as Record<string, unknown>).output !== output) {
    throw new Error('invalid sealed_reseal response');
  }
}

/** The /P classes a page-tier commit of `path` exercises: annotations
 * authored or removed need `commentTier`; any page that is not the file's own
 * page at its own position, unrotated, needs `pageTier`. The engine checks
 * the same bits again. */
export function commitCapabilities(
  path: string,
  pages: readonly ExportPage[],
  originalPageCount: number,
): SealedCapability[] {
  const out: SealedCapability[] = [];
  const structural = pages.length !== originalPageCount
    || pages.some((p, i) => p.sourceKey !== path || p.pageIndex !== i || !!p.rotation);
  if (structural) out.push('pageTier');
  if (pages.some((p) => p.annotations?.length || p.removedImportedOriginals?.length)) out.push('commentTier');
  if (!out.length) out.push('pageTier');
  return out;
}
