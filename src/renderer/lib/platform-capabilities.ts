// The platform capability report: one flag per platform-bound feature, read
// from Rust once at boot, before the first render. A feature whose flag is
// false has no UI entry — menus, commands, shortcuts and dialog controls drop
// it rather than offering a control that errors.

import { app } from './tauri-bridge';

export const PLATFORM_FEATURES = [
  'systemPrinting',
  'virtualPrinter',
  'scanning',
  'scheduledActions',
  'storeCertificates',
  'sendByEmail',
  'webCapture',
  'clipboardRead',
  'snapshot',
  'accentColor',
  'enterprisePolicy',
  'trayResidency',
  'backdrop',
  'consoleAttach',
  'startWithSystem',
  'hiddenAnimationFrames',
  'explorerMenu',
] as const;

export type PlatformFeature = (typeof PLATFORM_FEATURES)[number];

export type PlatformCapabilities = Readonly<Record<PlatformFeature, boolean>>;

export const ALL_PLATFORM_CAPABILITIES: PlatformCapabilities = Object.freeze(
  Object.fromEntries(PLATFORM_FEATURES.map((f) => [f, true])) as Record<PlatformFeature, boolean>,
);

let current: PlatformCapabilities = ALL_PLATFORM_CAPABILITIES;

/** The operating system the report came from. It selects WORDING that names
 * an OS mechanism (the scheduler, the module file type, signing in); it never
 * decides whether a feature exists — the flags do that. */
export type HostOs = 'windows' | 'linux' | 'other';

const DEFAULT_HOST_OS: HostOs = 'windows';
let currentOs: HostOs = DEFAULT_HOST_OS;

/** A flag is true only when the report says exactly `true`; a missing or
 * malformed field is an absent feature. */
export function parsePlatformCapabilities(raw: unknown): PlatformCapabilities {
  const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  return Object.freeze(
    Object.fromEntries(PLATFORM_FEATURES.map((f) => [f, record[f] === true])) as Record<PlatformFeature, boolean>,
  );
}

/** The report's `os`; anything unrecognized is `other`. */
export function parseHostOs(raw: unknown): HostOs {
  const os = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>).os : undefined;
  return os === 'windows' || os === 'linux' ? os : 'other';
}

/** Bounds the boot wait: the command is a constant read backend-side, so only
 * a wedged IPC bridge reaches this. */
export const PLATFORM_CAPABILITIES_TIMEOUT_MS = 1000;

/**
 * Reads the report once. An IPC failure or timeout keeps the current record:
 * the command is compiled into every build, so a failure is a wedged bridge,
 * and the boot must still render.
 */
export async function loadPlatformCapabilities(
  read: () => Promise<unknown> = () => app.platformCapabilities(),
  timeoutMs = PLATFORM_CAPABILITIES_TIMEOUT_MS,
): Promise<PlatformCapabilities> {
  const timedOut = Symbol('timeout');
  try {
    const raw = await Promise.race([
      read(),
      new Promise<typeof timedOut>((resolve) => {
        setTimeout(() => resolve(timedOut), timeoutMs);
      }),
    ]);
    if (raw === timedOut) throw new Error('timed out');
    current = parsePlatformCapabilities(raw);
    currentOs = parseHostOs(raw);
    for (const listener of [...listeners]) listener();
  } catch (e: unknown) {
    console.error('platform_capabilities failed:', e);
  }
  return current;
}

const listeners = new Set<() => void>();

/** Run `listener` after every successful read of the report: a flag that
 * depends on the session (the tray) can settle after the boot read, and the
 * surfaces that read the flags at render time re-render from it. Returns the
 * unsubscribe. */
export function onPlatformCapabilitiesChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function platformCapability(feature: PlatformFeature): boolean {
  return current[feature];
}

export function platformCapabilities(): PlatformCapabilities {
  return current;
}

/** Test and harness override. Unnamed flags keep their current value. */
export function setPlatformCapabilities(overrides: Partial<Record<PlatformFeature, boolean>>): void {
  current = Object.freeze({ ...current, ...overrides });
}

export function resetPlatformCapabilities(): void {
  current = ALL_PLATFORM_CAPABILITIES;
  currentOs = DEFAULT_HOST_OS;
}

export function hostOs(): HostOs {
  return currentOs;
}

/** Test and harness override. */
export function setHostOs(os: HostOs): void {
  currentOs = os;
}
