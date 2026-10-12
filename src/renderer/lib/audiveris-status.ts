// Is a usable Audiveris configured? The renderer's one answer.
//
// Discovery, probing and the stored Preferences path all live in Rust
// (`src-tauri/src/audiveris.rs`). This module holds the last answer Rust gave,
// so that render passes, the command registry's `when` predicates and the
// guided-action planner read one synchronous value. It is a leaf: nothing here
// touches React, the DOM or a component, because vitest has no `window`.
//
// The answer is read once at start and again on every recheck. Only a probed,
// ready answer makes a surface usable; a pending one enables nothing and shows
// no refusal.

import { audiveris, type AudiverisStatusAnswer } from './tauri-bridge';

export type AudiverisKind = AudiverisStatusAnswer['kind'];

/** The named states, mirroring `src-tauri/src/audiveris.rs`. Control flow
 * matches these, never a message. */
export const AUDIVERIS_READY = 'ready';
export const AUDIVERIS_NOT_CONFIGURED = 'not-configured';
export const AUDIVERIS_NOT_EXECUTABLE = 'not-executable';
export const AUDIVERIS_PROBE_FAILED = 'probe-failed';
export const AUDIVERIS_VERSION_BELOW_MINIMUM = 'version-below-minimum';

const KINDS: readonly AudiverisKind[] = [
  AUDIVERIS_READY,
  AUDIVERIS_NOT_CONFIGURED,
  AUDIVERIS_NOT_EXECUTABLE,
  AUDIVERIS_PROBE_FAILED,
  AUDIVERIS_VERSION_BELOW_MINIMUM,
];
const LAUNCHERS = ['exe', 'flatpak'] as const;
const SOURCES = ['preferences', 'env', 'registry', 'default', 'path', 'opt', 'flatpak'] as const;

/** The lowest Audiveris release the engine accepts; a floor, never a pin. */
export const AUDIVERIS_MINIMUM_VERSION = '5.11';

/** One answer about Audiveris: the Rust shape plus `pending`, which only the
 * renderer knows. A pending answer is not an absent one. */
export interface AudiverisStatus extends AudiverisStatusAnswer {
  pending: boolean;
}

const UNRESOLVED: AudiverisStatus = {
  kind: AUDIVERIS_NOT_CONFIGURED,
  path: null,
  launcher: null,
  version: null,
  source: null,
  ocrLanguages: [],
  detail: null,
  pending: true,
};

const FAILED: AudiverisStatus = { ...UNRESOLVED, kind: AUDIVERIS_PROBE_FAILED, pending: false };

const nullableString = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

/**
 * The Rust answer, checked field by field.
 *
 * An unknown `kind` reads as `probe-failed`: a state this renderer cannot name
 * is still not a usable Audiveris. A value that is not an object is null,
 * which callers treat as a failed IPC.
 */
export function normalizeAudiverisStatus(raw: unknown): AudiverisStatus | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const answer = raw as Record<string, unknown>;
  const languages = Array.isArray(answer.ocrLanguages)
    ? answer.ocrLanguages.filter((l): l is string => typeof l === 'string' && l !== '')
    : [];
  return {
    kind: oneOf(answer.kind, KINDS) ?? AUDIVERIS_PROBE_FAILED,
    path: nullableString(answer.path),
    launcher: oneOf(answer.launcher, LAUNCHERS),
    version: nullableString(answer.version),
    source: oneOf(answer.source, SOURCES),
    ocrLanguages: [...new Set(languages)],
    detail: nullableString(answer.detail),
    pending: false,
  };
}

let current: AudiverisStatus = UNRESOLVED;
let inFlight: Promise<AudiverisStatus> | null = null;
let pinned: AudiverisStatus | null = null;
// Advanced by every read that starts, every pin and every reset. A read
// publishes only while it is still the newest, so a slow read cannot write
// over a pin or over a later answer.
let generation = 0;
const listeners = new Set<() => void>();
// Answers made by `unreadable`. While one is current, the next ask reads Rust
// again: the answer names a failed IPC, not a probed Audiveris.
const UNREAD = new WeakSet<AudiverisStatus>();
let readFailed = false;

function publish(next: AudiverisStatus): AudiverisStatus {
  current = next;
  readFailed = UNREAD.has(next);
  for (const listener of [...listeners]) listener();
  return next;
}

/** A read that failed twice: settled, so no surface waits on it, and named,
 * so Preferences shows why. */
function unreadable(error: unknown): AudiverisStatus {
  const detail = error instanceof Error ? error.message : String(error);
  const answer: AudiverisStatus = { ...UNRESOLVED, pending: false, detail: detail === '' ? null : detail };
  UNREAD.add(answer);
  return answer;
}

async function readStatus(): Promise<AudiverisStatus> {
  const answer = normalizeAudiverisStatus(await audiveris.status());
  if (!answer) throw new Error('audiveris_status returned no status');
  return answer;
}

/** Runs `read` as the newest read; its answer is published only while no
 * later read, pin or reset has started. */
function track(read: () => Promise<AudiverisStatus>): Promise<AudiverisStatus> {
  const mine = ++generation;
  const promise = read().then((next) => {
    if (mine !== generation || pinned) return pinned ?? current;
    return publish(next);
  });
  inFlight = promise;
  promise
    .finally(() => {
      if (inFlight === promise) inFlight = null;
    })
    .catch(() => {});
  return promise;
}

