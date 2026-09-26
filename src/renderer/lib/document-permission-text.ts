import { tChrome } from '../i18n';
import type { CapabilityBlock, PermissionName } from './document-permissions';

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
