// carryOptionalContent (lib/optional-content-carry.ts): a document's layers
// survive the from-scratch rebuild with the visibility their own sources gave
// them. The previous carrier reached groups only six dictionary levels deep
// so a group inside a Form stream lost its registry, dropped every alternate
// configuration, and read one source's OCProperties while ignoring the
// others — which turned a donor page its own document had hidden visible
// (BA-41).
//
// Semantics follow ISO 32000-2 8.11.2 through 8.11.4.5, Tables 96 to 101.
// Every case builds a real PDF, saves it, reopens it, and asserts group
// identity from the RENDERED resource graph, never from the registry alone.
import { describe, expect, it } from 'vitest';
import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNull,
  PDFNumber,
  PDFObject,
  PDFRawStream,
  PDFRef,
  PDFString,
} from 'pdf-lib';

import { carryOptionalContent } from '../src/renderer/lib/optional-content-carry';
import type { CarriedSourcePages } from '../src/renderer/lib/catalog-carry';

const N = PDFName.of.bind(PDFName);

const load = (bytes: Uint8Array) => PDFDocument.load(bytes, { updateMetadata: false });
const blank = () => PDFDocument.create({ updateMetadata: false });

interface Built {
  bytes: Uint8Array;
  /** Resource name of the layer on each page, for reading it back. */
  layerName: string;
}

interface LayerOptions {
  name?: string;
  nest?: number;
  baseState?: string;
  off?: boolean;
  configs?: { name: string; baseState?: string; on?: boolean; intent?: string; locked?: boolean }[];
  intent?: string;
  usage?: boolean;
  as?: boolean;
  rbGroups?: boolean;
  orderLabel?: PDFString | PDFHexString;
  pages?: number;
  extra?: Record<string, PDFObject>;
  registryOnly?: boolean;
}

/** A document with one optional content group whose content sits `nest`
 * Form-XObject levels below the page, so the carrier has to walk streams. */
async function layered(options: LayerOptions = {}): Promise<Built> {
  const {
    name = 'Hidden content', nest = 0, baseState, off = true, configs = [], intent,
    usage = false, as = false, rbGroups = false, orderLabel, pages = 1, extra, registryOnly = false,
  } = options;
  const doc = await blank();
  const ctx = doc.context;

  const groupDict = ctx.obj({ Type: 'OCG' });
  groupDict.set(N('Name'), PDFString.of(name));
  if (intent) groupDict.set(N('Intent'), N(intent));
  if (usage) {
    groupDict.set(
      N('Usage'),
      ctx.obj({
        View: { ViewState: N('ON') },
        Print: { PrintState: N('OFF') },
        Zoom: { min: 0.5, max: 4 },
        CreatorInfo: { Creator: PDFString.of('Probe'), Subtype: N('Technical') },
      }),
    );
  }
  for (const [key, value] of Object.entries(extra ?? {})) groupDict.set(N(key), value);
  const ocg = ctx.register(groupDict);

  const marked = `/OC /Layer BDC 0 0 10 10 re f EMC`;
  for (let p = 0; p < pages; p++) {
    const page = doc.addPage([300, 700]);
    if (registryOnly) {
      // The group is declared but nothing on the page names it.
      page.node.set(N('Resources'), ctx.obj({}));
      page.node.set(N('Contents'), ctx.register(ctx.stream('0 0 5 5 re f')));
      continue;
    }
    if (nest === 0) {
      page.node.set(N('Resources'), ctx.obj({ Properties: { Layer: ocg } }));
      page.node.set(N('Contents'), ctx.register(ctx.stream(marked)));
      continue;
    }
    // Innermost Form holds the marked content and names the group.
    let inner = ctx.register(
      ctx.stream(marked, {
        Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 20, 20],
        Resources: { Properties: { Layer: ocg } },
      }),
    );
    for (let level = 1; level < nest; level++) {
      inner = ctx.register(
        ctx.stream('/Inner Do', {
          Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 20, 20],
          Resources: { XObject: { Inner: inner } },
        }),
      );
    }
    page.node.set(N('Resources'), ctx.obj({ XObject: { Form: inner } }));
    page.node.set(N('Contents'), ctx.register(ctx.stream('/Form Do')));
  }

  const d = ctx.obj({});
  if (baseState) d.set(N('BaseState'), N(baseState));
  if (off) d.set(N('OFF'), ctx.obj([ocg]));
  d.set(N('Order'), orderLabel ? ctx.obj([ctx.obj([orderLabel, ocg])]) : ctx.obj([ocg]));
  if (as) d.set(N('AS'), ctx.obj([{ Event: 'View', Category: [N('Zoom')], OCGs: [ocg] }]));
  if (rbGroups) d.set(N('RBGroups'), ctx.obj([ctx.obj([ocg])]));

  const properties = ctx.obj({});
  properties.set(N('OCGs'), ctx.obj([ocg]));
  properties.set(N('D'), d);
  if (configs.length > 0) {
    const list = ctx.obj([]);
    for (const config of configs) {
      const entry = ctx.obj({});
      entry.set(N('Name'), PDFString.of(config.name));
      if (config.baseState) entry.set(N('BaseState'), N(config.baseState));
      if (config.on) entry.set(N('ON'), ctx.obj([ocg]));
      if (config.intent) entry.set(N('Intent'), N(config.intent));
      if (config.locked) entry.set(N('Locked'), ctx.obj([ocg]));
      list.push(entry);
    }
    properties.set(N('Configs'), list);
  }
  doc.catalog.set(N('OCProperties'), properties);
  return { bytes: await doc.save(), layerName: 'Layer' };
}

/** Run the carrier against real copied pages and publish the result, so every
 * assertion reads a serialized and reopened document. */
async function rebuild(
  plan: { bytes: Uint8Array; indices: number[] }[],
  ownIndex = 0,
): Promise<{ out: PDFDocument; ownMap: Map<string, PDFRef[]> | undefined }> {
  const output = await blank();
  const sources: CarriedSourcePages[] = [];
  const docs: PDFDocument[] = [];
  for (const { bytes, indices } of plan) {
    const doc = await load(bytes);
    docs.push(doc);
    const copied = await output.copyPages(doc, indices);
    for (const page of copied) output.addPage(page);
    sources.push({ doc, pairs: copied.map((outPage, i) => ({ srcIndex: indices[i], outPage })) });
  }
  if (output.getPageCount() === 0) output.addPage([300, 700]);
  const own = sources[ownIndex];
  const carry = carryOptionalContent(output, sources, own);
  // The carrier installs nothing; publishing is the caller's step.
  expect(output.catalog.get(N('OCProperties'))).toBeUndefined();
  if (carry.properties) {
    output.catalog.set(N('OCProperties'), output.context.register(carry.properties));
  }
  return { out: await load(await output.save()), ownMap: carry.identities.get(own.doc) };
}

/** An empty-own contribution: the own document keeps no page. */
async function rebuildOwnEmpty(
  ownBytes: Uint8Array,
  donor: { bytes: Uint8Array; indices: number[] },
): Promise<PDFDocument> {
  const output = await blank();
  const ownDoc = await load(ownBytes);
  const donorDoc = await load(donor.bytes);
  const copied = await output.copyPages(donorDoc, donor.indices);
  for (const page of copied) output.addPage(page);
  const donorSource: CarriedSourcePages = {
    doc: donorDoc,
    pairs: copied.map((outPage, i) => ({ srcIndex: donor.indices[i], outPage })),
  };
  const ownSource: CarriedSourcePages = { doc: ownDoc, pairs: [] };
  const carry = carryOptionalContent(output, [donorSource], ownSource);
  if (carry.properties) output.catalog.set(N('OCProperties'), output.context.register(carry.properties));
  return load(await output.save());
}

/** The group object the page ACTUALLY references, followed through however
 * many Form levels its content sits under. */
function renderedGroup(doc: PDFDocument, pageIndex = 0, layerName = 'Layer'): PDFRef {
  let resources = doc.getPage(pageIndex).node.lookup(N('Resources'), PDFDict);
  for (let guard = 0; guard < 16; guard++) {
    const properties = resources.lookupMaybe(N('Properties'), PDFDict);
    if (properties) {
      const ref = properties.get(N(layerName));
      expect(ref).toBeInstanceOf(PDFRef);
      return ref as PDFRef;
    }
    const xobjects = resources.lookup(N('XObject'), PDFDict);
    resources = rawStream(doc, xobjects.entries()[0][1]).dict.lookup(N('Resources'), PDFDict);
  }
  throw new Error('no Properties reached');
}

