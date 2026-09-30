import { tChrome, type UiKey } from '../i18n';

/** The catalog key and parameters for a refused write over the user's file. */
export interface SaveFailureNotice {
  key: Extract<UiKey, 'app.save.failed' | 'app.save.replaceUnsafe'>;
  params: Record<string, string>;
}

// Matches the English refusal `staging::replace_unsafe` builds in Rust.
const REPLACE_UNSAFE = /does not allow .+ to be replaced safely\./s;

export function saveFailureNotice(dest: string, error: unknown): SaveFailureNotice {
  const name = dest.split(/[\\/]/).pop() ?? dest;
  const reason = error instanceof Error ? error.message : String(error);
  if (REPLACE_UNSAFE.test(reason)) return { key: 'app.save.replaceUnsafe', params: { name } };
  return { key: 'app.save.failed', params: { name, reason } };
}

/** The text for a refused export at `dest`: the localized unsafe-replacement
 * notice, or the error's own message. */
export function writeFailureText(dest: string, error: unknown): string {
  const notice = saveFailureNotice(dest, error);
  return notice.key === 'app.save.replaceUnsafe'
    ? tChrome('app.export.replaceUnsafe', notice.params)
    : notice.params.reason;
}
