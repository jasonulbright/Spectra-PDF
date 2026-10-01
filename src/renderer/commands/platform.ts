// Which commands and tools belong to a platform-bound feature. An unavailable
// feature's commands are absent from every listing — menus, the tool grid,
// OmniSearch, the keymap — and `invokeCommand` refuses them, so no surface can
// reach a backend the platform does not have.

import { platformCapability, type PlatformFeature } from '../lib/platform-capabilities';
import type { CommandId } from './registry';
import { TOOL_DEFS, type ToolDef, type ToolId } from './tools';

export const COMMAND_PLATFORM: Readonly<Partial<Record<CommandId, PlatformFeature>>> = {
  'file.print': 'systemPrinting',
  'file.sendToEmail': 'sendByEmail',
  'file.createFromClipboard': 'clipboardRead',
  'file.createFromWebPage': 'webCapture',
  'file.createFromScanner': 'scanning',
  'document.insertFromScanner': 'scanning',
  'tools.scheduledRuns': 'scheduledActions',
  'window.minimizeToTray': 'trayResidency',
  'tools.snapshot': 'snapshot',
};

/** A tool whose whole surface is one platform-bound feature. Its
 * `tools.open.<id>` command follows it. */
export const TOOL_PLATFORM: Readonly<Partial<Record<ToolId, PlatformFeature>>> = {
  snapshot: 'snapshot',
};

/** Preferences controls bound to a platform feature, in panel order. A control
 * absent from this map is always shown. */
export const PREFERENCE_CONTROLS = ['minimizeToTray', 'startMinimized', 'startWithSystem', 'explorerMenu'] as const;

export type PreferenceControl = (typeof PREFERENCE_CONTROLS)[number];

export const PREFERENCE_PLATFORM: Readonly<Record<PreferenceControl, PlatformFeature>> = {
  minimizeToTray: 'trayResidency',
  startMinimized: 'trayResidency',
  startWithSystem: 'startWithSystem',
  explorerMenu: 'explorerMenu',
};

export function preferenceAvailable(control: PreferenceControl): boolean {
  return platformCapability(PREFERENCE_PLATFORM[control]);
}

export function availablePreferenceControls(): PreferenceControl[] {
  return PREFERENCE_CONTROLS.filter(preferenceAvailable);
}

export function commandFeature(id: CommandId): PlatformFeature | null {
  const direct = COMMAND_PLATFORM[id];
  if (direct) return direct;
  if (id.startsWith('tools.open.')) return TOOL_PLATFORM[id.slice('tools.open.'.length) as ToolId] ?? null;
  return null;
}

export function commandAvailable(id: CommandId): boolean {
  const feature = commandFeature(id);
  return feature === null || platformCapability(feature);
}

export function toolAvailable(id: ToolId): boolean {
  const feature = TOOL_PLATFORM[id];
  return feature === undefined || platformCapability(feature);
}

export function availableToolDefs(): readonly ToolDef[] {
  return TOOL_DEFS.filter((t) => toolAvailable(t.id));
}