/** Look a stream up generically and narrow it to its runtime class: the
 * lookup overloads do not accept PDFRawStream, and a cast would erase the
 * check this actually wants. */
function rawStream(doc: PDFDocument, value: PDFObject | undefined): PDFRawStream {
  const resolved = doc.context.lookup(value);
  expect(resolved).toBeInstanceOf(PDFRawStream);
  return resolved as PDFRawStream;
}

const props = (doc: PDFDocument): PDFDict => doc.catalog.lookup(N('OCProperties'), PDFDict);
const defaultConfig = (doc: PDFDocument): PDFDict => props(doc).lookup(N('D'), PDFDict);
const refsOf = (array: PDFArray | undefined): string[] =>
  array ? array.asArray().map((v) => String(v)) : [];

/** Is the group off under this configuration, per Table 99: base then the
 * explicit lists override. */
function isOff(config: PDFDict, ref: PDFRef): boolean {
  const base = config.lookupMaybe(N('BaseState'), PDFName)?.asString() ?? '/ON';
  const off = refsOf(config.lookupMaybe(N('OFF'), PDFArray)).includes(String(ref));
  const on = refsOf(config.lookupMaybe(N('ON'), PDFArray)).includes(String(ref));
  if (on) return false;
  if (off) return true;
  return base === '/OFF';
}

describe('carryOptionalContent — rendered group identity', () => {
  it.each([0, 1, 3])('registers the group the page renders through %i Form levels', async (nest) => {
    const source = await layered({ nest });
    const { out } = await rebuild([{ bytes: source.bytes, indices: [0] }]);
    const rendered = renderedGroup(out, 0);
    // The registry names the object the content stream resolves to, not a
    // catalog clone nothing draws.
    expect(refsOf(props(out).lookup(N('OCGs'), PDFArray))).toContain(String(rendered));
    expect(out.context.lookup(rendered, PDFDict).lookup(N('Name'), PDFString).decodeText()).toBe('Hidden content');
    expect(isOff(defaultConfig(out), rendered)).toBe(true);
  });

  it('maps the group to one object when two pages of one source share it', async () => {
    const source = await layered({ pages: 2 });
    const { out } = await rebuild([{ bytes: source.bytes, indices: [0, 1] }]);
    const first = renderedGroup(out, 0);
    const second = renderedGroup(out, 1);
    expect(String(first)).toBe(String(second));
    expect(refsOf(props(out).lookup(N('OCGs'), PDFArray))).toEqual([String(first)]);
  });

  it('registers one shared layer for every occurrence of a duplicated page', async () => {
    const source = await layered();
    const doc = await load(source.bytes);
    const output = await blank();
    // Two separate copyPages calls, which is what a duplicated page produces:
    // the intermediate copies are rebound to the source's one layer.
    const pairs: { srcIndex: number; outPage: import('pdf-lib').PDFPage }[] = [];
    for (let i = 0; i < 2; i++) {
      const [copied] = await output.copyPages(doc, [0]);
      output.addPage(copied);
      pairs.push({ srcIndex: 0, outPage: copied });
    }
    const source1: CarriedSourcePages = { doc, pairs };
    const carry = carryOptionalContent(output, [source1], source1);
    output.catalog.set(N('OCProperties'), output.context.register(carry.properties!));
    const out = await load(await output.save());
    const first = renderedGroup(out, 0);
    const second = renderedGroup(out, 1);
    expect(String(first)).toBe(String(second));
    const registry = refsOf(props(out).lookup(N('OCGs'), PDFArray));
    expect(registry).toContain(String(first));
    expect(registry).toContain(String(second));
    // Both renderings keep the hidden state the source gave the group.
    expect(isOff(defaultConfig(out), first)).toBe(true);
    expect(isOff(defaultConfig(out), second)).toBe(true);
  });

  it('reaches a group named only by an annotation appearance stream', async () => {
    const doc = await blank();
    const ctx = doc.context;
    const page = doc.addPage([300, 700]);
    const ocg = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of('Stamp layer') }));
    const appearance = ctx.register(
      ctx.stream('/OC /Layer BDC 0 0 5 5 re f EMC', {
        Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10],
        Resources: { Properties: { Layer: ocg } },
      }),
    );
    const annot = ctx.register(
      ctx.obj({ Type: 'Annot', Subtype: 'Stamp', Rect: [0, 0, 10, 10], AP: { N: appearance } }),
    );
    page.node.set(N('Annots'), ctx.obj([annot]));
    page.node.set(N('Contents'), ctx.register(ctx.stream('0 0 1 1 re f')));
    doc.catalog.set(N('OCProperties'), ctx.obj({ OCGs: [ocg], D: { OFF: [ocg], Order: [ocg] } }));
    const bytes = await doc.save();

    const { out } = await rebuild([{ bytes, indices: [0] }]);
    const outAnnot = out.getPage(0).node.lookup(N('Annots'), PDFArray).lookup(0, PDFDict);
    const outAppearance = rawStream(out, outAnnot.lookup(N('AP'), PDFDict).get(N('N')));
    const nested = outAppearance.dict
      .lookup(N('Resources'), PDFDict)
      .lookup(N('Properties'), PDFDict)
      .get(N('Layer')) as PDFRef;
    expect(refsOf(props(out).lookup(N('OCGs'), PDFArray))).toContain(String(nested));
    expect(isOff(defaultConfig(out), nested)).toBe(true);
  });

  it('reaches a group named by an XObject own OC entry', async () => {
    const doc = await blank();
    const ctx = doc.context;
    const page = doc.addPage([300, 700]);
    const ocg = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of('Whole form') }));
    const form = ctx.register(
      ctx.stream('0 0 10 10 re f', {
        Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 20, 20], OC: ocg,
      }),
    );
    page.node.set(N('Resources'), ctx.obj({ XObject: { Form: form } }));
    page.node.set(N('Contents'), ctx.register(ctx.stream('/Form Do')));
    doc.catalog.set(N('OCProperties'), ctx.obj({ OCGs: [ocg], D: { OFF: [ocg], Order: [ocg] } }));
    const bytes = await doc.save();

    const { out } = await rebuild([{ bytes, indices: [0] }]);
    const outForm = rawStream(
      out,
      out.getPage(0).node.lookup(N('Resources'), PDFDict).lookup(N('XObject'), PDFDict).get(N('Form')),
    );
    const rendered = outForm.dict.get(N('OC')) as PDFRef;
    expect(rendered).toBeInstanceOf(PDFRef);
    expect(refsOf(props(out).lookup(N('OCGs'), PDFArray))).toContain(String(rendered));
    expect(isOff(defaultConfig(out), rendered)).toBe(true);
  });

  it('returns the source-to-output identities it used', async () => {
    const source = await layered({ nest: 2 });
    const { out, ownMap } = await rebuild([{ bytes: source.bytes, indices: [0] }]);
    expect(ownMap).toBeDefined();
    const rendered = renderedGroup(out, 0);
    const mapped = [...ownMap!.values()].flat().map(String);
    expect(mapped).toContain(String(rendered));
  });
});

