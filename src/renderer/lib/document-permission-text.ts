import { tChrome } from '../i18n';
import { UNRESTRICTED, capabilityBlock, type CapabilityBlock, type DocumentSecurity, type PermissionName } from './document-permissions';

const PERMISSION_TEXT = {
  print: 'app.permissions.name.print',
  print_high: 'app.permissions.name.print_high',
  modify: 'app.permissions.name.modify',
  copy: 'app.permissions.name.copy',
  annotate: 'app.permissions.name.annotate',
  fill: 'app.permissions.name.fill',
  accessibility: 'app.permissions.name.accessibility',
  assemble: 'app.permissions.name.assemble',
} as const satisfies Record<PermissionName, string>;

/** The sentence a disabled command, a refused gesture and a refused operation
 * all show for the same block. */
export function capabilityBlockText(block: CapabilityBlock): string {
  if (block.kind === 'ownerPassword') return tChrome('app.permissions.ownerPasswordNeeded');
  if (block.kind === 'recipientList') return tChrome('app.permissions.recipientListNeeded');
  return tChrome('app.permissions.denied', { permission: tChrome(PERMISSION_TEXT[block.permission]) });
}

/** A refusal thrown by an operation door, carrying its block for callers that
 * report it. */
export class PermissionRefusal extends Error {
  readonly block: CapabilityBlock;

  constructor(block: CapabilityBlock) {
    super(capabilityBlockText(block));
    this.name = 'PermissionRefusal';
    this.block = block;
  }
}

/** Why signing `file` is refused, or null. A signature fills a signature
 * field, which ISO 32000-2 Table 22 bit 9 (or bit 6) must permit; the engine
 * refuses the same document again. */
export function signBlock(file: { security?: DocumentSecurity } | null | undefined): CapabilityBlock | null {
  return capabilityBlock(file?.security ?? UNRESTRICTED, 'fill');
}
