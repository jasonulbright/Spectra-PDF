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
] as const;

export type PlatformFeature = (typeof PLATFORM_FEATURES)[number];

export type PlatformCapabilities = Readonly<Record<PlatformFeature, boolean>>;

export const ALL_PLATFORM_CAPABILITIES: PlatformCapabilities = Object.freeze(
  Object.fromEntries(PLATFORM_FEATURES.map((f) => [f, true])) as Record<PlatformFeature, boolean>,
);

let current: PlatformCapabilities = ALL_PLATFORM_CAPABILITIES;

/** A flag is true only when the report says exactly `true`; a missing or
 * malformed field is an absent feature. */
export function parsePlatformCapabilities(raw: unknown): PlatformCapabilities {
  const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  return Object.freeze(
    Object.fromEntries(PLATFORM_FEATURES.map((f) => [f, record[f] === true])) as Record<PlatformFeature, boolean>,
  );
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
  } catch (e: unknown) {
    console.error('platform_capabilities failed:', e);
  }
  return current;
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
}
