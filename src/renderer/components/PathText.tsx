import React from 'react';
import { splitAfterSeparators } from './path-breaks';

/**
 * Text that may carry a file path, with a break opportunity after each
 * separator. Pair it with `overflow-wrap: anywhere` so a single folder or
 * file name wider than the line still wraps.
 */
export function PathText({ text }: { text: string }): React.ReactElement {
  const parts = splitAfterSeparators(text);
  return (
    <>
      {parts.map((part, i) => (
        <React.Fragment key={i}>
          {part}
          {i < parts.length - 1 && <wbr />}
        </React.Fragment>
      ))}
    </>
  );
}
