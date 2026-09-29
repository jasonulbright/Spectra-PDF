export interface PromptTurnBridge {
  begin: () => Promise<number | null>;
  end: (token: number) => Promise<unknown>;
}

/**
 * Run a prompt with this window on screen. A hidden or minimized window takes
 * a turn and is brought forward before `prompt` runs; the turn is returned
 * whatever the answer, so the next hidden window can prompt. A turn that
 * cannot be taken does not suppress the prompt.
 */
export async function withPromptTurn<T>(
  bridge: PromptTurnBridge,
  prompt: () => Promise<T>,
): Promise<T> {
  let token: number | null;
  try {
    token = await bridge.begin();
  } catch {
    token = null;
  }
  try {
    return await prompt();
  } finally {
    if (token !== null) {
      try {
        await bridge.end(token);
      } catch {
        // A window destroyed mid-release is released by Rust on destroy.
      }
    }
  }
}
