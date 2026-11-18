import { describe, it, expect } from 'vitest';
import { marksNotCovered, redactionRectsFromSelection } from '../src/renderer/lib/redaction-selection';

// A 1000 x 2000 page box at the screen origin, so a client coordinate divided by
// the box size is the normalized value.
const BOX = { left: 0, top: 0, right: 1000, bottom: 2000 };
const r = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });

describe('redaction marks from a text selection', () => {
  it('merges the fragments of one line into one mark with the line extents', () => {
    // A normal word, a bold word one pixel taller, a second normal word.
    const marks = redactionRectsFromSelection(
      [r(100, 200, 300, 220), r(300, 198, 400, 222), r(400, 200, 600, 220)],
      BOX,
    );
    expect(marks).toHaveLength(1);
    expect(marks[0].x).toBeCloseTo(0.1);
    expect(marks[0].w).toBeCloseTo(0.5);
    expect(marks[0].y).toBeCloseTo(198 / 2000);
    expect(marks[0].h).toBeCloseTo(24 / 2000);
  });

  it('keeps separate lines apart, top to bottom', () => {
    const marks = redactionRectsFromSelection(
      [r(100, 300, 500, 320), r(100, 200, 700, 220), r(100, 250, 400, 270)],
      BOX,
    );
    expect(marks.map((m) => Math.round(m.y * 2000))).toEqual([200, 250, 300]);
  });

  it('treats two lines whose boxes only touch as two lines', () => {
    const marks = redactionRectsFromSelection([r(0, 200, 500, 220), r(0, 219, 500, 239)], BOX);
    expect(marks).toHaveLength(2);
  });

  it('skips rects on other pages and clamps overhang to the page', () => {
    const marks = redactionRectsFromSelection(
      [r(900, 100, 1100, 120), r(100, 2500, 300, 2520), r(-50, 400, 200, 420)],
      BOX,
    );
    expect(marks).toHaveLength(2);
    expect(marks[0].x + marks[0].w).toBeCloseTo(1);
    expect(marks[1].x).toBe(0);
  });

  it('returns nothing for an empty or degenerate selection', () => {
    expect(redactionRectsFromSelection([], BOX)).toEqual([]);
    expect(redactionRectsFromSelection([r(10, 10, 10, 30)], BOX)).toEqual([]);
  });

  it('gives every line of a tall multi-line selection the full width of its text', () => {
    const marks = redactionRectsFromSelection(
      [r(300, 200, 900, 220), r(100, 220, 900, 240), r(100, 240, 500, 260)],
      BOX,
    );
    expect(marks).toHaveLength(3);
    expect(marks[0].x).toBeCloseTo(0.3);
    expect(marks[2].x + marks[2].w).toBeCloseTo(0.5);
  });

  it('ignores an element box the size of the page', () => {
    // What Range.getClientRects() adds for a raster or layer inside the range.
    const marks = redactionRectsFromSelection([r(0, 0, 1000, 2000), r(100, 200, 500, 220)], BOX);
    expect(marks).toHaveLength(1);
    expect(marks[0].h).toBeCloseTo(20 / 2000);
  });

  it('keeps the columns of turned text apart and covers only the selected part', () => {
    // A page turned a quarter-turn: each line is a tall, narrow column.
    const marks = redactionRectsFromSelection(
      [r(200, 600, 220, 1400), r(230, 400, 250, 1000), r(260, 400, 280, 900)],
      BOX,
      true,
    );
    expect(marks).toHaveLength(3);
    const first = marks.find((m) => Math.abs(m.x - 0.2) < 0.001);
    expect(first?.y).toBeCloseTo(0.3);
    expect(first?.h).toBeCloseTo(0.4);
  });

  it('does not merge fragments whose union would cover far more than they do', () => {
    // Two diagonal-text boxes that overlap vertically but sit far apart.
    const marks = redactionRectsFromSelection([r(100, 200, 200, 600), r(700, 250, 800, 650)], BOX);
    expect(marks).toHaveLength(2);
  });

  it('skips marks an existing mark already covers', () => {
    const existing = [{ x: 0.1, y: 0.1, w: 0.5, h: 0.02 }];
    const word = { x: 0.2, y: 0.1, w: 0.1, h: 0.02 };
    const other = { x: 0.1, y: 0.2, w: 0.3, h: 0.02 };
    expect(marksNotCovered([word, other], existing)).toEqual([other]);
    expect(marksNotCovered([word], [])).toEqual([word]);
  });

  it('makes one mark per upright line when every fragment is one glyph', () => {
    // A PDF that emits one text item per character: each fragment is taller than
    // wide, yet the text runs left to right.
    const glyphs = (top: number) => [0, 1, 2, 3, 4].map((i) => r(100 + i * 9, top, 107 + i * 9, top + 20));
    const marks = redactionRectsFromSelection([...glyphs(200), ...glyphs(230)], BOX);
    expect(marks).toHaveLength(2);
    expect(marks[0].w).toBeGreaterThan(marks[0].h);
  });

  it('keeps a bullet with its line', () => {
    const marks = redactionRectsFromSelection(
      [r(100, 200, 108, 220), r(120, 200, 500, 220)],
      BOX,
    );
    expect(marks).toHaveLength(1);
    expect(marks[0].x).toBeCloseTo(0.1);
  });
});
