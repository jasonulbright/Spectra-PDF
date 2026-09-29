import { readingSequence, type OrientedItem } from '../search/text-order';

export interface LayerContainer<N> {
  replaceChildren(...nodes: N[]): void;
}

/**
 * Re-sequences a rendered pdf.js text layer into reading order. Native
 * selection and copy walk DOM order, and pdf.js appends spans in content-stream
 * order; the spans are absolutely positioned, so moving them changes no
 * geometry. `divs[i]` is the span pdf.js built for `items[i]` (its `textDivs`);
 * an empty item has a span that was never attached and stays detached.
 * Returns false and leaves the layer alone when the order is content-stream
 * order or when pdf.js truncated the layer (fewer spans than items).
 */
export function applyReadingOrder<N>(
  container: LayerContainer<N>,
  divs: readonly N[],
  items: readonly OrientedItem[],
  pageRotate: number,
  makeBreak: () => N,
): boolean {
  if (divs.length !== items.length) return false;
  const steps = readingSequence(items, pageRotate);
  if (!steps) return false;
  const nodes: N[] = [];
  for (const step of steps) {
    if (step.kind === 'break') nodes.push(makeBreak());
    else if (items[step.index].str !== '') nodes.push(divs[step.index]);
  }
  container.replaceChildren(...nodes);
  return true;
}
