import type { PasswordResult } from '../components/PasswordDialog';
import type { CertUnlockResult } from '../components/CertUnlockDialog';
import { createConfirmQueue } from './confirm-queue';

type Prompt = { id: number; fileName: string; error?: string };
export type UnlockPrompt = Prompt & (
  | { kind: 'password'; resolve: (answer: PasswordResult) => void }
  | { kind: 'certificate'; pfx?: string; resolve: (answer: CertUnlockResult) => void }
);

/** All encrypted opens in a window share one prompt, including mixed password
 * and certificate files. Answers belong to the request that displayed them. */
export function createUnlockPrompts(show: (request: UnlockPrompt | null) => void) {
  const queue = createConfirmQueue<UnlockPrompt>(show);
  let next = 0;
  return {
    password(fileName: string, error?: string): Promise<PasswordResult> {
      return new Promise(resolve => queue.push({ id: ++next, kind: 'password', fileName, error, resolve }));
    },
    certificate(fileName: string, error?: string, pfx?: string): Promise<CertUnlockResult> {
      return new Promise(resolve => queue.push({ id: ++next, kind: 'certificate', fileName, error, pfx, resolve }));
    },
    answer(request: UnlockPrompt, answer: PasswordResult | CertUnlockResult): void {
      const closed = queue.answer(request.id);
      if (!closed) return;
      if (closed.kind === 'certificate') closed.resolve(answer as CertUnlockResult);
      else closed.resolve(answer);
    },
  };
}
