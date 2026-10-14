// The edit gate admits a text exactly when the engine's layout answers it,
// and a text the layout answers is drawn: over one list of sample texts
// (`support/text-box-samples.json`) that the engine's own test reads too.
// The samples hold characters that share a glyph in a face, with and
// without a shaped run beside them.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appReducer } from '../src/renderer/state/reducer';
import { textBoxEditRefusal } from '../src/renderer/lib/text-box-edit';
import { provideBundledFaces } from '../src/renderer/lib/text-box-faces';
import { MetadataTestWorker, prepareMetadataWorker } from './helpers/metadata-worker';
import { commit, importedPages } from './support/commit-cycle';
import { expectSound } from './support/saved-pdf';
import { FONT_DIR, HAS_BUNDLED_FACES, pythonTextEngine } from './support/text-engine';
import { appearances, blank, box, opened, pagesOf, placing, readByViewer, sorted } from './support/text-box-fixtures';

beforeAll(prepareMetadataWorker, 30000);
beforeEach(() => vi.stubGlobal('Worker', MetadataTestWorker));

const RUN = 240_000;

interface Sample {
  text: string;
  /** `exact`: a reader extracts the text as written. `characters`: the
   *  line is shown in visual order, so a reader extracts the same
   *  characters. `refused`: no bundled face draws the text. */
  read: 'exact' | 'characters' | 'refused';
}

const SAMPLES = (JSON.parse(readFileSync(join(__dirname, 'support', 'text-box-samples.json'), 'utf8')) as { samples: Sample[] }).samples;

/** A text as pdf.js extracts it: a no-break space and an em space are a
 *  space, a soft hyphen and a zero width non-joiner are left out, and the
 *  ligature of f and i is its two letters. */
const asViewerReads = (text: string): string =>
  text.replace(/[\u00ad\u200c]/g, '').replace(/[\u00a0\u2003]/g, ' ').replace(/\ufb01/g, 'fi');

/** A text as a line draws it: a soft hyphen draws nothing inside a line. */
const asDrawn = (text: string): string => text.replace(/\u00ad/g, '');

/** pdf.js gives a glyph whose code spells nothing, the mark of a shaped
 *  cluster, as a control character. */
// eslint-disable-next-line no-control-regex
const withoutControls = (text: string): string => text.replace(/[\u0000-\u001f]/g, '');

const placed = (sample: Sample, index: number) =>
  box(sample.text, { id: `sample-${index}`, x: 0.02, y: 0.01 + index * 0.029, w: 0.96, h: 0.027 });

describe.skipIf(!HAS_BUNDLED_FACES)('the edit gate and the layout of the engine, over the shared samples', () => {
  beforeAll(() => provideBundledFaces(readdirSync(FONT_DIR)));
  afterAll(() => provideBundledFaces(undefined));

  it('agree on every sample, and the reducer takes exactly the edits the layout answers', async () => {
    expect(SAMPLES.length).toBeGreaterThan(30);
    const answer = await pythonTextEngine(SAMPLES.map((sample) => ({ text: sample.text, size: 12, family: 'sans' as const })), false);
    expect(answer.blocks).toHaveLength(SAMPLES.length);
    const bytes = await blank();
    const state = opened(await importedPages(bytes), bytes);
    SAMPLES.forEach((sample, index) => {
      const block = answer.blocks[index];
      const refusal = textBoxEditRefusal(placed(sample, index), 1);
      const name = JSON.stringify(sample.text);
      expect(refusal !== null, name).toBe(block.refused !== undefined);
      expect(block.refused !== undefined, name).toBe(sample.read === 'refused');
      if (refusal) {
        expect(refusal.reason, name).toBe('script');
        expect([...(refusal.characters ?? [])].sort(), name).toEqual([...block.refused!].sort());
      }
      const next = appReducer(state, { type: 'ADD_ANNOTATION', docId: 'a.pdf#0', pageId: pagesOf(state)[0].id, annotation: placed(sample, index) });
      expect(next.workspace !== state.workspace, name).toBe(refusal === null);
      expect(next.pageEditRefusals - state.pageEditRefusals, name).toBe(refusal === null ? 0 : 1);
    });
  }, RUN);

  it('are followed by a build that draws every admitted sample, read back by the importer and by a viewer', async () => {
    const admitted = SAMPLES.map((sample, index) => ({ sample, annotation: placed(sample, index) }))
      .filter(({ annotation }) => textBoxEditRefusal(annotation, 1) === null);
    expect(admitted.length).toBe(SAMPLES.filter((sample) => sample.read !== 'refused').length);
    const output = await commit(await blank(), placing(...admitted.map(({ annotation }) => annotation)));
    await expectSound(output);
    const drawn = await appearances(output);
    const viewed = await readByViewer(output);
    expect(drawn).toHaveLength(admitted.length);
    expect(viewed).toHaveLength(admitted.length);
    const differing: string[] = [];
    admitted.forEach(({ sample }, index) => {
      const name = JSON.stringify(sample.text);
      expect(drawn[index].lines, name).toHaveLength(1);
      const seen = viewed[index].join('\n');
      if (sample.read === 'exact') {
        expect(drawn[index].shown, name).toBe(asDrawn(sample.text));
        if (seen !== asViewerReads(sample.text)) differing.push(`${name} read as ${JSON.stringify(seen)}`);
      } else {
        expect(sorted(drawn[index].shown), name).toBe(sorted(asDrawn(sample.text)));
        if (sorted(withoutControls(seen)) !== sorted(asViewerReads(sample.text))) differing.push(`${name} read as ${JSON.stringify(seen)}`);
      }
    });
    expect(differing).toEqual([]);
  }, RUN);
});
