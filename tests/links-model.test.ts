// The renderer's link model and the canvas→panel channels. There is no DOM
// test environment, so what a component would get wrong lives in a module and
// the module is what gets pinned — the crop-draw discipline, one derivation
// over. The engine holds the same vocabulary and refuses the same things;
// these tests pin the half that decides what is SENT.
import { describe, it, expect, beforeEach } from 'vitest';
import { pageRectFromBand } from '../src/renderer/lib/crop-draw';
import {
  AUTHORED_KINDS,
  VIEW_OPERANDS,
  appearancePayload,
  appearanceProblem,
  colorToTriple,
  consumeDrawnLink,
  consumePickedLink,
  defaultAppearance,
  emptyTarget,
  isAuthored,
  linksForPage,
  publishDrawnLink,
  publishPickedLink,
  subscribeDrawnLink,
  subscribePickedLink,
  targetPayload,
  targetProblem,
  tripleToColor,
  viewPayload,
  __resetLinkChannel,
  type LinkAppearance,
  type LinkRegion,
  type LinkTarget,
} from '../src/renderer/lib/links';

const CTX = { pageCount: 5, names: ['Chapter1', 'Intro'] as const };

describe('the authored kinds', () => {
  it('offers exactly the four the engine writes', () => {
    expect([...AUTHORED_KINDS]).toEqual(['uri', 'goto', 'named', 'file']);
  });

  it('never treats a read-only kind as authorable', () => {
    for (const kind of ['launch', 'other', 'none', 'javascript']) {
      expect(isAuthored(kind)).toBe(false);
    }
    for (const kind of AUTHORED_KINDS) expect(isAuthored(kind)).toBe(true);
  });

  it('a fresh go-to inherits the reader’s zoom rather than moving their view', () => {
    expect(emptyTarget('goto')).toEqual({ kind: 'goto', page: 1, view: { mode: 'inherit' } });
  });
});

describe('targetProblem', () => {
  it('passes a complete target of every authored kind', () => {
    const complete: LinkTarget[] = [
      { kind: 'uri', url: 'https://x.example' },
      { kind: 'goto', page: 3 },
      { kind: 'named', name: 'Intro' },
      { kind: 'file', path: 'other.pdf', page: 2 },
    ];
    for (const target of complete) expect(targetProblem(target, CTX)).toBeNull();
  });

  it('names the empty field rather than letting Create be pressed', () => {
    expect(targetProblem({ kind: 'uri', url: '   ' }, CTX)).toBe('panel.links.problem.url');
    expect(targetProblem({ kind: 'named', name: '' }, CTX)).toBe('panel.links.problem.name');
    expect(targetProblem({ kind: 'file', path: ' ' }, CTX)).toBe('panel.links.problem.path');
    expect(targetProblem({ kind: 'goto', page: null }, CTX)).toBe('panel.links.problem.page');
  });

  it('refuses a page this document does not have', () => {
    expect(targetProblem({ kind: 'goto', page: 0 }, CTX)).toBe('panel.links.problem.pageRange');
    expect(targetProblem({ kind: 'goto', page: 6 }, CTX)).toBe('panel.links.problem.pageRange');
    expect(targetProblem({ kind: 'goto', page: 5 }, CTX)).toBeNull();
  });

  it('refuses a fractional page rather than rounding one the user did not type', () => {
    expect(targetProblem({ kind: 'goto', page: 2.5 }, CTX)).toBe('panel.links.problem.page');
    expect(targetProblem({ kind: 'file', path: 'a.pdf', page: 2.5 }, CTX)).toBe(
      'panel.links.problem.filePage',
    );
  });

  it('refuses a name the document does not declare', () => {
    expect(targetProblem({ kind: 'named', name: 'Nowhere' }, CTX)).toBe(
      'panel.links.problem.unknownName',
    );
  });

  it('a file target without a page is complete — the file itself is the target', () => {
    expect(targetProblem({ kind: 'file', path: 'a.pdf' }, CTX)).toBeNull();
    expect(targetProblem({ kind: 'file', path: 'a.pdf', page: null }, CTX)).toBeNull();
  });

  it('refuses every read-only kind', () => {
    expect(targetProblem({ kind: 'launch', path: 'run.exe' }, CTX)).toBe(
      'panel.links.problem.readOnly',
    );
    expect(targetProblem({ kind: 'none' }, CTX)).toBe('panel.links.problem.readOnly');
  });
});