describe('carryOptionalContent — donor visibility is not the owner state', () => {
  it('keeps a donor page hidden by its own configuration hidden', async () => {
    const own = await blank();
    own.addPage([300, 700]);
    const ownBytes = await own.save();
    const donor = await layered({ name: 'Donor hidden' });
    const { out } = await rebuild([
      { bytes: ownBytes, indices: [0] },
      { bytes: donor.bytes, indices: [0] },
    ]);
    const rendered = renderedGroup(out, 1);
    expect(refsOf(props(out).lookup(N('OCGs'), PDFArray))).toContain(String(rendered));
    expect(isOff(defaultConfig(out), rendered)).toBe(true);
  });

  it.each([
    ['owner OFF base, donor ON base', 'OFF', 'ON'],
    ['owner ON base, donor OFF base', 'ON', 'OFF'],
    ['both OFF base', 'OFF', 'OFF'],
  ])('composes %s into explicit states under an ON default', async (_label, ownBase, donorBase) => {
    // Table 99: a default configuration's BaseState shall be ON, so each
    // source's effective state has to become an explicit list entry.
    const a = await layered({ name: 'Owner layer', baseState: ownBase, off: false });
    const b = await layered({ name: 'Donor layer', baseState: donorBase, off: false });
    const { out } = await rebuild([
      { bytes: a.bytes, indices: [0] },
      { bytes: b.bytes, indices: [0] },
    ]);
    const config = defaultConfig(out);
    expect(config.lookup(N('BaseState'), PDFName).asString()).toBe('/ON');
    const ownRendered = renderedGroup(out, 0);
    const donorRendered = renderedGroup(out, 1);
    expect(isOff(config, ownRendered)).toBe(ownBase === 'OFF');
    expect(isOff(config, donorRendered)).toBe(donorBase === 'OFF');
  });

  it('keeps a group the source explicitly turned ON visible', async () => {
    const a = await layered({ name: 'Visible', baseState: 'OFF', off: false, configs: [] });
    const doc = await load(a.bytes);
    const ocg = doc.catalog
      .lookup(N('OCProperties'), PDFDict)
      .lookup(N('OCGs'), PDFArray)
      .get(0) as PDFRef;
    doc.catalog.lookup(N('OCProperties'), PDFDict).lookup(N('D'), PDFDict).set(N('ON'), doc.context.obj([ocg]));
    const bytes = await doc.save();
    const { out } = await rebuild([{ bytes, indices: [0] }]);
    expect(isOff(defaultConfig(out), renderedGroup(out, 0))).toBe(false);
  });

  it('carries the own document configuration when it keeps no page', async () => {
    const own = await layered({ name: 'Owner only' });
    const donor = await layered({ name: 'Donor layer' });
    const out = await rebuildOwnEmpty(own.bytes, { bytes: donor.bytes, indices: [0] });
    const names = props(out)
      .lookup(N('OCGs'), PDFArray)
      .asArray()
      .map((ref) => out.context.lookup(ref, PDFDict).lookup(N('Name'), PDFString).decodeText())
      .sort();
    // The owner's layer list survives even with none of its pages retained.
    expect(names).toEqual(['Donor layer', 'Owner only']);
    expect(isOff(defaultConfig(out), renderedGroup(out, 0))).toBe(true);
  });

  it('keeps the same group name in two sources as two distinct groups', async () => {
    const a = await layered({ name: 'Layer 1', baseState: 'ON', off: true });
    const b = await layered({ name: 'Layer 1', baseState: 'ON', off: false });
    const { out } = await rebuild([
      { bytes: a.bytes, indices: [0] },
      { bytes: b.bytes, indices: [0] },
    ]);
    const first = renderedGroup(out, 0);
    const second = renderedGroup(out, 1);
    expect(String(first)).not.toBe(String(second));
    // Identical names, opposite states: matching by name would merge them.
    expect(isOff(defaultConfig(out), first)).toBe(true);
    expect(isOff(defaultConfig(out), second)).toBe(false);
  });
});

describe('carryOptionalContent — alternates and presentation', () => {
  it('keeps an alternate configuration and its exact mapped group', async () => {
    const source = await layered({
      configs: [{ name: 'Print plate', baseState: 'OFF', on: true, intent: 'All', locked: true }],
    });
    const { out } = await rebuild([{ bytes: source.bytes, indices: [0] }]);
    const configs = props(out).lookup(N('Configs'), PDFArray);
    expect(configs.size()).toBe(1);
    const config = configs.lookup(0, PDFDict);
    expect(config.lookup(N('Name'), PDFString).decodeText()).toBe('Print plate');
    expect(config.lookup(N('Intent'))).toBe(N('All'));
    const rendered = renderedGroup(out, 0);
    // Under the alternate the group is on; under the default it is off.
    expect(isOff(config, rendered)).toBe(false);
    expect(isOff(defaultConfig(out), rendered)).toBe(true);
    expect(refsOf(config.lookup(N('Locked'), PDFArray))).toEqual([String(rendered)]);
  });

  it('holds other sources at their default while exposing one alternate', async () => {
    const a = await layered({
      name: 'Owner layer',
      configs: [{ name: 'Owner alternate', baseState: 'OFF', on: true }],
    });
    const b = await layered({ name: 'Donor layer' });
    const { out } = await rebuild([
      { bytes: a.bytes, indices: [0] },
      { bytes: b.bytes, indices: [0] },
    ]);
    const config = props(out).lookup(N('Configs'), PDFArray).lookup(0, PDFDict);
    expect(isOff(config, renderedGroup(out, 0))).toBe(false);
    // The donor's hidden layer stays hidden in the owner's alternate.
    expect(isOff(config, renderedGroup(out, 1))).toBe(true);
  });

  it('produces one alternate per source alternate, never a product', async () => {
    const a = await layered({
      name: 'A',
      configs: [{ name: 'A1' }, { name: 'A2' }],
    });
    const b = await layered({ name: 'B', configs: [{ name: 'B1' }] });
    const { out } = await rebuild([
      { bytes: a.bytes, indices: [0] },
      { bytes: b.bytes, indices: [0] },
    ]);
    const configs = props(out).lookup(N('Configs'), PDFArray);
    expect(configs.size()).toBe(3);
    expect(
      Array.from({ length: 3 }, (_, i) => configs.lookup(i, PDFDict).lookup(N('Name'), PDFString).decodeText()),
    ).toEqual(['A1', 'A2', 'B1']);
  });

  it('accumulates Order hierarchies and keeps raw label bytes', async () => {
    const a = await layered({ name: 'A', orderLabel: PDFHexString.fromText('図面') });
    const b = await layered({ name: 'B', orderLabel: PDFString.of('Plans') });
    const { out } = await rebuild([
      { bytes: a.bytes, indices: [0] },
      { bytes: b.bytes, indices: [0] },
    ]);
    const order = defaultConfig(out).lookup(N('Order'), PDFArray);
    expect(order.size()).toBe(2);
    const first = order.lookup(0, PDFArray);
    const label = first.lookup(0);
    // A UTF-16 label stays a hex string, byte for byte.
    expect(label).toBeInstanceOf(PDFHexString);
    expect((label as PDFHexString).decodeText()).toBe('図面');
    expect(String(first.get(1))).toBe(String(renderedGroup(out, 0)));
    const second = order.lookup(1, PDFArray);
    expect(second.lookup(0, PDFString).decodeText()).toBe('Plans');
    expect(String(second.get(1))).toBe(String(renderedGroup(out, 1)));
  });

  it('retains an absent Order when a single source declared none', async () => {
    const doc = await load((await layered()).bytes);
    doc.catalog.lookup(N('OCProperties'), PDFDict).lookup(N('D'), PDFDict).delete(N('Order'));
    const bytes = await doc.save();
    const { out } = await rebuild([{ bytes, indices: [0] }]);
    // Table 99: the default configuration's Order defaults to empty.
    expect(defaultConfig(out).has(N('Order'))).toBe(false);
  });

  it('accumulates usage applications from both sources, mapped to their groups', async () => {
    const a = await layered({ name: 'A', usage: true, as: true });
    const b = await layered({ name: 'B', usage: true, as: true });
    const { out } = await rebuild([
      { bytes: a.bytes, indices: [0] },
      { bytes: b.bytes, indices: [0] },
    ]);
    const as = defaultConfig(out).lookup(N('AS'), PDFArray);
    // Table 101 permits repeated Event entries so combined documents keep
    // their behaviour; usage processing is never disabled.
    expect(as.size()).toBe(2);
    const targets = Array.from({ length: 2 }, (_, i) =>
      refsOf(as.lookup(i, PDFDict).lookup(N('OCGs'), PDFArray)),
    ).flat();
    expect(targets.sort()).toEqual([String(renderedGroup(out, 0)), String(renderedGroup(out, 1))].sort());
    for (let i = 0; i < 2; i++) {
      expect(as.lookup(i, PDFDict).lookup(N('Event'))).toBe(N('View'));
      expect(as.lookup(i, PDFDict).lookup(N('Category'), PDFArray).get(0)).toBe(N('Zoom'));
    }
  });

  it('carries a complete usage dictionary on the group itself', async () => {
    const source = await layered({ usage: true });
    const { out } = await rebuild([{ bytes: source.bytes, indices: [0] }]);
    const usage = out.context.lookup(renderedGroup(out, 0), PDFDict).lookup(N('Usage'), PDFDict);
    expect(usage.lookup(N('View'), PDFDict).lookup(N('ViewState'))).toBe(N('ON'));
    expect(usage.lookup(N('Print'), PDFDict).lookup(N('PrintState'))).toBe(N('OFF'));
    expect(usage.lookup(N('Zoom'), PDFDict).lookup(N('max'), PDFNumber).asNumber()).toBe(4);
    expect(usage.lookup(N('CreatorInfo'), PDFDict).lookup(N('Subtype'))).toBe(N('Technical'));
  });

  it('carries group Intent and accumulates RBGroups', async () => {
    const a = await layered({ name: 'A', intent: 'Design', rbGroups: true });
    const b = await layered({ name: 'B', rbGroups: true });
    const { out } = await rebuild([
      { bytes: a.bytes, indices: [0] },
      { bytes: b.bytes, indices: [0] },
    ]);
    expect(out.context.lookup(renderedGroup(out, 0), PDFDict).lookup(N('Intent'))).toBe(N('Design'));
    const rb = defaultConfig(out).lookup(N('RBGroups'), PDFArray);
    expect(rb.size()).toBe(2);
    expect(refsOf(rb.lookup(0, PDFArray))).toEqual([String(renderedGroup(out, 0))]);
    expect(refsOf(rb.lookup(1, PDFArray))).toEqual([String(renderedGroup(out, 1))]);
  });

  it.each(['absent', 'null', 'dangling'])('affects no group when the usage scope is %s', async (spelling) => {
    // Table 101: an absent OCGs defaults to an empty array — no groups have
    // their state managed. Manufacturing a scope would invent automatic state
    // changes, and in a combined document would reach another source.
    const doc = await load((await layered({ name: 'A' })).bytes);
    const ctx = doc.context;
    const entry = ctx.obj({ Event: 'Print', Category: [N('Print')] });
    if (spelling === 'null') entry.set(N('OCGs'), PDFNull);
    if (spelling === 'dangling') entry.set(N('OCGs'), PDFRef.of(9999));
    doc.catalog.lookup(N('OCProperties'), PDFDict).lookup(N('D'), PDFDict).set(N('AS'), ctx.obj([entry]));
    const a = await doc.save();
    const b = await layered({ name: 'B' });
    const { out } = await rebuild([
      { bytes: a, indices: [0] },
      { bytes: b.bytes, indices: [0] },
    ]);
    const carried = defaultConfig(out).lookup(N('AS'), PDFArray).lookup(0, PDFDict);
    expect(carried.lookup(N('Event'))).toBe(N('Print'));
    expect(refsOf(carried.lookupMaybe(N('OCGs'), PDFArray))).toEqual([]);
  });

  it('maps only the groups an explicit usage scope names', async () => {
    const a = await layered({ name: 'A', as: true });
    const b = await layered({ name: 'B' });
    const { out } = await rebuild([
      { bytes: a.bytes, indices: [0] },
      { bytes: b.bytes, indices: [0] },
    ]);
    const entry = defaultConfig(out).lookup(N('AS'), PDFArray).lookup(0, PDFDict);
    expect(refsOf(entry.lookup(N('OCGs'), PDFArray))).toEqual([String(renderedGroup(out, 0))]);
  });

  it('keeps an explicitly empty usage application scope empty', async () => {
    const doc = await load((await layered()).bytes);
    const ctx = doc.context;
    doc.catalog
      .lookup(N('OCProperties'), PDFDict)
      .lookup(N('D'), PDFDict)
      .set(N('AS'), ctx.obj([{ Event: 'Print', Category: [N('Print')], OCGs: [] }]));
    const bytes = await doc.save();
    const { out } = await rebuild([{ bytes, indices: [0] }]);
    // Explicitly empty is a stated scope of no groups, not an absent one.
    expect(
      defaultConfig(out).lookup(N('AS'), PDFArray).lookup(0, PDFDict).lookup(N('OCGs'), PDFArray).size(),
    ).toBe(0);
  });
});

