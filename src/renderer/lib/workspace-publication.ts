// One ordered publication lane for page commits and disk history. A caller
// captures its revision INSIDE the lane, never in an older render callback.
let tail: Promise<unknown> = Promise.resolve();
let outstanding = 0;

export function hasWorkspacePublication(): boolean { return outstanding > 0; }

export function serializeWorkspacePublication<T>(run: () => Promise<T>): Promise<T> {
  outstanding++;
  const result = tail.then(run);
  tail = result.then(() => {}, () => {}).finally(() => { outstanding--; });
  return result;
}
