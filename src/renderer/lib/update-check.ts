export type UpdateFailureKind = 'network' | 'signature' | 'other';

export type UpdateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'available'; version: string }
  | { status: 'uptodate' }
  | { status: 'disabled' }
  | { status: 'failed'; kind: UpdateFailureKind };

export interface UpdateCheckDeps {
  isDisabled: () => Promise<boolean>;
  check: () => Promise<{ version: string } | null>;
}

// The updater plugin rejects with its Rust error's Display text. When every
// endpoint fails (offline, proxy refusal, HTTP error status) it reports
// "Could not fetch a valid release JSON from the remote", so that string is a
// network failure, not a malformed manifest.
const SIGNATURE_RE = /signature|minisign|base64/i;
const NETWORK_RE =
  /release json|error sending request|network|connect|timed? ?out|dns|proxy|tls|certificate|http|status code|unreachable|resolve/i;

export function classifyUpdateFailure(error: unknown): UpdateFailureKind {
  const text = error instanceof Error ? error.message : String(error);
  if (SIGNATURE_RE.test(text)) return 'signature';
  if (NETWORK_RE.test(text)) return 'network';
  return 'other';
}

/** Help ▸ Check for Updates. Every outcome is reported; a failure is never "up to date". */
export async function runManualCheck(deps: UpdateCheckDeps): Promise<UpdateState> {
  try {
    if (await deps.isDisabled()) return { status: 'disabled' };
    const update = await deps.check();
    return update ? { status: 'available', version: update.version } : { status: 'uptodate' };
  } catch (e) {
    console.error('[updater] Manual check failed:', e);
    return { status: 'failed', kind: classifyUpdateFailure(e) };
  }
}

/** Launch check. Only an available update is shown; failure and "current" stay silent. */
export async function runLaunchCheck(
  check: UpdateCheckDeps['check'],
): Promise<UpdateState> {
  try {
    const update = await check();
    return update ? { status: 'available', version: update.version } : { status: 'idle' };
  } catch (e) {
    console.log('[updater] Check failed:', e);
    return { status: 'idle' };
  }
}
