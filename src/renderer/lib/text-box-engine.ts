// The engine method `text_box_appearance` as the build and the canvas call it.
import { bundledFacesKnown, provideBundledFaces } from './text-box-faces';
import type { FaceFamily } from './text-box-faces';

/** One text to lay out. */
export interface TextBlockRequest {
  text: string;
  /** Points. */
  size: number;
  /** Points to wrap at; with none a line ends only where the text ends one. */
  width?: number;
  /** Baseline to baseline, in points. */
  leading?: number;
  /** With none: left, or right for a text whose base direction is right to
   *  left. */
  align?: 'left' | 'center' | 'right';
  family: FaceFamily;
  bold?: boolean;
  italic?: boolean;
  /** Blocks of one group share their subset fonts. */
  group?: number;
}

export interface TextBlockResult {
  /** The lines in logical order. */
  lines: string[];
  /** The advance of each line in points. */
  widths: number[];
  rtl: boolean;
  align: 'left' | 'center' | 'right';
  /** The text object, when drawn. */
  content?: string;
  /** The resource names the content selects. */
  fonts?: string[];
  /** The indexes of the lines that end with a drawn soft hyphen. */
  hyphens?: number[];
  /** The characters no bundled face draws: none holds them, or the face
   *  cannot carry the subset. Nothing else is answered. */
  refused?: string;
}

export interface TextBoxAnswer {
  blocks: TextBlockResult[];
  /** A one-page file, base64, whose page resources hold the fonts. */
  pdf?: string;
  /** The face files of the fonts folder, when asked for. */
  faces?: string[];
}

/** Lays out `blocks`, and draws them with `draw`. */
export type TextBoxEngine = (blocks: TextBlockRequest[], draw: boolean) => Promise<TextBoxAnswer>;

type Send = (method: 'text_box_appearance', params: Record<string, unknown>) => Promise<unknown>;

/** The engine over a transport that sends one method call. */
export function textBoxEngine(send: Send, fontPath: () => Promise<string>): TextBoxEngine {
  // A drawing call also names the face files of the folder: the build tells
  // a refusal for a missing file from any other.
  return async (blocks, draw) =>
    (await send('text_box_appearance', { blocks, font_path: await fontPath(), draw, faces: draw })) as TextBoxAnswer;
}

let reader: (() => Promise<string[]>) | undefined;
let learning: Promise<void> | undefined;
let learned = false;

/** Gives the session the read of the face files the fonts folder holds: one
 *  call that lays out nothing. */
export function provideFaceReader(send: Send | undefined, fontPath?: () => Promise<string>): void {
  reader = send && fontPath
    ? async () => {
      const answer = (await send('text_box_appearance', { blocks: [], font_path: await fontPath(), draw: false, faces: true })) as TextBoxAnswer;
      if (!Array.isArray(answer.faces)) throw new Error('the engine named no face files');
      return answer.faces;
    }
    : undefined;
}

/** Reads the face files once per session and gives them to the edit gate
 *  (`provideBundledFaces`). A read that fails leaves nothing behind: the
 *  next call reads again. Calls made while a read runs share it. */
export function learnBundledFaces(): Promise<void> {
  if (learned || !reader) return Promise.resolve();
  if (!learning) {
    const read = reader;
    learning = read().then((faces) => {
      provideBundledFaces(faces);
      learned = true;
    }, () => undefined).finally(() => {
      learning = undefined;
    });
  }
  return learning;
}

/** The longest an edit waits for the read of the face files, in ms. */
export const FACE_READ_WAIT_MS = 5000;

/**
 * Whether the face files of the fonts folder are known, after one read of
 * at most `wait` ms. A read that fails or does not answer in time leaves
 * them unknown, and the next call reads again.
 */
export function awaitBundledFaces(wait: number = FACE_READ_WAIT_MS): Promise<boolean> {
  if (bundledFacesKnown()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(bundledFacesKnown()), wait);
    void learnBundledFaces().then(() => {
      clearTimeout(timer);
      resolve(bundledFacesKnown());
    });
  });
}

/** Forgets the face files: the next `learnBundledFaces` reads them again. */
export function forgetBundledFaces(): void {
  learned = false;
  learning = undefined;
  provideBundledFaces(undefined);
}