describe('carryOptionalContent — membership dictionaries', () => {
  const withMembership = async (build: (ctx: PDFDocument['context'], ocgs: PDFRef[]) => PDFObject) => {
    const doc = await blank();
    const ctx = doc.context;
    const page = doc.addPage([300, 700]);
    const ocgs = ['One', 'Two'].map((name) =>
      ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of(name) })),
    );
    const membership = ctx.register(build(ctx, ocgs));
    page.node.set(N('Resources'), ctx.obj({ Properties: { Layer: membership } }));
    page.node.set(N('Contents'), ctx.register(ctx.stream('/OC /Layer BDC 0 0 10 10 re f EMC')));
    doc.catalog.set(N('OCProperties'), ctx.obj({ OCGs: ocgs, D: { OFF: [ocgs[0]], Order: ocgs } }));
    return doc.save();
  };

  it('maps a membership dictionary and both its groups', async () => {
    const bytes = await withMembership((ctx, ocgs) =>
      ctx.obj({ Type: 'OCMD', OCGs: ocgs, P: 'AllOn' }),
    );
    const { out } = await rebuild([{ bytes, indices: [0] }]);
    const membership = out.context.lookup(renderedGroup(out, 0), PDFDict);
    expect(membership.lookup(N('Type'))).toBe(N('OCMD'));
    expect(membership.lookup(N('P'))).toBe(N('AllOn'));
    const registry = refsOf(props(out).lookup(N('OCGs'), PDFArray));
    for (const ref of membership.lookup(N('OCGs'), PDFArray).asArray()) {
      expect(registry).toContain(String(ref));
    }
  });

  it('maps a visibility expression, nesting included', async () => {
    const bytes = await withMembership((ctx, ocgs) =>
      ctx.obj({ Type: 'OCMD', VE: [N('Or'), ocgs[0], [N('Not'), ocgs[1]]] }),
    );
    const { out } = await rebuild([{ bytes, indices: [0] }]);
    const ve = out.context.lookup(renderedGroup(out, 0), PDFDict).lookup(N('VE'), PDFArray);
    expect(ve.lookup(0)).toBe(N('Or'));
    const registry = refsOf(props(out).lookup(N('OCGs'), PDFArray));
    expect(registry).toContain(String(ve.get(1)));
    const nested = ve.lookup(2, PDFArray);
    expect(nested.lookup(0)).toBe(N('Not'));
    expect(registry).toContain(String(nested.get(1)));
  });

  it.each([
    ['a policy that is not a defined name', (ctx: PDFDocument['context'], ocgs: PDFRef[]) =>
      ctx.obj({ Type: 'OCMD', OCGs: ocgs, P: 'Sometimes' })],
    ['a visibility expression with an unknown operator', (ctx: PDFDocument['context'], ocgs: PDFRef[]) =>
      ctx.obj({ Type: 'OCMD', VE: [N('Maybe'), ocgs[0]] })],
    ['a Not expression with two operands', (ctx: PDFDocument['context'], ocgs: PDFRef[]) =>
      ctx.obj({ Type: 'OCMD', VE: [N('Not'), ocgs[0], ocgs[1]] })],
    ['an empty visibility expression', (ctx: PDFDocument['context']) =>
      ctx.obj({ Type: 'OCMD', VE: [N('And')] })],
  ])('refuses %s', async (_label, build) => {
    const bytes = await withMembership(build as never);
    await expect(rebuild([{ bytes, indices: [0] }])).rejects.toThrow();
  });

  it('ignores a null member, as the format requires', async () => {
    const bytes = await withMembership((ctx, ocgs) =>
      ctx.obj({ Type: 'OCMD', OCGs: [ocgs[0], PDFNull, PDFRef.of(9999)], P: 'AnyOn' }),
    );
    const { out } = await rebuild([{ bytes, indices: [0] }]);
    // Table 97: null values and references to deleted objects are ignored.
    const membership = out.context.lookup(renderedGroup(out, 0), PDFDict);
    expect(membership.lookup(N('OCGs'), PDFArray).size()).toBeGreaterThanOrEqual(1);
  });
});

