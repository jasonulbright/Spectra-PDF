// Is a usable Ghostscript configured? — the renderer's ONE answer.
//
// Ghostscript is a user-supplied prerequisite: the distribution provides
// none. Three resolvers used to answer this question independently — the
// settings panel's `ensureGsPath`, `ocr-recognize.ghostscriptPath`, and a
// direct `app.getGsPath()` in the scan dialog — and each returned a PATH,
// which is a string a spawn can fail on rather than an answer a surface can
// render. This module returns the capability instead, and every gs-bearing
// surface asks it.
//
// It is a LEAF module for the same reason `app-settings.ts` is one: the OCR
// door, the command registry's `when` predicates and the batch tier all need
// the answer, and importing a panel component for it drags module-level
// theme and IPC side effects into the command layer and into vitest, which
// has no `window`. Nothing here may touch React, the DOM, or a component.
//
// The answer is LIVE: installing Ghostscript and pointing the setting at it
// lights every dependent surface up in place. Two halves make that work — a
// synchronous snapshot for render-time and `when`-predicate reads, and a
// subscription every surface re-renders on when a probe lands.

import { app } from './tauri-bridge';
import { loadSettings } from './app-settings';

/** The named reasons, mirroring `src-tauri/src/gs.rs` and
 * `engine/gs_capability.py`. Control flow matches these, never a message. */
export const GS_NOT_CONFIGURED = 'not-configured';
export const GS_NOT_EXECUTABLE = 'not-executable';
export const GS_PROBE_FAILED = 'probe-failed';
export const GS_VERSION_BELOW_MINIMUM = 'version-below-minimum';
/** No probe has landed yet this session — not a refusal. */
export const GS_UNRESOLVED = 'unresolved';

/** One validated answer about Ghostscript. The Rust command's shape plus
 * `pending`, which the renderer alone knows: whether a probe has landed. */
export interface GsCapability {
  available: boolean;
  path: string;
  version: string;
  /** One of the named reasons above; empty when `available`. */
  reason: string;
  /** Probe output for the settings surface; never matched on. */
  detail: string;
  /** True until the first probe of this session resolves. A pending answer
   * is NOT an absent one: a surface disabled on it would flash disabled on
   * every launch, and a run started in that window is refused by name by
   * `requireGsPath` instead. */
  pending: boolean;
}

const UNRESOLVED: GsCapability = {
  available: false,
  path: '',
  version: '',
  reason: GS_UNRESOLVED,
  detail: '',
  pending: true,
};

type BridgeAnswer = Omit<GsCapability, 'pending'>;

let current: GsCapability = UNRESOLVED;
let inFlight: Promise<GsCapability> | null = null;
let pinned: GsCapability | null = null;
const listeners = new Set<() => void>();

function publish(next: GsCapability): GsCapability {
  current = next;
  for (const listener of [...listeners]) listener();
  return next;
}

function settled(answer: BridgeAnswer): GsCapability {
  return {
    available: !!answer.available,
    path: answer.path ?? '',
    version: answer.version ?? '',
    reason: answer.available ? '' : (answer.reason || GS_PROBE_FAILED),
    detail: answer.detail ?? '',
    pending: false,
  };
}

/** The explicit path the user configured, or undefined for discovery
 * (environment → registry → PATH). Empty means "find one", never "use the
 * bundled copy" — there is no bundled copy to fall back to. */
function configuredPath(): string | undefined {
  const stored = loadSettings().gsPath.trim();
  return stored === '' ? undefined : stored;
}

/**
 * The answer as of now, without waiting.
 *
 * What a render pass and a `when` predicate read. It is `pending` until the
 * first probe lands; every caller that can wait should await
 * `ensureGsCapability` instead.
 */
export function gsCapability(): GsCapability {
  return current;
}

