/**
 * `text` cut after every path separator. Rendering a line break opportunity
 * (`<wbr>`) between the parts lets a long path wrap at a folder boundary
 * instead of in the middle of the file name, without adding a character to
 * what the reader copies.
 */
export function splitAfterSeparators(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\' || c === '/') {
      parts.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length || parts.length === 0) parts.push(text.slice(start));
  return parts;
}
