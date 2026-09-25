/** Folds complete sentences left to right through a locale's pair pattern. */
export function foldSentences(sentences: readonly string[], pair: (first: string, second: string) => string): string {
  const parts = sentences.filter((s) => s.length > 0);
  if (parts.length === 0) return '';
  return parts.slice(1).reduce((acc, next) => pair(acc, next), parts[0]);
}