describe('targetPayload', () => {
  it('sends only the fields of the kind it is sending', () => {
    // The editor keeps the previous kind's state; sending it would author a
    // /GoToR carrying a url nothing reads.
    const target = { kind: 'file', path: ' plans.pdf ', page: 4, new_window: true } as LinkTarget;
    expect(targetPayload(target)).toEqual({
      kind: 'file',
      path: 'plans.pdf',
      page: 4,
      view: { mode: 'inherit' },
      new_window: true,
    });
  });

  it('omits the page and view of a file target that names no page', () => {
    expect(targetPayload({ kind: 'file', path: 'a.pdf' })).toEqual({ kind: 'file', path: 'a.pdf' });
  });

  it('omits new_window when it is off rather than writing a false nobody asked for', () => {
    const payload = targetPayload({ kind: 'file', path: 'a.pdf', new_window: false });
    expect('new_window' in payload).toBe(false);
  });

  it('trims a pasted address and name', () => {
    expect(targetPayload({ kind: 'uri', url: '  https://x.example  ' })).toEqual({
      kind: 'uri',
      url: 'https://x.example',
    });
    expect(targetPayload({ kind: 'named', name: ' Intro ' })).toEqual({
      kind: 'named',
      name: 'Intro',
    });
  });
});

describe('viewPayload', () => {
  it('sends exactly the operands its mode carries', () => {
    for (const [mode, operands] of Object.entries(VIEW_OPERANDS)) {
      const payload = viewPayload({ mode: mode as never, left: 1, top: 2, zoom: 3, bottom: 4, right: 5 });
      expect(Object.keys(payload).sort()).toEqual(['mode', ...operands].sort());
    }
  });

  it('an unset operand is null — "not stated" is not zero', () => {
    expect(viewPayload({ mode: 'fith' })).toEqual({ mode: 'fith', top: null });
    expect(viewPayload({ mode: 'fith', top: 0 })).toEqual({ mode: 'fith', top: 0 });
  });

  it('defaults to inherit when no view was chosen', () => {
    expect(viewPayload(undefined)).toEqual({ mode: 'inherit' });
  });
});

describe('appearance', () => {
  it('a new link is invisible, the commercial default', () => {
    expect(defaultAppearance()).toEqual({
      width: 0,
      style: 'solid',
      color: null,
      highlight: 'invert',
    });
  });

  it('sends no colour and no dashes for a border that is not drawn', () => {
    const invisible: LinkAppearance = {
      width: 0,
      style: 'dashed',
      color: [1, 0, 0],
      highlight: 'invert',
      dashes: [4, 2],
    };
    expect(appearancePayload(invisible)).toEqual({
      width: 0,
      style: 'dashed',
      highlight: 'invert',
    });
  });

  it('sends dashes only for the dashed style', () => {
    const base: LinkAppearance = { width: 2, style: 'solid', color: null, highlight: 'invert', dashes: [4, 2] };
    expect('dashes' in appearancePayload(base)).toBe(false);
    expect(appearancePayload({ ...base, style: 'dashed' }).dashes).toEqual([4, 2]);
  });

  it('refuses what the engine refuses', () => {
    const base = defaultAppearance();
    expect(appearanceProblem(base)).toBeNull();
    expect(appearanceProblem({ ...base, width: -1 })).toBe('panel.links.problem.width');
    expect(appearanceProblem({ ...base, width: Number.NaN })).toBe('panel.links.problem.width');
    expect(appearanceProblem({ ...base, style: 'beveled' })).toBe('panel.links.problem.style');
    expect(appearanceProblem({ ...base, width: 1, color: [1, 0, 2] })).toBe(
      'panel.links.problem.color',
    );
  });
});