/** Re-render on a landing probe. Returns the unsubscribe. */
export function subscribeGsCapability(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The answer, probed if this session has not probed yet.
 *
 * A failed attempt is NOT cached as a failure: one early IPC hiccup used to
 * leave a permanently rejected promise that killed every gs feature for the
 * whole session (a fixed regression, kept fixed here) — the next call
 * re-probes.
 */
export function ensureGsCapability(): Promise<GsCapability> {
  if (pinned) return Promise.resolve(pinned);
  if (!current.pending) return Promise.resolve(current);
  if (!inFlight) {
    inFlight = app
      .gsCapability(configuredPath())
      .then((answer) => publish(settled(answer)))
      .catch(() => {
        // The IPC itself failed. Stay pending so the next ask re-probes
        // rather than reporting an absent Ghostscript that was never asked
        // about.
        return current;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

/**
 * Probe again and publish — after the user browses to a Ghostscript, clears
 * the path, or installs one while the app is open.
 *
 * `path` is the candidate being TRIED, which is not yet what is stored: the
 * settings surface validates before it saves.
 */
export function refreshGsCapability(path?: string): Promise<GsCapability> {
  if (pinned) return Promise.resolve(pinned);
  const candidate = path === undefined ? configuredPath() : (path.trim() || undefined);
  const probe = app
    .refreshGsCapability(candidate)
    .then((answer) => publish(settled(answer)))
    .catch(() => publish({ ...UNRESOLVED, pending: false, reason: GS_PROBE_FAILED }));
  inFlight = probe;
  probe.finally(() => {
    if (inFlight === probe) inFlight = null;
  }).catch(() => {});
  return probe;
}

/** Thrown by `requireGsPath` when no usable Ghostscript is configured. The
 * REASON is the structured half; the message is the honest English backstop
 * for a surface that only renders a caught error's text. */
export class GsUnavailableError extends Error {
  readonly reason: string;

  constructor(capability: GsCapability) {
    super(GS_REQUIRED_MESSAGE);
    this.name = 'GsUnavailableError';
    this.reason = capability.reason;
  }
}

/** The one sentence, in English, for a thrown refusal. The rendered surfaces
 * use the catalog key (`panel.common.gsRequired`); this is what reaches a
 * caller that can only show `String(error)`. */
export const GS_REQUIRED_MESSAGE =
  'This feature needs Ghostscript, which Spectra does not include. ' +
  'Install it and point Spectra at it in Settings ▸ Engine.';

/**
 * The gs path for a call that cannot proceed without one.
 *
 * Every full-Ghostscript door calls this instead of reading a path: the
 * refusal is named here, once, rather than arriving as a spawn failure from
 * whichever subprocess ran first.
 */
export async function requireGsPath(): Promise<string> {
  const capability = await ensureGsCapability();
  if (!capability.available) throw new GsUnavailableError(capability);
  return capability.path;
}

/**
 * The gs path if there is one, else `''` — for a PARTIAL door whose gs leg
 * is one branch of several (Create PDF's PostScript sources, Export's slide
 * format, Compare's visual mode). The branch itself is gated by the surface;
 * this hands the engine a path when one exists without making the whole
 * operation refuse.
 */
export async function gsPathIfAvailable(): Promise<string> {
  const capability = await ensureGsCapability();
  return capability.available ? capability.path : '';
}

// ── Decisions the surfaces share ─────────────────────────────────────────

/**
 * Does this surface refuse right now?
 *
 * The one predicate 25 surfaces share, so "disabled" cannot mean one thing
 * in a panel and another in a dialog. Pending is NOT blocked — see
 * `GsCapability.pending`.
 */
export function gsBlocked(capability: GsCapability = current): boolean {
  return !capability.available && !capability.pending;
}

/** The catalog key explaining the state, or null when nothing is wrong.
 * Callers render it through `tChrome`; this module holds no strings that
 * reach the screen. */
export function gsStateKey(capability: GsCapability = current): string | null {
  if (capability.available || capability.pending) return null;
  switch (capability.reason) {
    case GS_NOT_EXECUTABLE:
      return 'panel.common.gsNotExecutable';
    case GS_PROBE_FAILED:
      return 'panel.common.gsProbeFailed';
    case GS_VERSION_BELOW_MINIMUM:
      return 'panel.common.gsTooOld';
    default:
      return 'panel.common.gsRequired';
  }
}

// ── The set-up affordance ────────────────────────────────────────────────
//
// The module-level slot idiom the command context uses: App registers the
// opener while it is mounted, and every disabled surface calls one function
// rather than each holding its own route into Preferences.

type SetupOpener = () => void;
let setupOpener: SetupOpener | null = null;

export function registerGsSetupOpener(opener: SetupOpener | null): void {
  setupOpener = opener;
}

/** Open Settings ▸ Engine. A no-op before App mounts, which is not
 * reachable from a rendered control. */
export function openGsSetup(): void {
  setupOpener?.();
}

/**
 * Test seam: hold this answer for the session, whatever the machine has.
 *
 * The end-to-end suite has to walk the absent surfaces on a machine that has
 * a working Ghostscript — every developer box and the CI test runner do,
 * because the PRESENT axis needs one — and there is no way to arrange the
 * absence from outside: discovery reads the registry and the environment as
 * well as PATH, so uninstalling is the only real answer and no suite may do
 * that. A pinned answer is therefore the seam, and it sits at the same place
 * `setTabOrderChannel` does: the module the shipped code already reads,
 * reached only from the harness, which exists only in a `VITE_E2E` build.
 *
 * Pinning wins over both probe paths, so a surface's own `refresh` cannot
 * lift it. `null` unpins and leaves the session UNRESOLVED — the next ask
 * probes for real, which is how a spec proves that installing Ghostscript
 * lights the surfaces up without a restart.
 */
export function pinGsCapability(answer: BridgeAnswer | null): GsCapability {
  inFlight = null;
  if (answer === null) {
    pinned = null;
    return publish(UNRESOLVED);
  }
  pinned = settled(answer);
  return publish(pinned);
}

/** Test seam: forget the session's answer and its subscribers. */
export function resetGsCapability(): void {
  current = UNRESOLVED;
  inFlight = null;
  pinned = null;
  listeners.clear();
  setupOpener = null;
}