/** The answer as of now, without waiting. */
export function audiverisStatus(): AudiverisStatus {
  return current;
}

export function subscribeAudiverisStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The answer, read from Rust if this session has not read it yet.
 *
 * A failed read is retried once; a second failure settles the answer to
 * not-configured with the failure as its detail, so no surface stays pending.
 * That settled answer is not cached: the next ask reads Rust again.
 */
export function ensureAudiverisStatus(): Promise<AudiverisStatus> {
  if (pinned) return Promise.resolve(pinned);
  if (!current.pending && !readFailed) return Promise.resolve(current);
  if (inFlight) return inFlight;
  return track(() => readStatus().catch(() => readStatus()).catch(unreadable));
}

/** Rust drops its probe cache and probes again; the new answer is published.
 * A recheck that answers nothing readable is followed by a status read. */
export function recheckAudiverisStatus(): Promise<AudiverisStatus> {
  if (pinned) return Promise.resolve(pinned);
  return track(async () => {
    try {
      return normalizeAudiverisStatus(await audiveris.recheck()) ?? (await readStatus());
    } catch {
      return FAILED;
    }
  });
}

/**
 * Store the Preferences path (`null` returns to discovery). Rust probes the
 * stored path at once and answers with that probe, which is what is published.
 *
 * A configured path is the whole answer even when it fails, so the published
 * answer after a failing choice is that path's refusal.
 */
export function setAudiverisPath(path: string | null): Promise<AudiverisStatus> {
  if (pinned) return Promise.resolve(pinned);
  return track(async () => {
    try {
      return normalizeAudiverisStatus(await audiveris.setPath(path)) ?? (await readStatus());
    } catch {
      // The store may have failed while the probe would pass: report what
      // Rust resolves now rather than a probe that never ran.
      try {
        return await readStatus();
      } catch {
        return FAILED;
      }
    }
  });
}

// ── Decisions the surfaces share ─────────────────────────────────────────

/** True only for a probed, usable Audiveris. */
export function audiverisReady(status: AudiverisStatus = current): boolean {
  return !status.pending && status.kind === AUDIVERIS_READY;
}

/** Does a surface show the refusal right now? Pending shows nothing, because
 * the landing answer may withdraw it; pending is still not usable
 * (`audiverisReady`). */
export function audiverisBlocked(status: AudiverisStatus = current): boolean {
  return !status.pending && status.kind !== AUDIVERIS_READY;
}

/** The catalog key explaining the state, or null when nothing is wrong. */
export function audiverisStateKey(status: AudiverisStatus = current): string | null {
  if (!audiverisBlocked(status)) return null;
  switch (status.kind) {
    case AUDIVERIS_NOT_EXECUTABLE:
      return 'panel.common.audiverisNotExecutable';
    case AUDIVERIS_PROBE_FAILED:
      return 'panel.common.audiverisProbeFailed';
    case AUDIVERIS_VERSION_BELOW_MINIMUM:
      return 'panel.common.audiverisTooOld';
    default:
      return 'panel.common.audiverisRequired';
  }
}

/** The catalog key naming where the Audiveris in use comes from, or null.
 * A path chosen in Preferences is the user's choice whether or not it runs;
 * any other source is named only when it resolved. */
export function audiverisOriginKey(status: AudiverisStatus = current): string | null {
  if (status.source === 'preferences') return 'panel.settings.audiverisChosen';
  if (!audiverisReady(status)) return null;
  return status.launcher === 'flatpak'
    ? 'panel.settings.audiverisFlatpak'
    : 'panel.settings.audiverisDiscovered';
}

// ── The set-up affordance ────────────────────────────────────────────────

type SetupOpener = () => void;
let setupOpener: SetupOpener | null = null;
let focusRequested = false;

export function registerAudiverisSetupOpener(opener: SetupOpener | null): void {
  setupOpener = opener;
}

/** Open Preferences ▸ Engine and bring the Audiveris section into view. */
export function openAudiverisSetup(): void {
  if (!setupOpener) return;
  focusRequested = true;
  setupOpener();
}

/** True once per `openAudiverisSetup`, for the section that scrolls itself
 * into view. */
export function takeAudiverisFocusRequest(): boolean {
  const requested = focusRequested;
  focusRequested = false;
  return requested;
}

// ── Test seams ───────────────────────────────────────────────────────────

/**
 * Hold this answer for the session, whatever the machine has. Reached only
 * from the harness, which exists only in a `VITE_E2E` build. `null` unpins and
 * leaves the session unresolved, so the next ask reads Rust again.
 */
export function pinAudiverisStatus(answer: AudiverisStatusAnswer | null): AudiverisStatus {
  generation++;
  inFlight = null;
  if (answer === null) {
    pinned = null;
    return publish(UNRESOLVED);
  }
  pinned = normalizeAudiverisStatus(answer) ?? FAILED;
  return publish(pinned);
}

/** Forget the session's answer, its subscribers and its opener. */
export function resetAudiverisStatus(): void {
  generation++;
  current = UNRESOLVED;
  readFailed = false;
  inFlight = null;
  pinned = null;
  listeners.clear();
  setupOpener = null;
  focusRequested = false;
}