describe('colour conversion', () => {
  it('round-trips a chosen colour to the byte', () => {
    for (const hex of ['#000000', '#ffffff', '#3366cc', '#ff8800']) {
      expect(tripleToColor(colorToTriple(hex))).toBe(hex);
    }
  });

  it('refuses anything that is not a six-digit hex colour', () => {
    for (const bad of ['', 'red', '#fff', '#12345g', 'rgb(1,2,3)']) {
      expect(colorToTriple(bad)).toBeNull();
    }
  });

  it('a link with no colour shows black rather than throwing', () => {
    expect(tripleToColor(null)).toBe('#000000');
    expect(tripleToColor([0.5])).toBe('#000000');
  });
});

describe('linksForPage', () => {
  const region = (pageId: string, index: number): LinkRegion => ({
    path: 'a.pdf',
    page: 1,
    index,
    pageId,
    kind: 'uri',
    rect: { x: 0, y: 0, w: 0.1, h: 0.1 },
  });

  it('keeps only this page’s regions', () => {
    const all = [region('p1', 0), region('p2', 1), region('p1', 2)];
    expect(linksForPage(all, 'p1').map((r) => r.index)).toEqual([0, 2]);
  });

  it('returns ONE shared empty array, so a page with no links does not re-render', () => {
    // The cell is memoised; a fresh [] every pass would defeat that.
    const empty = linksForPage([], 'p1');
    expect(linksForPage(undefined, 'p1')).toBe(empty);
    expect(linksForPage([region('p2', 0)], 'p1')).toBe(empty);
  });
});

describe('the canvas → panel channels', () => {
  beforeEach(() => __resetLinkChannel());

  it('a drawn rect reaches a subscriber and is consumed once', () => {
    const seen: number[] = [];
    subscribeDrawnLink((l) => seen.push(l.page));
    publishDrawnLink({ page: 3, rect: [1, 2, 3, 4], path: 'a.pdf' });
    expect(seen).toEqual([3]);
    // Read on mount by a panel that was collapsed when the rect was drawn…
    expect(consumeDrawnLink()?.page).toBe(3);
    // …and gone afterwards, so a remount does not refill the editor.
    expect(consumeDrawnLink()).toBeNull();
  });

  it('unsubscribing stops delivery', () => {
    const seen: string[] = [];
    const off = subscribeDrawnLink((l) => seen.push(l.path));
    off();
    publishDrawnLink({ page: 1, rect: [0, 0, 1, 1], path: 'a.pdf' });
    expect(seen).toEqual([]);
  });

  it('a picked link carries the engine’s own address', () => {
    const seen: string[] = [];
    subscribePickedLink((l) => seen.push(`${l.path}:${l.page}:${l.index}`));
    publishPickedLink({ path: 'a.pdf', page: 2, index: 1 });
    expect(seen).toEqual(['a.pdf:2:1']);
    expect(consumePickedLink()).toEqual({ path: 'a.pdf', page: 2, index: 1 });
    expect(consumePickedLink()).toBeNull();
  });

  it('a second draw replaces the first — one pending rect, never a queue', () => {
    publishDrawnLink({ page: 1, rect: [0, 0, 1, 1], path: 'a.pdf' });
    publishDrawnLink({ page: 2, rect: [0, 0, 1, 1], path: 'a.pdf' });
    expect(consumeDrawnLink()?.page).toBe(2);
  });
});

describe('the band a link is drawn with', () => {
  // The same conversion the article bead uses — shared on purpose, because two
  // implementations of the quarter-turn rule is how a landscape scan gets its
  // geometry on the wrong axis.
  const VIEW = [0, 0, 400, 600] as const;

  it('maps an unrotated band to page space with y flipped', () => {
    expect(pageRectFromBand({ x: 0, y: 0, w: 0.5, h: 0.5 }, VIEW)).toEqual([0, 300, 200, 600]);
  });

  it('follows the page’s displayed turn', () => {
    const band = { x: 0, y: 0, w: 0.5, h: 0.5 };
    expect(pageRectFromBand(band, VIEW, 90)).toEqual([0, 0, 200, 300]);
    expect(pageRectFromBand(band, VIEW, 180)).toEqual([200, 0, 400, 300]);
    expect(pageRectFromBand(band, VIEW, 270)).toEqual([200, 300, 400, 600]);
  });

  it('a click is not a link region', () => {
    expect(pageRectFromBand({ x: 0.5, y: 0.5, w: 0, h: 0 }, VIEW)).toBeNull();
  });
});
