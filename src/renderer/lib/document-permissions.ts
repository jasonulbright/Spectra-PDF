// ISO 32000-2 7.6.4.1 and Table 22: a document opened with its USER password
// allows only what its /P bits grant; the owner password and an unencrypted
// document allow everything. The engine decodes the bits
// (`engine/credentials.py` `document_permissions`); this module decides what
// each capability of the app needs from them.
//
// A leaf with no imports: the reducer, the selectors and the command registry
// all ask it, and none of them may pull i18n in.

export const PERMISSION_NAMES = [
  'print',
  'print_high',
  'modify',
  'copy',
  'annotate',
  'fill',
  'accessibility',
  'assemble',
] as const;

export type PermissionName = (typeof PERMISSION_NAMES)[number];

export type DocumentOpener = 'user' | 'owner' | 'none';

export interface DocumentSecurity {
  opener: DocumentOpener;
  permissions: Readonly<Record<PermissionName, boolean>>;
}

export const UNRESTRICTED: DocumentSecurity = Object.freeze({
  opener: 'none',
  permissions: Object.freeze(
    Object.fromEntries(PERMISSION_NAMES.map((name) => [name, true])) as Record<PermissionName, boolean>,
  ),
});

/** What the app does with a document, in the terms its /P bits speak.
 *
 * `pageTier`, `commentTier` and `formAuthoring` are the edits the renderer
 * writes itself with pdf-lib, which cannot write an encrypted file; the other
 * edit capabilities run in the engine, which keeps the protection. */
export type Capability =
  | 'print'
  | 'copy'
  | 'accessibility'
  | 'modify'
  | 'annotate'
  | 'fill'
  | 'assemble'
  | 'pageTier'
  | 'commentTier'
  | 'formAuthoring';

/** Why a capability is unavailable: a /P bit the document withholds, or a
 * renderer-written edit on a working copy that is still encrypted. */
export type CapabilityBlock =
  | { kind: 'permission'; permission: PermissionName }
  | { kind: 'ownerPassword' };

const RENDERER_WRITTEN: ReadonlySet<Capability> = new Set<Capability>(['pageTier', 'commentTier', 'formAuthoring']);

/** The /P bit a capability lacks, or null when the bits allow it.
 *
 * Table 22: bit 9 fills existing fields even where bit 6 is clear, so either
 * allows filling; bit 11 assembles pages even where bit 4 is clear, so either
 * allows page structure; creating fields needs bits 4 and 6 together. */
export function deniedPermission(security: DocumentSecurity, capability: Capability): PermissionName | null {
  const p = security.permissions;
  switch (capability) {
    case 'print':
      return p.print ? null : 'print';
    case 'copy':
      return p.copy ? null : 'copy';
    case 'accessibility':
      return p.accessibility ? null : 'accessibility';
    case 'modify':
      return p.modify ? null : 'modify';
    case 'annotate':
    case 'commentTier':
      return p.annotate ? null : 'annotate';
    case 'fill':
      return p.fill || p.annotate ? null : 'fill';
    case 'assemble':
    case 'pageTier':
      return p.assemble || p.modify ? null : 'assemble';
    case 'formAuthoring':
      if (!p.modify) return 'modify';
      return p.annotate ? null : 'annotate';
  }
}

export function capabilityBlock(security: DocumentSecurity, capability: Capability): CapabilityBlock | null {
  const permission = deniedPermission(security, capability);
  if (permission) return { kind: 'permission', permission };
  if (security.opener === 'user' && RENDERER_WRITTEN.has(capability)) return { kind: 'ownerPassword' };
  return null;
}

/** The engine's `document_permissions` reply, read defensively. A reply that
 * does not read as one withholds every bit: an unreadable answer is not an
 * owner's grant. */
export function parseDocumentSecurity(raw: unknown): DocumentSecurity {
  const reply = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const opener: DocumentOpener =
    reply.opener === 'user' || reply.opener === 'owner' || reply.opener === 'none' ? reply.opener : 'user';
  const bits = reply.permissions && typeof reply.permissions === 'object'
    ? (reply.permissions as Record<string, unknown>)
    : {};
  const permissions = Object.fromEntries(
    PERMISSION_NAMES.map((name) => [name, bits[name] === true]),
  ) as Record<PermissionName, boolean>;
  if (opener === 'owner') return { opener, permissions: UNRESTRICTED.permissions };
  return { opener, permissions };
}

/** Whether a security record grants everything (nothing to enforce). */
export function isUnrestricted(security: DocumentSecurity): boolean {
  return security.opener !== 'user' && PERMISSION_NAMES.every((name) => security.permissions[name]);
}