describe('carryOptionalContent — removal, absence and extension data', () => {
  it('carries nothing when no source has optional content', async () => {
    const plain = await blank();
    plain.addPage([300, 700]);
    const bytes = await plain.save();
    const { out } = await rebuild([{ bytes, indices: [0] }]);
    expect(out.catalog.get(N('OCProperties'))).toBeUndefined();
  });

  it('keeps a registry-only group rather than deleting the configuration', async () => {
    const source = await layered({ registryOnly: true });
    const { out } = await rebuild([{ bytes: source.bytes, indices: [0] }]);
    const registry = props(out).lookup(N('OCGs'), PDFArray);
    expect(registry.size()).toBe(1);
    const group = out.context.lookup(registry.get(0), PDFDict);
    expect(group.lookup(N('Name'), PDFString).decodeText()).toBe('Hidden content');
    expect(isOff(defaultConfig(out), registry.get(0) as PDFRef)).toBe(true);
  });

  it('keeps the configuration when the page that rendered a group is removed', async () => {
    const source = await layered({ pages: 2 });
    const { out } = await rebuild([{ bytes: source.bytes, indices: [1] }]);
    const rendered = renderedGroup(out, 0);
    expect(refsOf(props(out).lookup(N('OCGs'), PDFArray))).toEqual([String(rendered)]);
    expect(isOff(defaultConfig(out), rendered)).toBe(true);
  });

  it('carries unknown pure-data extension fields on a group', async () => {
    const source = await layered({
      // The fixture sets these with explicit setters, so each value is the
      // PDF object it will actually be written as.
      extra: {
        VendorNote: PDFHexString.fromText('保持'),
        VendorDepth: PDFNumber.of(3),
        VendorFlag: PDFBool.True,
        VendorName: N('Two'),
      },
    });
    const { out } = await rebuild([{ bytes: source.bytes, indices: [0] }]);
    const group = out.context.lookup(renderedGroup(out, 0), PDFDict);
    expect(group.lookup(N('VendorNote'), PDFHexString).decodeText()).toBe('保持');
    expect(group.lookup(N('VendorDepth'), PDFNumber).asNumber()).toBe(3);
    expect(group.lookup(N('VendorFlag'), PDFBool).asBoolean()).toBe(true);
    expect(group.lookup(N('VendorName'))).toBe(N('Two'));
  });

  it('keeps a shared and cyclic extension payload shared and cyclic', async () => {
    const doc = await blank();
    const ctx = doc.context;
    const page = doc.addPage([300, 700]);
    const node = ctx.obj({ Label: PDFString.of('self') });
    const nodeRef = ctx.register(node);
    node.set(N('Self'), nodeRef);
    const ocg = ctx.register(
      ctx.obj({ Type: 'OCG', Name: PDFString.of('Shared'), Left: nodeRef, Right: nodeRef }),
    );
    page.node.set(N('Resources'), ctx.obj({ Properties: { Layer: ocg } }));
    page.node.set(N('Contents'), ctx.register(ctx.stream('/OC /Layer BDC 0 0 10 10 re f EMC')));
    doc.catalog.set(N('OCProperties'), ctx.obj({ OCGs: [ocg], D: { OFF: [ocg], Order: [ocg] } }));
    const bytes = await doc.save();

    const { out } = await rebuild([{ bytes, indices: [0] }]);
    const group = out.context.lookup(renderedGroup(out, 0), PDFDict);
    const left = group.get(N('Left'));
    expect(left).toBeInstanceOf(PDFRef);
    expect(group.get(N('Right'))).toBe(left);
    expect(out.context.lookup(left, PDFDict).get(N('Self'))).toBe(left);
  });

  it.each(['Intent', 'Usage', 'Order', 'AS', 'RBGroups', 'Locked', 'Configs'])(
    'treats a null or dangling %s as absent',
    async (key) => {
      for (const spelling of ['direct', 'indirect', 'dangling'] as const) {
        const doc = await load((await layered()).bytes);
        const ctx = doc.context;
        const properties = doc.catalog.lookup(N('OCProperties'), PDFDict);
        const target = key === 'Configs' ? properties
          : key === 'Intent' || key === 'Usage'
            ? ctx.lookup(properties.lookup(N('OCGs'), PDFArray).get(0), PDFDict)
            : properties.lookup(N('D'), PDFDict);
        const value =
          spelling === 'direct' ? PDFNull : spelling === 'indirect' ? ctx.register(PDFNull) : PDFRef.of(9999);
        target.set(N(key), value);
        const bytes = await doc.save();
        const { out } = await rebuild([{ bytes, indices: [0] }]);
        // Absence behaves the same however it is spelled.
        expect(refsOf(props(out).lookup(N('OCGs'), PDFArray))).toContain(String(renderedGroup(out, 0)));
      }
    },
  );
});

