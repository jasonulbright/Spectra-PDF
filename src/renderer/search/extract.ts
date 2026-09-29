import { OPS } from 'pdfjs-dist'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import { orderedPageText, type OrientedItem } from './text-order'

export interface ExtractedPage {
  text: string
  needsOcr: boolean
}

const MIN_TEXT_CHARS = 16

const IMAGE_OPS = new Set<number>([
  OPS.paintImageXObject,
  OPS.paintImageXObjectRepeat,
  OPS.paintInlineImageXObject,
  OPS.paintImageMaskXObject
])

function isRealGlyph(code: number): boolean {
  return code !== 32 && code !== 9 && code !== 10 && code !== 13
}

async function paintsRasterImage(page: PDFPageProxy): Promise<boolean> {
  const { fnArray } = await page.getOperatorList()
  return fnArray.some((fn) => IMAGE_OPS.has(fn))
}

export async function extractPageText(
  pdf: PDFDocumentProxy,
  pageIndex: number
): Promise<ExtractedPage> {
  const page = await pdf.getPage(pageIndex + 1)
  const content = await page.getTextContent()

  const items: OrientedItem[] = []
  let chars = 0
  for (const item of content.items) {
    if (!('str' in item)) continue
    items.push(item)
    for (let i = 0; i < item.str.length; i++) {
      if (isRealGlyph(item.str.charCodeAt(i))) chars++
    }
  }

  const text = orderedPageText(items, page.rotate)
  const needsOcr = chars < MIN_TEXT_CHARS ? await paintsRasterImage(page) : false
  return { text, needsOcr }
}
