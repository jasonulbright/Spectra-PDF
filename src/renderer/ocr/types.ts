export interface OcrWord {
  text: string
  x: number
  y: number
  w: number
  h: number
  /** Tesseract's per-word confidence, 0..100 (-1 where it classified nothing).
   *  Absent on results produced before the engine reported it. */
  conf?: number
}

export interface OcrResult {
  text: string
  words: OcrWord[]
}