describe('carryOptionalContent — refusals', () => {
  const mutated = async (change: (doc: PDFDocument, properties: PDFDict) => void, options: LayerOptions = {}) => {
    const doc = await load((await layered(options)).bytes);
    change(doc, doc.catalog.lookup(N('OCProperties'), PDFDict));
    return doc.save();
  };

  it.each([
    ['OCProperties that is not a dictionary', (doc: PDFDocument) =>
      doc.catalog.set(N('OCProperties'), doc.context.obj([PDFNumber.of(1)]))],
    ['a missing OCGs registry', (_doc: PDFDocument, p: PDFDict) => p.delete(N('OCGs'))],
    ['an OCGs registry that is not an array', (doc: PDFDocument, p: PDFDict) =>
      p.set(N('OCGs'), doc.context.obj({}))],
    ['a missing default configuration', (_doc: PDFDocument, p: PDFDict) => p.delete(N('D'))],
    ['a default configuration that is not a dictionary', (doc: PDFDocument, p: PDFDict) =>
      p.set(N('D'), doc.context.obj([PDFNumber.of(1)]))],
    ['a Configs entry that is not a dictionary', (doc: PDFDocument, p: PDFDict) =>
      p.set(N('Configs'), doc.context.obj([PDFNumber.of(1)]))],
  ])('refuses %s', async (_label, change) => {
    const bytes = await mutated(change as never);
    await expect(rebuild([{ bytes, indices: [0] }])).rejects.toThrow();
  });

  it('refuses a registry entry that is not a group dictionary', async () => {
    const bytes = await mutated((doc, p) => {
      p.set(N('OCGs'), doc.context.obj([doc.context.register(doc.context.obj({ Type: 'Annot' }))]));
    });
    await expect(rebuild([{ bytes, indices: [0] }])).rejects.toThrow();
  });

  it('refuses a registered group with no Type', async () => {
    const bytes = await mutated((doc, p) => {
      doc.context.lookup(p.lookup(N('OCGs'), PDFArray).get(0), PDFDict).delete(N('Type'));
    });
    await expect(rebuild([{ bytes, indices: [0] }])).rejects.toThrow();
  });

  it.each(['Unchanged', 'Sometimes'])('refuses a default BaseState of %s', async (base) => {
    const bytes = await mutated((doc, p) => {
      p.lookup(N('D'), PDFDict).set(N('BaseState'), N(base));
    });
    await expect(rebuild([{ bytes, indices: [0] }])).rejects.toThrow();
  });

  it('refuses a group listed both ON and OFF', async () => {
    const bytes = await mutated((doc, p) => {
      const ocg = p.lookup(N('OCGs'), PDFArray).get(0)!;
      p.lookup(N('D'), PDFDict).set(N('ON'), doc.context.obj([ocg]));
      p.lookup(N('D'), PDFDict).set(N('OFF'), doc.context.obj([ocg]));
    });
    await expect(rebuild([{ bytes, indices: [0] }])).rejects.toThrow();
  });

  it('refuses a default configuration Intent that is not View', async () => {
    // Table 99: a default configuration's Intent shall be View.
    const bytes = await mutated((_doc, p) => p.lookup(N('D'), PDFDict).set(N('Intent'), N('Design')));
    await expect(rebuild([{ bytes, indices: [0] }])).rejects.toThrow();
  });

  it('refuses a state list naming an unregistered object', async () => {
    const bytes = await mutated((doc, p) => {
      const stranger = doc.context.register(doc.context.obj({ Type: 'OCG', Name: PDFString.of('Stranger') }));
      p.lookup(N('D'), PDFDict).set(N('OFF'), doc.context.obj([stranger]));
    });
    await expect(rebuild([{ bytes, indices: [0] }])).rejects.toThrow();
  });

  it('refuses an Order entry naming an unregistered object', async () => {
    const bytes = await mutated((doc, p) => {
      const stranger = doc.context.register(doc.context.obj({ Type: 'OCG', Name: PDFString.of('Stranger') }));
      p.lookup(N('D'), PDFDict).set(N('Order'), doc.context.obj([stranger]));
    });
    await expect(rebuild([{ bytes, indices: [0] }])).rejects.toThrow();
  });

  it.each([
    ['an Event that is not View, Print or Export', { Event: 'Hover', Category: [N('Zoom')] }],
    ['a missing Event', { Category: [N('Zoom')] }],
    ['a missing Category', { Event: 'View' }],
    ['a Category entry that is not a name', { Event: 'View', Category: [PDFNumber.of(1)] }],
  ])('refuses a usage application with %s', async (_label, entry) => {
    const bytes = await mutated((doc, p) => {
      p.lookup(N('D'), PDFDict).set(N('AS'), doc.context.obj([entry as never]));
    });
    await expect(rebuild([{ bytes, indices: [0] }])).rejects.toThrow();
  });

  it('leaves a disagreed configuration LABEL unstated rather than picking one', async () => {
    const withCreator = async (name: string, creator: string) => {
      const doc = await load((await layered({ name })).bytes);
      doc.catalog
        .lookup(N('OCProperties'), PDFDict)
        .lookup(N('D'), PDFDict)
        .set(N('Creator'), PDFString.of(creator));
      return doc.save();
    };
    const a = await withCreator('A', 'Tool A');
    const b = await withCreator('B', 'Tool B');
    const { out } = await rebuild([{ bytes: a, indices: [0] }, { bytes: b, indices: [0] }]);
    // The composed default is a configuration neither source named, so a
    // caption they disagree on describes nothing. Their actual layer states
    // still compose.
    expect(defaultConfig(out).get(N('Creator'))).toBeUndefined();
    expect(isOff(defaultConfig(out), renderedGroup(out, 0))).toBe(true);
    expect(isOff(defaultConfig(out), renderedGroup(out, 1))).toBe(true);
  });

  it('carries an agreed configuration label', async () => {
    const withCreator = async (name: string) => {
      const doc = await load((await layered({ name })).bytes);
      doc.catalog
        .lookup(N('OCProperties'), PDFDict)
        .lookup(N('D'), PDFDict)
        .set(N('Creator'), PDFString.of('One Tool'));
      return doc.save();
    };
    const { out } = await rebuild([
      { bytes: await withCreator('A'), indices: [0] },
      { bytes: await withCreator('B'), indices: [0] },
    ]);
    expect(defaultConfig(out).lookup(N('Creator'), PDFString).decodeText()).toBe('One Tool');
  });

  it.each([
    ['an explicit VisiblePages against an explicit AllPages', 'VisiblePages', 'AllPages'],
    ['an explicit VisiblePages against a source that omitted it', 'VisiblePages', undefined],
  ])('refuses %s, which is a behavioural difference', async (_label, first, second) => {
    // ListMode decides which groups an interface lists, and its default is
    // AllPages — so omission is a stated behaviour, not silence.
    const withMode = async (name: string, mode: string | undefined) => {
      const doc = await load((await layered({ name })).bytes);
      if (mode) {
        doc.catalog.lookup(N('OCProperties'), PDFDict).lookup(N('D'), PDFDict).set(N('ListMode'), N(mode));
      }
      return doc.save();
    };
    const a = await withMode('A', first);
    const b = await withMode('B', second);
    await expect(rebuild([{ bytes: a, indices: [0] }, { bytes: b, indices: [0] }])).rejects.toThrow();
  });

  it('composes two sources whose effective list mode agrees', async () => {
    const withMode = async (name: string, mode: string | undefined) => {
      const doc = await load((await layered({ name })).bytes);
      if (mode) {
        doc.catalog.lookup(N('OCProperties'), PDFDict).lookup(N('D'), PDFDict).set(N('ListMode'), N(mode));
      }
      return doc.save();
    };
    // Explicit AllPages and an omitted entry mean the same thing.
    const { out } = await rebuild([
      { bytes: await withMode('A', 'AllPages'), indices: [0] },
      { bytes: await withMode('B', undefined), indices: [0] },
    ]);
    expect(defaultConfig(out).lookup(N('ListMode'))).toBe(N('AllPages'));
  });

  it.each([
    ['a Name that is not a text string', 'Name', () => N('NotAString') as PDFObject],
    ['a ListMode that is not a defined name', 'ListMode', () => N('Sometimes') as PDFObject],
    ['a ListMode that is not a name', 'ListMode', () => PDFNumber.of(1) as PDFObject],
  ])('refuses %s', async (_label, key, value) => {
    const doc = await load((await layered()).bytes);
    doc.catalog.lookup(N('OCProperties'), PDFDict).lookup(N('D'), PDFDict).set(N(key), value());
    const bytes = await doc.save();
    await expect(rebuild([{ bytes, indices: [0] }])).rejects.toThrow();
  });

  it('does not let an alternate inherit another source explicit Intent', async () => {
    // All covers every intent, so it changes no other source's group
    // effectiveness and composes faithfully.
    const a = await layered({ name: 'A', configs: [{ name: 'A1', intent: 'All' }] });
    const b = await layered({ name: 'B', configs: [{ name: 'B1' }] });
    const { out } = await rebuild([
      { bytes: a.bytes, indices: [0] },
      { bytes: b.bytes, indices: [0] },
    ]);
    const configs = props(out).lookup(N('Configs'), PDFArray);
    expect(configs.lookup(0, PDFDict).lookup(N('Intent'))).toBe(N('All'));
    // B's alternate stated no Intent, so it has none.
    expect(configs.lookup(1, PDFDict).get(N('Intent'))).toBeUndefined();
  });

  it('refuses an alternate Intent that would change another source visibility', async () => {
    // 8.11.2.3: a group affects visibility only if one of its intents is in
    // the configuration's set. Design excludes B's View-intent group, so
    // applying this alternate would reveal B's hidden content — a change this
    // alternate has no authority to make, and no single intent set states
    // both meanings.
    const a = await layered({ name: 'A', configs: [{ name: 'A1', intent: 'Design' }] });
    const b = await layered({ name: 'B' });
    await expect(
      rebuild([{ bytes: a.bytes, indices: [0] }, { bytes: b.bytes, indices: [0] }]),
    ).rejects.toThrow();
  });

  it('carries a narrowing alternate Intent on a single source', async () => {
    const a = await layered({ name: 'A', configs: [{ name: 'A1', intent: 'Design' }] });
    const { out } = await rebuild([{ bytes: a.bytes, indices: [0] }]);
    // With no other source there is nothing the narrowing could disturb.
    expect(props(out).lookup(N('Configs'), PDFArray).lookup(0, PDFDict).lookup(N('Intent'))).toBe(N('Design'));
  });

  it('inherits the source default Order and RBGroups into an alternate that omits them', async () => {
    const doc = await load((await layered({ rbGroups: true })).bytes);
    const ctx = doc.context;
    const properties = doc.catalog.lookup(N('OCProperties'), PDFDict);
    const entry = ctx.obj({});
    entry.set(N('Name'), PDFString.of('Inherits presentation'));
    properties.set(N('Configs'), ctx.obj([entry]));
    const bytes = await doc.save();
    const { out } = await rebuild([{ bytes, indices: [0] }]);
    // Table 99: in a configuration other than the default, Order and RBGroups
    // default to the values in THAT SOURCE's default configuration.
    const config = props(out).lookup(N('Configs'), PDFArray).lookup(0, PDFDict);
    expect(config.has(N('Order'))).toBe(false);
    expect(config.has(N('RBGroups'))).toBe(false);
    expect(refsOf(defaultConfig(out).lookup(N('Order'), PDFArray))).toEqual([String(renderedGroup(out, 0))]);
    expect(defaultConfig(out).lookup(N('RBGroups'), PDFArray).size()).toBe(1);
  });

  it.each(['Order', 'RBGroups'])('lets an explicit empty %s override inheritance', async (key) => {
    const doc = await load((await layered({ rbGroups: true })).bytes);
    const ctx = doc.context;
    const properties = doc.catalog.lookup(N('OCProperties'), PDFDict);
    const entry = ctx.obj({});
    entry.set(N('Name'), PDFString.of('Overrides presentation'));
    entry.set(N(key), ctx.obj([]));
    properties.set(N('Configs'), ctx.obj([entry]));
    const bytes = await doc.save();
    const { out } = await rebuild([{ bytes, indices: [0] }]);
    const config = props(out).lookup(N('Configs'), PDFArray).lookup(0, PDFDict);
    // An empty array is a statement, so it is written rather than left to
    // inherit the default's value.
    expect(config.lookup(N(key), PDFArray).size()).toBe(0);
    expect(defaultConfig(out).lookup(N(key), PDFArray).size()).toBe(1);
  });

  it('does not inherit the source default Locked into an alternate', async () => {
    const doc = await load((await layered()).bytes);
    const ctx = doc.context;
    const properties = doc.catalog.lookup(N('OCProperties'), PDFDict);
    const ocg = properties.lookup(N('OCGs'), PDFArray).get(0)!;
    properties.lookup(N('D'), PDFDict).set(N('Locked'), ctx.obj([ocg]));
    const entry = ctx.obj({});
    entry.set(N('Name'), PDFString.of('Unlocked'));
    properties.set(N('Configs'), ctx.obj([entry]));
    const bytes = await doc.save();
    const { out } = await rebuild([{ bytes, indices: [0] }]);
    // Table 99: Locked's default is an empty array, with no inheritance.
    const config = props(out).lookup(N('Configs'), PDFArray).lookup(0, PDFDict);
    expect(refsOf(config.lookupMaybe(N('Locked'), PDFArray))).toEqual([]);
    expect(defaultConfig(out).lookup(N('Locked'), PDFArray).size()).toBe(1);
  });

  it('binds a registry-only payload to the one layer shared by copied pages', async () => {
    const doc = await load((await layered()).bytes);
    const ctx = doc.context;
    const properties = doc.catalog.lookup(N('OCProperties'), PDFDict);
    const rendered = properties.lookup(N('OCGs'), PDFArray).get(0)!;
    const orphan = ctx.register(
      ctx.obj({ Type: 'OCG', Name: PDFString.of('Orphan'), Alias: rendered }),
    );
    properties.set(N('OCGs'), ctx.obj([rendered, orphan]));
    const bytes = await doc.save();

    const source = await load(bytes);
    const output = await blank();
    const pairs: { srcIndex: number; outPage: import('pdf-lib').PDFPage }[] = [];
    for (let i = 0; i < 2; i++) {
      const [copied] = await output.copyPages(source, [0]);
      output.addPage(copied);
      pairs.push({ srcIndex: 0, outPage: copied });
    }
    const carried: CarriedSourcePages = { doc: source, pairs };
    const result = carryOptionalContent(output, [carried], carried);
    const registry = result.properties!.lookup(N('OCGs'), PDFArray);
    expect(registry.size()).toBe(2);
    expect(registry.lookup(1, PDFDict).get(N('Alias'))).toEqual(renderedGroup(output, 0));
    expect(renderedGroup(output, 0)).toEqual(renderedGroup(output, 1));
  });

  it('configures the shared group once while covering every copied occurrence', async () => {
    const source = await load((await layered()).bytes);
    const output = await blank();
    const pairs: { srcIndex: number; outPage: import('pdf-lib').PDFPage }[] = [];
    for (let i = 0; i < 2; i++) {
      const [copied] = await output.copyPages(source, [0]);
      output.addPage(copied);
      pairs.push({ srcIndex: 0, outPage: copied });
    }
    const carried: CarriedSourcePages = { doc: source, pairs };
    const carry = carryOptionalContent(output, [carried], carried);
    output.catalog.set(N('OCProperties'), output.context.getObjectRef(carry.properties!) ?? carry.properties!);
    const out = await load(await output.save());
    const first = renderedGroup(out, 0);
    const second = renderedGroup(out, 1);
    expect(String(first)).toBe(String(second));
    expect(refsOf(defaultConfig(out).lookup(N('OFF'), PDFArray)).sort())
      .toEqual([String(first)]);
  });

  it('refuses a non-finite number in a registry-only payload', async () => {
    const doc = await load((await layered({ registryOnly: true })).bytes);
    const ctx = doc.context;
    const group = ctx.lookup(
      doc.catalog.lookup(N('OCProperties'), PDFDict).lookup(N('OCGs'), PDFArray).get(0),
      PDFDict,
    );
    // A number with no legal spelling is refused on the copy path, not only
    // where values are compared.
    group.set(N('VendorNumber'), PDFNumber.of(Number.POSITIVE_INFINITY));
    const bytes = await doc.save();
    await expect(rebuild([{ bytes, indices: [0] }])).rejects.toThrow();
  });

  it('binds an alias to the rebuilt state array, not a copy of the old one', async () => {
    const doc = await load((await layered()).bytes);
    const ctx = doc.context;
    const config = doc.catalog.lookup(N('OCProperties'), PDFDict).lookup(N('D'), PDFDict);
    const off = ctx.register(config.lookup(N('OFF'), PDFArray));
    config.set(N('OFF'), off);
    config.set(N('PrivateOff'), off);
    const bytes = await doc.save();
    const { out } = await rebuild([{ bytes, indices: [0] }]);
    const carried = defaultConfig(out);
    // One object, two roles: the alias reaches the array the rebuild wrote.
    expect(carried.get(N('PrivateOff'))).toBe(carried.get(N('OFF')));
    expect(refsOf(carried.lookup(N('OFF'), PDFArray))).toEqual([String(renderedGroup(out, 0))]);
  });

  it('keeps a live alias to an array the configuration itself leaves unwritten', async () => {
    const doc = await load((await layered({ off: false })).bytes);
    const ctx = doc.context;
    const config = doc.catalog.lookup(N('OCProperties'), PDFDict).lookup(N('D'), PDFDict);
    const empty = ctx.register(ctx.obj([]));
    config.set(N('Locked'), empty);
    config.set(N('PrivateLocked'), empty);
    const bytes = await doc.save();
    const { out } = await rebuild([{ bytes, indices: [0] }]);
    const carried = defaultConfig(out);
    // An empty array with a live alias cannot vanish.
    const alias = carried.get(N('PrivateLocked'));
    expect(alias).toBeInstanceOf(PDFRef);
    expect(out.context.lookup(alias)).toBeInstanceOf(PDFArray);
    expect((out.context.lookup(alias) as PDFArray).size()).toBe(0);
  });

  it('preserves sharing when one source array fills the same role twice', async () => {
    const doc = await load((await layered()).bytes);
    const ctx = doc.context;
    const config = doc.catalog.lookup(N('OCProperties'), PDFDict).lookup(N('D'), PDFDict);
    const off = ctx.register(config.lookup(N('OFF'), PDFArray));
    config.set(N('OFF'), off);
    // Two aliases and the role itself, all one object: compatible.
    config.set(N('AliasOne'), off);
    config.set(N('AliasTwo'), off);
    const bytes = await doc.save();
    const { out } = await rebuild([{ bytes, indices: [0] }]);
    const carried = defaultConfig(out);
    expect(carried.get(N('AliasOne'))).toBe(carried.get(N('OFF')));
    expect(carried.get(N('AliasTwo'))).toBe(carried.get(N('OFF')));
  });

  it('preserves one source array shared by compatible default and alternate roles', async () => {
    const doc = await load((await layered()).bytes);
    const ctx = doc.context;
    const properties = doc.catalog.lookup(N('OCProperties'), PDFDict);
    const config = properties.lookup(N('D'), PDFDict);
    const shared = ctx.register(config.lookup(N('OFF'), PDFArray));
    config.set(N('OFF'), shared);
    const alternate = ctx.obj({});
    alternate.set(N('Name'), PDFString.of('Shares one array'));
    // The same OFF contents mean the same thing in both configurations.
    alternate.set(N('OFF'), shared);
    properties.set(N('Configs'), ctx.obj([alternate]));
    const bytes = await doc.save();
    const { out } = await rebuild([{ bytes, indices: [0] }]);
    const carried = props(out);
    expect(carried.lookup(N('D'), PDFDict).get(N('OFF'))).toEqual(carried.lookup(N('Configs'), PDFArray).lookup(0, PDFDict).get(N('OFF')));
  });

  it('exports the identity of a membership dictionary the pages render', async () => {
    const doc = await blank();
    const ctx = doc.context;
    const page = doc.addPage([300, 700]);
    const group = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of('Member') }));
    const membership = ctx.register(ctx.obj({ Type: 'OCMD', OCGs: [group], P: 'AnyOn' }));
    page.node.set(N('Resources'), ctx.obj({ Properties: { Layer: membership } }));
    page.node.set(N('Contents'), ctx.register(ctx.stream('/OC /Layer BDC 0 0 10 10 re f EMC')));
    doc.catalog.set(N('OCProperties'), ctx.obj({ OCGs: [group], D: { OFF: [group], Order: [group] } }));
    const bytes = await doc.save();

    const source = await load(bytes);
    const sourceMembership = source
      .getPage(0)
      .node.lookup(N('Resources'), PDFDict)
      .lookup(N('Properties'), PDFDict)
      .get(N('Layer')) as PDFRef;
    const output = await blank();
    const [copied] = await output.copyPages(source, [0]);
    output.addPage(copied);
    const carried: CarriedSourcePages = { doc: source, pairs: [{ srcIndex: 0, outPage: copied }] };
    const carry = carryOptionalContent(output, [carried], carried);
    const actual = copied.node
      .lookup(N('Resources'), PDFDict)
      .lookup(N('Properties'), PDFDict)
      .get(N('Layer')) as PDFRef;
    // A caller binding an action or an opaque edge needs the membership
    // dictionary's identity, not just the groups inside it.
    expect(carry.identities.get(source)?.get(sourceMembership.tag)).toEqual([actual]);
  });

  it('reports how many registered groups no kept page renders', async () => {
    const rendered = await layered({ name: 'Rendered' });
    const orphaned = await layered({ name: 'Orphan', registryOnly: true });
    const output = await blank();
    const sources: CarriedSourcePages[] = [];
    for (const bytes of [rendered.bytes, orphaned.bytes]) {
      const doc = await load(bytes);
      const [copied] = await output.copyPages(doc, [0]);
      output.addPage(copied);
      sources.push({ doc, pairs: [{ srcIndex: 0, outPage: copied }] });
    }
    const carry = carryOptionalContent(output, sources, sources[0]);
    expect(carry.registryOnly).toBe(1);
    // And the registry-only group is still in the identity map.
    const orphanDoc = sources[1].doc;
    const orphanTag = (orphanDoc.catalog
      .lookup(N('OCProperties'), PDFDict)
      .lookup(N('OCGs'), PDFArray)
      .get(0) as PDFRef).tag;
    expect(carry.identities.get(orphanDoc)?.get(orphanTag)).toHaveLength(1);
  });

  it.each([
    ['a plain language and replacement-text property list', { Lang: 'x', ActualText: 'y' }],
    ['a property list with an unrelated Type', { Type: 'VendorThing', Note: 'z' }],
  ])('accepts %s beside a real layer', async (_label, fields) => {
    // 14.6.2: /Properties is a generic marked-content property list. Only an
    // entry that says it is a group or a membership dictionary is a layer.
    const doc = await load((await layered()).bytes);
    const ctx = doc.context;
    const entry = ctx.obj({});
    for (const [key, value] of Object.entries(fields)) {
      entry.set(N(key), key === 'Type' ? N(value) : PDFString.of(value));
    }
    doc.getPage(0).node.lookup(N('Resources'), PDFDict).lookup(N('Properties'), PDFDict)
      .set(N('Text'), ctx.register(entry));
    const bytes = await doc.save();
    const { out } = await rebuild([{ bytes, indices: [0] }]);
    // Exactly the one real group, and it is still hidden.
    expect(props(out).lookup(N('OCGs'), PDFArray).size()).toBe(1);
    expect(isOff(defaultConfig(out), renderedGroup(out, 0))).toBe(true);
  });

  it('still refuses a non-layer value on an explicit OC edge', async () => {
    // 8.11.3.3: an /OC entry shall be a group or a membership dictionary.
    const doc = await load((await layered()).bytes);
    const ctx = doc.context;
    const form = ctx.register(
      ctx.stream('0 0 10 10 re f', {
        Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 20, 20],
        OC: { Lang: PDFString.of('en-US') },
      }),
    );
    const resources = doc.getPage(0).node.lookup(N('Resources'), PDFDict);
    resources.set(N('XObject'), ctx.obj({ Form: form }));
    const bytes = await doc.save();
    await expect(rebuild([{ bytes, indices: [0] }])).rejects.toThrow();
  });

  it('resolves the returned root through its own registered reference', async () => {
    const source = await layered();
    const output = await blank();
    const doc = await load(source.bytes);
    const [copied] = await output.copyPages(doc, [0]);
    output.addPage(copied);
    const carried: CarriedSourcePages = { doc, pairs: [{ srcIndex: 0, outPage: copied }] };
    const carry = carryOptionalContent(output, [carried], carried);
    // The root is registered once, so a caller can install it by reference
    // rather than registering a second copy of it.
    const ref = output.context.getObjectRef(carry.properties!);
    expect(ref).toBeInstanceOf(PDFRef);
    expect(output.context.lookup(ref)).toBe(carry.properties);
  });

  it('refuses an extension payload that proves itself an action', async () => {
    const bytes = await mutated((doc, p) => {
      doc.context
        .lookup(p.lookup(N('OCGs'), PDFArray).get(0), PDFDict)
        .set(N('VendorField'), doc.context.obj({ S: 'Launch', F: PDFString.of('no.exe') }));
    }, { registryOnly: true });
    await expect(rebuild([{ bytes, indices: [0] }])).rejects.toThrow();
  });

  it('refuses an extension payload that proves itself a page', async () => {
    const bytes = await mutated((doc, p) => {
      doc.context
        .lookup(p.lookup(N('OCGs'), PDFArray).get(0), PDFDict)
        .set(N('VendorField'), doc.context.obj({ Type: 'Page' }));
    }, { registryOnly: true });
    await expect(rebuild([{ bytes, indices: [0] }])).rejects.toThrow();
  });

  it('does not mistake an extension key spelled S or P for an action or a page', async () => {
    const bytes = await mutated((doc, p) => {
      doc.context
        .lookup(p.lookup(N('OCGs'), PDFArray).get(0), PDFDict)
        .set(N('VendorField'), doc.context.obj({ S: 'VendorRole', P: PDFNumber.of(7), Type: 'VendorThing' }));
    }, { registryOnly: true });
    const { out } = await rebuild([{ bytes, indices: [0] }]);
    const group = out.context.lookup(props(out).lookup(N('OCGs'), PDFArray).get(0), PDFDict);
    const vendor = group.lookup(N('VendorField'), PDFDict);
    expect(vendor.lookup(N('S'))).toBe(N('VendorRole'));
    expect(vendor.lookup(N('P'), PDFNumber).asNumber()).toBe(7);
  });

  it('refuses a resource graph deeper than the traversal bound', async () => {
    // A cutoff is not permission to lose the layer that sits below it.
    const source = await layered({ nest: 80 });
    await expect(rebuild([{ bytes: source.bytes, indices: [0] }])).rejects.toThrow();
  });

  // Building and serializing a registry this wide is itself slow, so the case
  // gets room; the assertion is still that the carrier refuses it.
  it('refuses a registry wider than the work bound', async () => {
    const doc = await blank();
    const ctx = doc.context;
    const page = doc.addPage([300, 700]);
    const groups = Array.from({ length: 120_000 }, (_, i) =>
      ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of(`L${i}`) })),
    );
    page.node.set(N('Resources'), ctx.obj({ Properties: { Layer: groups[0] } }));
    page.node.set(N('Contents'), ctx.register(ctx.stream('/OC /Layer BDC 0 0 1 1 re f EMC')));
    doc.catalog.set(N('OCProperties'), ctx.obj({ OCGs: groups, D: { Order: [] } }));
    const bytes = await doc.save();
    await expect(rebuild([{ bytes, indices: [0] }])).rejects.toThrow();
  }, 120_000);

  it('refuses a registry-only group whose payload exceeds the byte bound', async () => {
    // A group the pages render rides the page copy, so its own bytes are the
    // page copier's work. A registry-only group is copied HERE, and that is
    // the payload this budget answers for.
    const doc = await blank();
    const ctx = doc.context;
    const page = doc.addPage([300, 700]);
    const ocg = ctx.register(
      ctx.obj({
        Type: 'OCG',
        Name: PDFString.of('Huge'),
        VendorBlob: PDFString.of('x'.repeat(65 * 1024 * 1024)),
      }),
    );
    page.node.set(N('Resources'), ctx.obj({}));
    page.node.set(N('Contents'), ctx.register(ctx.stream('0 0 1 1 re f')));
    doc.catalog.set(N('OCProperties'), ctx.obj({ OCGs: [ocg], D: { Order: [ocg] } }));
    const bytes = await doc.save();
    await expect(rebuild([{ bytes, indices: [0] }])).rejects.toThrow();
  }, 120_000);
});

describe('carryOptionalContent — the source is not mutated', () => {
  it('leaves every contributing source byte-identical', async () => {
    const a = await layered({ name: 'A', nest: 2, configs: [{ name: 'A1', on: true }] });
    const b = await layered({ name: 'B', usage: true, as: true });
    const before = [a.bytes.slice(), b.bytes.slice()];
    await rebuild([
      { bytes: a.bytes, indices: [0] },
      { bytes: b.bytes, indices: [0] },
    ]);
    expect(a.bytes).toEqual(before[0]);
    expect(b.bytes).toEqual(before[1]);
  });
});
