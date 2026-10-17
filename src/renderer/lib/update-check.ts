export type UpdateFailureKind = 'network' | 'signature' | 'disabled' | 'other';
export type UpdateContainer = 'installed' | 'portable' | 'unsupported';
export type UpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'verifying' | 'ready' | 'failed';
export type ApplyOutcome = 'installed' | 'deferred' | 'failed';

export interface UpdateStatus {
  policyDisabled: boolean;
  container: UpdateContainer;
  phase: UpdatePhase;
  version?: string;
  received?: number;
  total?: number;
  failure?: UpdateFailureKind;
  lastApply?: { outcome: ApplyOutcome; version: string };
  /** The version whose apply failed; it is prepared only on an Install click. */
  failedVersion?: string;
}

export interface UpdatePrefs {
  checkOnLaunch: boolean;
  applyAutomatically: boolean;
}

export interface UpdateDeps {
  status: () => Promise<UpdateStatus>;
  check: () => Promise<{ version: string } | null>;
  prepare: (automatic: boolean) => Promise<void>;
}

/** The outcome of a check the user asked for. Every outcome is reported; a failure is never "up to date". */
export type CheckOutcome =
  | { status: 'uptodate' }
  | { status: 'disabled' }
  | { status: 'available'; version: string; preparing: boolean }
  | { status: 'failed'; kind: UpdateFailureKind };

const KINDS: readonly UpdateFailureKind[] = ['network', 'signature', 'disabled', 'other'];

/** `update_check` rejects with `{ kind }`; anything else is `other`. */
export function classifyUpdateFailure(error: unknown): UpdateFailureKind {
  if (error && typeof error === 'object' && 'kind' in error) {
    const kind = (error as { kind: unknown }).kind;
    if (typeof kind === 'string' && (KINDS as readonly string[]).includes(kind)) return kind as UpdateFailureKind;
  }
  return 'other';
}

/** Whether this status lets the app download, verify and stage a found update. */
export function canPrepare(status: UpdateStatus): boolean {
  return !status.policyDisabled && status.container !== 'unsupported';
}

/** A found update starts its download without a click only when the policy, the container and the preference all allow it, and its apply has not failed. */
export function shouldPrepareAutomatically(status: UpdateStatus, prefs: UpdatePrefs, version?: string): boolean {
  return canPrepare(status) && prefs.applyAutomatically && (version === undefined || version !== status.failedVersion);
}

/** Help ▸ Check for Updates. Ignores `checkOnLaunch`; the policy still wins. */
export async function runManualCheck(deps: UpdateDeps, prefs: UpdatePrefs): Promise<CheckOutcome> {
  try {
    const status = await deps.status();
    if (status.policyDisabled) return { status: 'disabled' };
    const update = await deps.check();
    if (!update) return { status: 'uptodate' };
    const preparing = shouldPrepareAutomatically(status, prefs, update.version);
    if (preparing) void deps.prepare(true).catch((e) => console.error('[updater] Prepare failed:', e));
    return { status: 'available', version: update.version, preparing };
  } catch (e) {
    console.error('[updater] Manual check failed:', e);
    const kind = classifyUpdateFailure(e);
    return kind === 'disabled' ? { status: 'disabled' } : { status: 'failed', kind };
  }
}

/** "Install update": the one path that prepares with automatic apply off. */
export async function runInstallClick(deps: UpdateDeps): Promise<boolean> {
  try {
    const status = await deps.status();
    if (!canPrepare(status)) return false;
    await deps.prepare(false);
    return true;
  } catch (e) {
    console.error('[updater] Prepare failed:', e);
    return false;
  }
}

export type BarView =
  | { kind: 'none' }
  | { kind: 'checking' }
  | { kind: 'uptodate' }
  | { kind: 'managed' }
  | { kind: 'checkFailed'; failure: UpdateFailureKind }
  | { kind: 'downloading'; version?: string; percent: number | null }
  | { kind: 'verifying'; version?: string }
  | { kind: 'ready'; version?: string }
  | { kind: 'available'; version: string; install: boolean }
  | { kind: 'prepareFailed' }
  | { kind: 'applied'; outcome: ApplyOutcome; version: string };

export interface BarInputs {
  status: UpdateStatus | null;
  prefs: UpdatePrefs;
  /** The last manual check's outcome, cleared on dismiss. */
  manual: CheckOutcome | 'checking' | null;
  /** The status phase the user dismissed; that phase stays hidden until the phase changes. */
  dismissedPhase: UpdatePhase | null;
  /** Shown once per run in the primary window, then cleared. */
  showLastApply: boolean;
  /** The phase the status left for `failed`. Only a failure out of a download is shown unasked. */
  failedFrom: UpdatePhase | null;
}

const PREPARE_PHASES: readonly UpdatePhase[] = ['available', 'downloading', 'verifying', 'ready'];

function percentOf(received?: number, total?: number): number | null {
  if (typeof received !== 'number' || typeof total !== 'number' || total <= 0) return null;
  return Math.max(0, Math.min(100, Math.floor((received / total) * 100)));
}

/** What the update bar shows. The Rust status outranks a manual outcome once it has left `idle`. */
export function barView(inputs: BarInputs): BarView {
  const { status, prefs, manual, dismissedPhase, showLastApply, failedFrom } = inputs;
  const phase = status?.phase ?? 'idle';
  const hidden = dismissedPhase !== null && dismissedPhase === phase;
  if (status && !hidden) {
    switch (phase) {
      case 'downloading':
        return { kind: 'downloading', version: status.version, percent: percentOf(status.received, status.total) };
      case 'verifying':
        return { kind: 'verifying', version: status.version };
      case 'ready':
        return { kind: 'ready', version: status.version };
      case 'failed':
        if (failedFrom !== null && PREPARE_PHASES.includes(failedFrom)) return { kind: 'prepareFailed' };
        break;
      case 'available':
        if (status.version) {
          return {
            kind: 'available',
            version: status.version,
            install: canPrepare(status) && !shouldPrepareAutomatically(status, prefs, status.version),
          };
        }
        break;
      default:
        break;
    }
  }
  if (manual === 'checking') return { kind: 'checking' };
  if (manual) {
    switch (manual.status) {
      case 'uptodate':
        return { kind: 'uptodate' };
      case 'disabled':
        return { kind: 'managed' };
      case 'failed':
        return { kind: 'checkFailed', failure: manual.kind };
      case 'available':
        if (!hidden) {
          return {
            kind: 'available',
            version: manual.version,
            install: !manual.preparing && status !== null && canPrepare(status),
          };
        }
        break;
    }
  }
  if (showLastApply && status?.lastApply) {
    return { kind: 'applied', outcome: status.lastApply.outcome, version: status.lastApply.version };
  }
  return { kind: 'none' };
}
