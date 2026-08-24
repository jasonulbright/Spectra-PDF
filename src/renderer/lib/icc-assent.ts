// Has the bundled colour profiles' licence been accepted? — the renderer's
// ONE answer.
//
// The profiles ship under a bundling agreement whose Exhibit B end-user
// licence has to be PRESENTED to the user and accepted. The installer does
// that through its licence page (or `/acceptEULA` when unattended) and records
// the answer beside the executable, so an installed copy never asks again. A
// portable copy has no installer, so the application presents the same text on
// first run and records the answer itself.
//
// `gs-capability.ts` is the model and the reason for the shape: a LEAF module
// (no React, no DOM, no component imports) holding a synchronous snapshot for
// render-time reads plus a subscription, so accepting lights every dependent
// surface up in place rather than at the next launch.
//
// Three surfaces depend on a bundled profile: the destination a CMYK
// conversion converts to, the `/DestOutputProfile` a PDF/X output intent
// embeds, and the press an output preview soft-proofs against. Declining
// leaves all three NAMED-DISABLED — the Ghostscript posture — and leaves every
// other capability in the product untouched.

import { app } from './tauri-bridge';

/** The recorded answer. Mirrors `IccAssent` in `src-tauri/src/portable.rs`;
 * control flow matches these values, never a message. */
export const ICC_ACCEPTED = 'accepted';
export const ICC_DECLINED = 'declined';
/** No answer is on record. The only state that opens the dialog. */
export const ICC_UNRECORDED = 'unrecorded';

export interface IccAssentState {
  /** True in the portable container. An installed copy is never portable and
   * never presents the dialog, because its record always exists. */
  portable: boolean;
  assent: typeof ICC_ACCEPTED | typeof ICC_DECLINED | typeof ICC_UNRECORDED;
  /** The licence file in the payload tree, or '' when it is absent. */
  licensePath: string;
  /** True until the first read of this session lands. A pending answer is NOT
   * a declined one: a surface disabled on it would flash a refusal on every
   * launch that it is about to withdraw. */
  pending: boolean;
}

const UNRESOLVED: IccAssentState = {
  portable: false,
  assent: ICC_UNRECORDED,
  licensePath: '',
  pending: true,
};

/** The Rust command's shape. `assent` arrives as a plain string and is
 * narrowed in `settled`; an unrecognized value is UNRECORDED, never assumed
 * accepted. */
export interface BridgeAnswer {
  portable: boolean;
  assent: string;
  licensePath: string;
}

let current: IccAssentState = UNRESOLVED;
let inFlight: Promise<IccAssentState> | null = null;
let pinned: IccAssentState | null = null;
const listeners = new Set<() => void>();

function publish(next: IccAssentState): IccAssentState {
  current = next;
  for (const listener of [...listeners]) listener();
  return next;
}

function settled(answer: BridgeAnswer): IccAssentState {
  return {
    portable: !!answer.portable,
    assent:
      answer.assent === ICC_ACCEPTED
        ? ICC_ACCEPTED
        : answer.assent === ICC_DECLINED
          ? ICC_DECLINED
          : ICC_UNRECORDED,
    licensePath: answer.licensePath ?? '',
    pending: false,
  };
}

/** The answer as of now, without waiting. What a render pass reads. */
export function iccAssent(): IccAssentState {
  return current;
}

/** Re-render when the answer lands or changes. Returns the unsubscribe. */
export function subscribeIccAssent(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The answer, read from Rust if this session has not read it yet.
 *
 * A failed read stays PENDING rather than caching as a refusal — the
 * `ensureGsCapability` regression, kept fixed here: one early IPC hiccup must
 * not disable colour conversion for the rest of the session.
 */
export function ensureIccAssent(): Promise<IccAssentState> {
  if (pinned) return Promise.resolve(pinned);
  if (!current.pending) return Promise.resolve(current);
  if (!inFlight) {
    inFlight = app
      .iccAssentState()
      .then((answer) => publish(settled(answer)))
      .catch(() => current)
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

/**
 * Records the user's answer and publishes the new state.
 *
 * Rust writes the record and drops the running engine, so the next engine call
 * spawns one carrying the new value — the assent rides an environment variable
 * a live subprocess read once at spawn.
 */
export async function recordIccAssent(accepted: boolean): Promise<IccAssentState> {
  if (pinned) return pinned;
  const answer = await app.recordIccAssent(accepted);
  return publish(settled(answer));
}

/** The Exhibit B text to present. Read from the file the profiles ship beside,
 * which is the same file the installer's licence page shows. */
export function iccLicenseText(): Promise<string> {
  return app.iccLicenseText();
}

// ── Decisions the surfaces share ─────────────────────────────────────────

/**
 * Does a bundled-profile surface refuse right now?
 *
 * The one predicate every dependent surface shares, so "disabled" cannot mean
 * one thing in the Prepress panel and another in the output preview. Pending
 * is NOT blocked — see `IccAssentState.pending`.
 */
export function iccBlocked(state: IccAssentState = current): boolean {
  return !state.pending && state.assent !== ICC_ACCEPTED;
}

/**
 * Should the first-run dialog open?
 *
 * Only an unrecorded answer in the portable container. A decline is a recorded
 * answer and must not re-open the dialog on every launch; the notice on each
 * disabled surface is how the user gets back to it.
 */
export function iccNeedsAssent(state: IccAssentState = current): boolean {
  return !state.pending && state.portable && state.assent === ICC_UNRECORDED;
}

// ── The reconsider affordance ────────────────────────────────────────────
//
// The module-level slot idiom `gs-capability.ts` uses for Settings ▸ Engine:
// App registers the opener while it is mounted, and every disabled surface
// calls one function rather than each holding its own route to the dialog.

type DialogOpener = () => void;
let dialogOpener: DialogOpener | null = null;

export function registerIccLicenseOpener(opener: DialogOpener | null): void {
  dialogOpener = opener;
}

/** Re-open the licence dialog. A no-op before App mounts, which is not
 * reachable from a rendered control. */
export function openIccLicense(): void {
  dialogOpener?.();
}

/**
 * Test seam: hold this answer for the session, whatever the machine has.
 *
 * `pinGsCapability`'s reason applies unchanged. The end-to-end suite runs from
 * a folder — which IS the portable shape — but it cannot arrange a declined
 * container from outside without writing into the payload tree under test.
 * Pinning wins over the read, so a surface's own refresh cannot lift it.
 */
export function pinIccAssent(answer: BridgeAnswer | null): IccAssentState {
  inFlight = null;
  if (answer === null) {
    pinned = null;
    return publish(UNRESOLVED);
  }
  pinned = settled(answer);
  return publish(pinned);
}

/** Test seam: forget the session's answer and its subscribers. */
export function resetIccAssent(): void {
  current = UNRESOLVED;
  inFlight = null;
  pinned = null;
  listeners.clear();
  dialogOpener = null;
}
