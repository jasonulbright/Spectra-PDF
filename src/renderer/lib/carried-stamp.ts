import { PDFDict, PDFName, PDFStream } from 'pdf-lib';
import type { PDFObject } from 'pdf-lib';

/** Whether a stamp's normal appearance is one the label emit cannot redraw:
 * it exists, and its resources are not the label's own (one font named HelvB,
 * one graphics state named GS0, nothing else). An image stamp, a typed
 * signature written without its face name and a stamp of another producer all
 * answer true. The label emit would replace such an appearance with a
 * bordered text box and the build would then drop its image or font.
 * The import sidecar and the commit both ask here, so the canvas draws the
 * appearance exactly when the commit keeps it. */
export function stampAppearanceIsCarried(original: PDFDict | undefined): boolean {
  const appearance = original?.lookup(PDFName.of('AP'));
  const normal = appearance instanceof PDFDict ? appearance.lookup(PDFName.of('N')) : undefined;
  if (normal instanceof PDFDict) return true;
  if (!(normal instanceof PDFStream)) return false;
  const resources = normal.dict.lookup(PDFName.of('Resources'));
  if (!(resources instanceof PDFDict)) return true;
  const only = (holder: PDFObject | undefined, name: string): boolean =>
    holder instanceof PDFDict && holder.keys().length === 1 && holder.has(PDFName.of(name));
  return !(resources.keys().length === 2 && only(resources.lookup(PDFName.of('Font')), 'HelvB')
    && only(resources.lookup(PDFName.of('ExtGState')), 'GS0'));
}
