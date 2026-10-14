// The edit gate's answer for a character equals the engine's: for every
// script a table face holds, for every family and style, and for a fonts
// folder that lacks some or all of the faces.
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { BUNDLED_FACES } from '../src/renderer/lib/bundled-faces';
import { charactersWithoutFace, provideBundledFaces } from '../src/renderer/lib/text-box-faces';
import type { FaceFamily, FaceStyle } from '../src/renderer/lib/text-box-faces';
import { textBoxEditRefusal } from '../src/renderer/lib/text-box-edit';
import type { PageAnnotation } from '../src/renderer/state/types';
import { testPython } from './support/python';
import { FONT_DIR, HAS_BUNDLED_FACES } from './support/text-engine';

const ROOT = join(__dirname, '..');
const RUN = 180_000;

interface Scenario {
  family: FaceFamily;
  bold: boolean;
  italic: boolean;
  hidden: string[];
}

const every = (table: Record<string, string>): string[] => [...new Set(Object.values(table))];
const LIBERATION = [...every(BUNDLED_FACES.sans), ...every(BUNDLED_FACES.serif), ...every(BUNDLED_FACES.mono)];
const TABLE = [...LIBERATION, ...every(BUNDLED_FACES.cjk), ...every(BUNDLED_FACES.hebrew), ...every(BUNDLED_FACES.arabic)];

const SCENARIOS: Scenario[] = [
  ...(['sans', 'serif', 'mono'] as const).flatMap((family) =>
    [[false, false], [true, false], [false, true], [true, true]].map(([bold, italic]) => ({ family, bold, italic, hidden: [] }))),
  { family: 'sans', bold: true, italic: false, hidden: [BUNDLED_FACES.sans.bold] },
  { family: 'serif', bold: true, italic: true, hidden: every(BUNDLED_FACES.serif) },
  { family: 'mono', bold: false, italic: false, hidden: LIBERATION },
  { family: 'sans', bold: false, italic: false, hidden: [BUNDLED_FACES.sans.regular] },
  { family: 'sans', bold: true, italic: false, hidden: [BUNDLED_FACES.cjk.bold] },
  { family: 'sans', bold: false, italic: false, hidden: every(BUNDLED_FACES.cjk) },
  { family: 'serif', bold: false, italic: false, hidden: every(BUNDLED_FACES.hebrew) },
  { family: 'sans', bold: true, italic: false, hidden: [BUNDLED_FACES.hebrew.bold, BUNDLED_FACES.arabic.bold] },
  { family: 'sans', bold: false, italic: false, hidden: every(BUNDLED_FACES.arabic) },
  { family: 'sans', bold: false, italic: false, hidden: [...every(BUNDLED_FACES.hebrew), ...every(BUNDLED_FACES.arabic), ...every(BUNDLED_FACES.cjk)] },
  { family: 'sans', bold: false, italic: false, hidden: TABLE },
];

const styleOf = (scenario: Scenario): FaceStyle => ({
  family: scenario.family, ...(scenario.bold ? { bold: true as const } : {}), ...(scenario.italic ? { italic: true as const } : {}),
});

afterEach(() => provideBundledFaces(undefined));

describe.skipIf(!HAS_BUNDLED_FACES)('the edit gate and the engine', () => {
  it('refuse the same characters for every script, family, style and set of face files', () => {
    const out = execFileSync(testPython(), ['-B', join(ROOT, 'tests', 'support', 'face_agreement.py')], {
      input: JSON.stringify({ font_path: FONT_DIR, scenarios: SCENARIOS }),
      cwd: ROOT, maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true,
    });
    const { samples, answers } = JSON.parse(out.toString('utf8')) as { samples: string[]; answers: { faces: string[]; refused: boolean[] }[] };
    expect(samples.length).toBeGreaterThan(100);
    expect(answers).toHaveLength(SCENARIOS.length);
    SCENARIOS.forEach((scenario, index) => {
      const { faces, refused } = answers[index];
      expect(refused).toHaveLength(samples.length);
      for (const hidden of scenario.hidden) expect(faces).not.toContain(hidden);
      const held = new Set(faces);
      const differing = samples.filter((character, at) =>
        (charactersWithoutFace(character, styleOf(scenario), held).length > 0) !== refused[at]);
      expect(differing.map((character) => character.codePointAt(0)!.toString(16)), JSON.stringify(scenario)).toEqual([]);
    });
    // Every scenario refuses something and, but for the folders with no face of the family, draws something.
    expect(answers.every((answer) => answer.refused.includes(true))).toBe(true);
    expect(answers.filter((answer) => !answer.refused.includes(false))).toHaveLength(3);
  }, RUN);
});

describe('a text whose face file the fonts folder lacks', () => {
  const box = (note: string): PageAnnotation => ({ id: 'a', kind: 'freetext', x: 0.1, y: 0.1, w: 0.3, h: 0.1, color: '#000000', note } as PageAnnotation);

  it('is refused when the edit is made, by a reason of its own', () => {
    expect(textBoxEditRefusal(box('Zażółć 中文'), 1)).toBeNull();
    provideBundledFaces(TABLE.filter((name) => !every(BUNDLED_FACES.cjk).includes(name)));
    expect(textBoxEditRefusal(box('Zażółć'), 2)).toBeNull();
    expect(textBoxEditRefusal(box('Zażółć 中文'), 2)).toMatchObject({ reason: 'faces', page: 2, kind: 'freetext' });
    // A character no table face holds keeps its own reason.
    expect(textBoxEditRefusal(box('中 न'), 2)).toMatchObject({ reason: 'script', characters: ['न'] });
    provideBundledFaces([]);
    expect(textBoxEditRefusal(box('Zażółć'), 3)).toMatchObject({ reason: 'faces' });
    // The standard font draws without a face file.
    expect(textBoxEditRefusal(box('plain “text”'), 3)).toBeNull();
  });
});
