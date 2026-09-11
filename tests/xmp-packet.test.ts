// transformXmpXml (lib/xmp-packet.ts): rewrite only the supplied fields of a
// decoded XMP packet and carry everything else through. BA-37's rebuild loses
// the packet outright; reconstructing three Info values in its place would
// drop unknown schemas, language alternatives and author sequences, so the
// transform edits the real packet instead.
import { describe, expect, it } from 'vitest';
import { DOMParser, NAMESPACE, XMLSerializer } from '@xmldom/xmldom';

import { transformXmpXml } from '../src/renderer/lib/xmp-packet';

const RDF_NS = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const PDF_NS = 'http://ns.adobe.com/pdf/1.3/';
const DC_NS = 'http://purl.org/dc/elements/1.1/';

/** Read the result back through a parser rather than matching serialized text
 * — the assertion is about values and structure, not spelling. */
const parse = (xml: string) =>
  new DOMParser({
    onError: (level, msg) => {
      throw new Error(`${level}: ${msg}`);
    },
  }).parseFromString(xml, 'text/xml');

const els = (xml: string, ns: string, name: string) => {
  const list = parse(xml).getElementsByTagNameNS(ns, name);
  return Array.from({ length: list.length }, (_, i) => list.item(i)!);
};
const one = (xml: string, ns: string, name: string) => {
  const found = els(xml, ns, name);
  expect(found).toHaveLength(1);
  return found[0];
};
const textAt = (xml: string, ns: string, name: string) => one(xml, ns, name).textContent;

/** The language alternatives of dc:title as lang → value. */
const langs = (xml: string): Record<string, string> => {
  const alt = one(xml, DC_NS, 'title').getElementsByTagNameNS(RDF_NS, 'Alt').item(0)!;
  const items = Array.from({ length: alt.childNodes.length }, (_, i) => alt.childNodes[i]).filter(
    (n) => n.nodeType === 1,
  );
  const out: Record<string, string> = {};
  for (const item of items) {
    const el = item as unknown as import('@xmldom/xmldom').Element;
    out[el.getAttributeNS(NAMESPACE.XML, 'lang') ?? ''] = el.textContent ?? '';
  }
  return out;
};
/** The packet wrapper's byte-order mark, spelled rather than written as an
 * invisible literal in source. */
const PACKET_BOM = '\uFEFF';

/** The packet shape ISO 32000-2 14.3.2 illustrates: the xpacket wrapper, one
 * Description per schema, a language-alternative title, an ordered creator
 * sequence, a custom identifier schema and a comment. */
const RICH = `<?xpacket begin="${PACKET_BOM}" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Probe 1.0">
 <rdf:RDF xmlns:rdf="${RDF_NS}">
  <!-- basic schema -->
  <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/">
   <xmp:CreatorTool>My Word Processor v10.7</xmp:CreatorTool>
   <xmp:MetadataDate>2014-09-24T21:23:03+02:00</xmp:MetadataDate>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:pdf="${PDF_NS}">
   <pdf:Producer>My Word Processor PDF Exporter Module v2.1</pdf:Producer>
   <pdf:Keywords>annual, report</pdf:Keywords>
   <pdf:Trapped>False</pdf:Trapped>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:dc="${DC_NS}">
   <dc:format>application/pdf</dc:format>
   <dc:title>
    <rdf:Alt>
     <rdf:li xml:lang="x-default">Annual report 2014</rdf:li>
     <rdf:li xml:lang="en">Annual report 2014</rdf:li>
     <rdf:li xml:lang="de">Jahresbericht 2014</rdf:li>
    </rdf:Alt>
   </dc:title>
   <dc:creator>
    <rdf:Seq>
     <rdf:li>John Doe</rdf:li>
     <rdf:li>Mary Miller</rdf:li>
    </rdf:Seq>
   </dc:creator>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:m="https://example.invalid/matter/">
   <m:MatterID>Case-2026-143</m:MatterID>
   <m:Custodians>
    <rdf:Bag>
     <rdf:li>Records</rdf:li>
     <rdf:li>Legal</rdf:li>
    </rdf:Bag>
   </m:Custodians>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

/** A minimal packet, with `build` filling the pdf-schema Description. */
const packet = (body: string, attrs = '') =>
  `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="${RDF_NS}">` +
  `<rdf:Description rdf:about="" xmlns:pdf="${PDF_NS}" xmlns:dc="${DC_NS}"${attrs}>${body}` +
  `</rdf:Description></rdf:RDF></x:xmpmeta>`;

describe('transformXmpXml — faithful rich packet', () => {
  it('changes only the supplied fields and carries the rest of the packet', () => {
    const out = transformXmpXml(RICH, { producer: 'Spectra PDF', keywords: 'PDFX' });
    expect(textAt(out, PDF_NS, 'Producer')).toBe('Spectra PDF');
    expect(textAt(out, PDF_NS, 'Keywords')).toBe('PDFX');
    // Untouched: other schemas, the unrelated pdf property, the sequence order,
    // the custom bag, the dates and the title.
    expect(textAt(out, PDF_NS, 'Trapped')).toBe('False');
    expect(textAt(out, 'http://ns.adobe.com/xap/1.0/', 'CreatorTool')).toBe('My Word Processor v10.7');
    expect(textAt(out, 'http://ns.adobe.com/xap/1.0/', 'MetadataDate')).toBe('2014-09-24T21:23:03+02:00');
    expect(textAt(out, 'https://example.invalid/matter/', 'MatterID')).toBe('Case-2026-143');
    expect(els(out, RDF_NS, 'li').map((li) => li.textContent)).toEqual([
      'Annual report 2014', 'Annual report 2014', 'Jahresbericht 2014',
      'John Doe', 'Mary Miller', 'Records', 'Legal',
    ]);
    expect(textAt(out, DC_NS, 'format')).toBe('application/pdf');
  });

  it('keeps the xpacket processing instructions, the comment and the root attribute', () => {
    const out = transformXmpXml(RICH, { producer: 'Spectra PDF' });
    expect(out).toContain(`<?xpacket begin="${PACKET_BOM}" id="W5M0MpCehiHzreSzNTczkc9d"?>`);
    expect(out).toContain('<?xpacket end="w"?>');
    expect(out).toContain('<!-- basic schema -->');
    expect(parse(out).documentElement!.getAttributeNS('adobe:ns:meta/', 'xmptk')).toBe('Probe 1.0');
  });

  it('keeps every Description and its own namespace declaration', () => {
    const out = transformXmpXml(RICH, { keywords: 'PDFX' });
    expect(els(out, RDF_NS, 'Description')).toHaveLength(4);
    expect(els(out, 'https://example.invalid/matter/', 'Custodians')).toHaveLength(1);
  });
});

describe('transformXmpXml — no-op and absence', () => {
  it('returns the original text when no override is supplied', () => {
    expect(transformXmpXml(RICH, {})).toBe(RICH);
  });

  it('returns the original text when every supplied value is already present', () => {
    expect(
      transformXmpXml(RICH, {
        producer: 'My Word Processor PDF Exporter Module v2.1',
        keywords: 'annual, report',
        title: 'Annual report 2014',
      }),
    ).toBe(RICH);
  });

  it('an absent override never removes the property', () => {
    const out = transformXmpXml(RICH, { producer: 'Spectra PDF' });
    expect(textAt(out, PDF_NS, 'Keywords')).toBe('annual, report');
    expect(langs(out)['x-default']).toBe('Annual report 2014');
  });

  it('an explicitly undefined override is not a supplied value', () => {
    expect(transformXmpXml(RICH, { producer: undefined, title: undefined })).toBe(RICH);
  });

  it('an empty supplied value is a real value and empties the property', () => {
    const out = transformXmpXml(RICH, { producer: '', keywords: '' });
    expect(textAt(out, PDF_NS, 'Producer')).toBe('');
    expect(textAt(out, PDF_NS, 'Keywords')).toBe('');
    expect(els(out, PDF_NS, 'Producer')).toHaveLength(1);
  });

  it('creates a missing property rather than leaving the generated field unstated', () => {
    const out = transformXmpXml(packet('<pdf:Trapped>False</pdf:Trapped>'), { producer: 'Spectra PDF' });
    expect(textAt(out, PDF_NS, 'Producer')).toBe('Spectra PDF');
    expect(textAt(out, PDF_NS, 'Trapped')).toBe('False');
  });

  it('creates a missing dc:title as an x-default language alternative', () => {
    const out = transformXmpXml(packet('<pdf:Producer>Old</pdf:Producer>'), { title: 'Fresh title' });
    expect(langs(out)).toEqual({ 'x-default': 'Fresh title' });
    expect(textAt(out, PDF_NS, 'Producer')).toBe('Old');
  });
});

describe('transformXmpXml — namespaces and forms', () => {
  it('writes the attribute form in place, keeping its prefix', () => {
    const out = transformXmpXml(packet('', ' pdf:Producer="Old writer" pdf:Keywords="k"'), {
      producer: 'Spectra PDF',
    });
    const desc = one(out, RDF_NS, 'Description');
    expect(desc.getAttributeNS(PDF_NS, 'Producer')).toBe('Spectra PDF');
    expect(desc.getAttributeNS(PDF_NS, 'Keywords')).toBe('k');
    expect(els(out, PDF_NS, 'Producer')).toHaveLength(0);
  });

  it('resolves an aliased prefix by namespace, not by spelling', () => {
    const xml =
      `<rdf:RDF xmlns:rdf="${RDF_NS}"><rdf:Description rdf:about="" xmlns:p7="${PDF_NS}">` +
      `<p7:Producer>Old</p7:Producer></rdf:Description></rdf:RDF>`;
    expect(textAt(transformXmpXml(xml, { producer: 'Spectra PDF' }), PDF_NS, 'Producer')).toBe('Spectra PDF');
  });

  it('resolves a property in a default namespace', () => {
    const xml =
      `<rdf:RDF xmlns:rdf="${RDF_NS}"><rdf:Description rdf:about="">` +
      `<Producer xmlns="${PDF_NS}">Old</Producer></rdf:Description></rdf:RDF>`;
    expect(textAt(transformXmpXml(xml, { producer: 'Spectra PDF' }), PDF_NS, 'Producer')).toBe('Spectra PDF');
  });

  it('leaves a same-local-name property in another namespace alone', () => {
    const xml =
      `<rdf:RDF xmlns:rdf="${RDF_NS}"><rdf:Description rdf:about="" xmlns:pdf="${PDF_NS}" ` +
      `xmlns:other="https://example.invalid/other/">` +
      `<pdf:Producer>Old</pdf:Producer><other:Producer>Untouched</other:Producer>` +
      `</rdf:Description></rdf:RDF>`;
    const out = transformXmpXml(xml, { producer: 'Spectra PDF' });
    expect(textAt(out, PDF_NS, 'Producer')).toBe('Spectra PDF');
    expect(textAt(out, 'https://example.invalid/other/', 'Producer')).toBe('Untouched');
  });

  it('does not take an unprefixed attribute as a namespaced property', () => {
    // An unprefixed attribute is in no namespace, whatever xmlns is in scope,
    // so this packet has no pdf:Producer and one is created.
    const out = transformXmpXml(packet('', ' Producer="not the pdf property"'), { producer: 'Spectra PDF' });
    expect(textAt(out, PDF_NS, 'Producer')).toBe('Spectra PDF');
    expect(one(out, RDF_NS, 'Description').getAttribute('Producer')).toBe('not the pdf property');
  });

  it('leaves a nested resource with the same property name alone', () => {
    const xml =
      `<rdf:RDF xmlns:rdf="${RDF_NS}"><rdf:Description rdf:about="" xmlns:pdf="${PDF_NS}" ` +
      `xmlns:m="https://example.invalid/matter/">` +
      `<pdf:Producer>Old</pdf:Producer>` +
      `<m:Origin><rdf:Description><pdf:Producer>Nested history</pdf:Producer></rdf:Description></m:Origin>` +
      `</rdf:Description></rdf:RDF>`;
    const out = transformXmpXml(xml, { producer: 'Spectra PDF' });
    expect(els(out, PDF_NS, 'Producer').map((e) => e.textContent)).toEqual(['Spectra PDF', 'Nested history']);
  });

  it('writes a qualified value through its nested rdf:value, keeping the qualifiers', () => {
    const xml = packet(
      `<pdf:Producer><rdf:Description xmlns:q="https://example.invalid/q/">` +
        `<rdf:value>Old</rdf:value><q:confidence>high</q:confidence></rdf:Description></pdf:Producer>`,
    );
    const out = transformXmpXml(xml, { producer: 'Spectra PDF' });
    expect(textAt(out, RDF_NS, 'value')).toBe('Spectra PDF');
    expect(textAt(out, 'https://example.invalid/q/', 'confidence')).toBe('high');
  });

  it('writes a parseType Resource value through rdf:value', () => {
    const xml = packet(
      `<pdf:Keywords rdf:parseType="Resource" xmlns:q="https://example.invalid/q/">` +
        `<rdf:value>old, words</rdf:value><q:source>import</q:source></pdf:Keywords>`,
    );
    const out = transformXmpXml(xml, { keywords: 'PDFX' });
    expect(textAt(out, RDF_NS, 'value')).toBe('PDFX');
    expect(textAt(out, 'https://example.invalid/q/', 'source')).toBe('import');
  });
});

describe('transformXmpXml — escaping and character data', () => {
  it('round-trips escaped markup in an untouched property', () => {
    const xml = packet(
      `<pdf:Producer>Old</pdf:Producer><pdf:Trapped>a &lt; b &amp;&amp; c &gt; d "q" 'a'</pdf:Trapped>`,
    );
    const out = transformXmpXml(xml, { producer: 'Spectra PDF' });
    expect(textAt(out, PDF_NS, 'Trapped')).toBe(`a < b && c > d "q" 'a'`);
  });

  it('escapes a supplied value that contains markup characters', () => {
    const out = transformXmpXml(packet('<pdf:Producer>Old</pdf:Producer>'), {
      producer: 'Tool <2> & "more" é',
    });
    expect(out).not.toContain('<2>');
    expect(textAt(out, PDF_NS, 'Producer')).toBe('Tool <2> & "more" é');
  });

  it('reads a CDATA value and overwrites it as escaped text', () => {
    const out = transformXmpXml(packet('<pdf:Producer><![CDATA[a < b]]></pdf:Producer>'), {
      producer: 'Spectra PDF',
    });
    expect(textAt(out, PDF_NS, 'Producer')).toBe('Spectra PDF');
  });

  it('treats a CDATA value equal to the override as a no-op, preserving the CDATA', () => {
    const xml = packet('<pdf:Producer><![CDATA[a < b]]></pdf:Producer>');
    expect(transformXmpXml(xml, { producer: 'a < b' })).toBe(xml);
  });

  it('preserves a processing instruction inside the packet body', () => {
    const xml = packet('<pdf:Producer>Old</pdf:Producer><?probe keep="yes"?>');
    expect(transformXmpXml(xml, { producer: 'Spectra PDF' })).toContain('<?probe keep="yes"?>');
  });
});

describe('transformXmpXml — language alternatives', () => {
  const multi = (items: string) =>
    packet(`<dc:title><rdf:Alt>${items}</rdf:Alt></dc:title>`);

  it('changes x-default and the alternatives that spelled the old default', () => {
    const out = transformXmpXml(RICH, { title: 'Rapport 2014' });
    // en duplicated the old default and moves with it; de said something else.
    expect(langs(out)).toEqual({ 'x-default': 'Rapport 2014', en: 'Rapport 2014', de: 'Jahresbericht 2014' });
  });

  it('leaves every alternative alone when none duplicated the default', () => {
    const xml = multi(
      `<rdf:li xml:lang="x-default">Default</rdf:li>` +
        `<rdf:li xml:lang="en">English</rdf:li><rdf:li xml:lang="fr">Français</rdf:li>`,
    );
    expect(langs(transformXmpXml(xml, { title: 'New' }))).toEqual({
      'x-default': 'New', en: 'English', fr: 'Français',
    });
  });

  it('adds an x-default alternative rather than relabelling an existing one', () => {
    const xml = multi(`<rdf:li xml:lang="en">English</rdf:li><rdf:li xml:lang="de">Deutsch</rdf:li>`);
    expect(langs(transformXmpXml(xml, { title: 'New' }))).toEqual({
      'x-default': 'New', en: 'English', de: 'Deutsch',
    });
  });

  it('writes the simple-literal title shorthand in place', () => {
    const out = transformXmpXml(packet('<dc:title>Plain</dc:title>'), { title: 'New' });
    expect(textAt(out, DC_NS, 'title')).toBe('New');
    expect(els(out, RDF_NS, 'Alt')).toHaveLength(0);
  });

  it('writes the attribute title shorthand in place', () => {
    const out = transformXmpXml(packet('', ' dc:title="Plain"'), { title: 'New' });
    expect(one(out, RDF_NS, 'Description').getAttributeNS(DC_NS, 'title')).toBe('New');
  });

  it('does not disturb dc:creator order when the title changes', () => {
    const out = transformXmpXml(RICH, { title: 'Rapport 2014' });
    const seq = one(out, DC_NS, 'creator').getElementsByTagNameNS(RDF_NS, 'Seq').item(0)!;
    expect(seq.getElementsByTagNameNS(RDF_NS, 'li').item(0)!.textContent).toBe('John Doe');
    expect(seq.getElementsByTagNameNS(RDF_NS, 'li').item(1)!.textContent).toBe('Mary Miller');
  });

  it('refuses a title array that is not a language alternative', () => {
    const xml = packet(`<dc:title><rdf:Seq><rdf:li>One</rdf:li></rdf:Seq></dc:title>`);
    expect(() => transformXmpXml(xml, { title: 'New' })).toThrow();
    // Only refuses when the title is actually being written.
    expect(transformXmpXml(xml, { producer: undefined })).toBe(xml);
  });

  it('refuses two x-default alternatives', () => {
    const xml = multi(
      `<rdf:li xml:lang="x-default">One</rdf:li><rdf:li xml:lang="x-default">Two</rdf:li>`,
    );
    expect(() => transformXmpXml(xml, { title: 'New' })).toThrow();
  });

  it('refuses a non-li child of the alternative array', () => {
    const xml = multi(`<rdf:li xml:lang="x-default">One</rdf:li><rdf:Bag/>`);
    expect(() => transformXmpXml(xml, { title: 'New' })).toThrow();
  });
});

describe('transformXmpXml — ambiguity and duplicates', () => {
  it('refuses the same property twice in one Description', () => {
    const xml = packet('<pdf:Producer>One</pdf:Producer><pdf:Producer>Two</pdf:Producer>');
    expect(() => transformXmpXml(xml, { producer: 'Spectra PDF' })).toThrow();
  });

  it('refuses the same property across two Descriptions', () => {
    const xml =
      `<rdf:RDF xmlns:rdf="${RDF_NS}" xmlns:pdf="${PDF_NS}">` +
      `<rdf:Description rdf:about=""><pdf:Producer>One</pdf:Producer></rdf:Description>` +
      `<rdf:Description rdf:about=""><pdf:Producer>Two</pdf:Producer></rdf:Description></rdf:RDF>`;
    expect(() => transformXmpXml(xml, { producer: 'Spectra PDF' })).toThrow();
  });

  it('refuses the attribute and element form of one property together', () => {
    const xml = packet('<pdf:Producer>Element</pdf:Producer>', ' pdf:Producer="Attribute"');
    expect(() => transformXmpXml(xml, { producer: 'Spectra PDF' })).toThrow();
  });

  it('refuses conflicting document subjects', () => {
    const xml =
      `<rdf:RDF xmlns:rdf="${RDF_NS}" xmlns:pdf="${PDF_NS}">` +
      `<rdf:Description rdf:about=""><pdf:Producer>One</pdf:Producer></rdf:Description>` +
      `<rdf:Description rdf:about="https://example.invalid/other"><pdf:Keywords>k</pdf:Keywords>` +
      `</rdf:Description></rdf:RDF>`;
    expect(() => transformXmpXml(xml, { producer: 'Spectra PDF' })).toThrow();
  });

  it('accepts an absent rdf:about beside an empty one as the same subject', () => {
    const xml =
      `<rdf:RDF xmlns:rdf="${RDF_NS}" xmlns:pdf="${PDF_NS}">` +
      `<rdf:Description><pdf:Producer>One</pdf:Producer></rdf:Description>` +
      `<rdf:Description rdf:about=""><pdf:Keywords>k</pdf:Keywords></rdf:Description></rdf:RDF>`;
    expect(textAt(transformXmpXml(xml, { producer: 'Spectra PDF' }), PDF_NS, 'Producer')).toBe('Spectra PDF');
  });

  it('refuses two rdf:RDF roots', () => {
    const xml =
      `<x:xmpmeta xmlns:x="adobe:ns:meta/">` +
      `<rdf:RDF xmlns:rdf="${RDF_NS}" xmlns:pdf="${PDF_NS}"><rdf:Description rdf:about="">` +
      `<pdf:Producer>One</pdf:Producer></rdf:Description></rdf:RDF>` +
      `<rdf:RDF xmlns:rdf="${RDF_NS}"><rdf:Description rdf:about=""/></rdf:RDF></x:xmpmeta>`;
    expect(() => transformXmpXml(xml, { producer: 'Spectra PDF' })).toThrow();
  });
});

describe('transformXmpXml — malformed and unsupported shapes', () => {
  it.each([
    ['no rdf:RDF at all', `<x:xmpmeta xmlns:x="adobe:ns:meta/"><other/></x:xmpmeta>`],
    ['a typed node element instead of a Description', `<rdf:RDF xmlns:rdf="${RDF_NS}"><t:Thing xmlns:t="https://example.invalid/t/" rdf:about=""/></rdf:RDF>`],
    ['a mismatched close tag', `<rdf:RDF xmlns:rdf="${RDF_NS}"><rdf:Description rdf:about=""></rdf:Descriptionx></rdf:RDF>`],
    ['an unclosed element', `<rdf:RDF xmlns:rdf="${RDF_NS}"><rdf:Description rdf:about="">`],
    ['an unbound prefix', `<rdf:RDF xmlns:rdf="${RDF_NS}"><rdf:Description rdf:about=""><nope:Producer>x</nope:Producer></rdf:Description></rdf:RDF>`],
    ['an empty string', ''],
    ['plain text', 'not xml at all'],
  ])('refuses %s', (_label, xml) => {
    expect(() => transformXmpXml(xml, { producer: 'Spectra PDF' })).toThrow();
  });

  it.each([
    ['rdf:resource', `<pdf:Producer rdf:resource="https://example.invalid/p"/>`],
    ['rdf:parseType Literal', `<pdf:Producer rdf:parseType="Literal"><b xmlns="https://example.invalid/h/">Old</b></pdf:Producer>`],
    ['rdf:parseType Collection', `<pdf:Producer rdf:parseType="Collection"><rdf:Description/></pdf:Producer>`],
    ['a structured value where a literal belongs', `<pdf:Producer><rdf:Bag><rdf:li>One</rdf:li></rdf:Bag></pdf:Producer>`],
    ['a qualified value with no rdf:value', `<pdf:Producer><rdf:Description><q:only xmlns:q="https://example.invalid/q/">x</q:only></rdf:Description></pdf:Producer>`],
    ['a comment inside the value being written', `<pdf:Producer>Old<!-- provenance --></pdf:Producer>`],
  ])('refuses %s', (_label, body) => {
    expect(() => transformXmpXml(packet(body), { producer: 'Spectra PDF' })).toThrow();
  });

  it('refuses a doctype even with no entity reference in the content', () => {
    const xml =
      `<!DOCTYPE xmpmeta><rdf:RDF xmlns:rdf="${RDF_NS}" xmlns:pdf="${PDF_NS}">` +
      `<rdf:Description rdf:about=""><pdf:Producer>Old</pdf:Producer></rdf:Description></rdf:RDF>`;
    expect(() => transformXmpXml(xml, { producer: 'Spectra PDF' })).toThrow();
  });

  it.each([
    ['an internal entity declaration used in content',
      `<!DOCTYPE rdf:RDF [<!ENTITY payload "expanded">]>`, '&payload;'],
    ['an external entity declaration used in content',
      `<!DOCTYPE rdf:RDF [<!ENTITY payload SYSTEM "file:///etc/passwd">]>`, '&payload;'],
  ])('refuses %s', (_label, doctype, body) => {
    const xml =
      `${doctype}<rdf:RDF xmlns:rdf="${RDF_NS}" xmlns:pdf="${PDF_NS}">` +
      `<rdf:Description rdf:about=""><pdf:Producer>${body}</pdf:Producer></rdf:Description></rdf:RDF>`;
    expect(() => transformXmpXml(xml, { producer: 'Spectra PDF' })).toThrow();
    // Neither declaration's value appears anywhere: nothing was expanded.
    expect(() => transformXmpXml(xml, {})).toThrow();
  });

  it('refuses an undeclared entity reference', () => {
    const xml = packet('<pdf:Producer>&payload;</pdf:Producer>');
    expect(() => transformXmpXml(xml, { producer: 'Spectra PDF' })).toThrow();
  });

  it('accepts the five predefined entities as ordinary escaped text', () => {
    const out = transformXmpXml(packet('<pdf:Producer>Old</pdf:Producer><pdf:Trapped>&amp;&lt;&gt;&quot;&apos;</pdf:Trapped>'), {
      producer: 'Spectra PDF',
    });
    expect(textAt(out, PDF_NS, 'Trapped')).toBe(`&<>"'`);
  });
});

describe('transformXmpXml — packet wrapper and empty RDF', () => {
  it('refuses an RDF payload inside a wrapper that is not an XMP packet', () => {
    const xml = `<foreign><rdf:RDF xmlns:rdf="${RDF_NS}" xmlns:pdf="${PDF_NS}">` +
      `<rdf:Description rdf:about=""><pdf:Producer>Old</pdf:Producer></rdf:Description></rdf:RDF></foreign>`;
    expect(() => transformXmpXml(xml, { producer: 'Spectra PDF' })).toThrow();
  });

  it('refuses an rdf:RDF that is not the packet root or the wrapper child', () => {
    const xml = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><x:inner><rdf:RDF xmlns:rdf="${RDF_NS}" ` +
      `xmlns:pdf="${PDF_NS}"><rdf:Description rdf:about=""><pdf:Producer>Old</pdf:Producer>` +
      `</rdf:Description></rdf:RDF></x:inner></x:xmpmeta>`;
    expect(() => transformXmpXml(xml, { producer: 'Spectra PDF' })).toThrow();
  });

  it('accepts the legacy xapmeta wrapper', () => {
    const xml = `<x:xapmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="${RDF_NS}" xmlns:pdf="${PDF_NS}">` +
      `<rdf:Description rdf:about=""><pdf:Producer>Old</pdf:Producer></rdf:Description></rdf:RDF></x:xapmeta>`;
    expect(textAt(transformXmpXml(xml, { producer: 'Spectra PDF' }), PDF_NS, 'Producer')).toBe('Spectra PDF');
  });

  it('an empty rdf:RDF gains its first Description only when something is written', () => {
    const xml = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="${RDF_NS}"/></x:xmpmeta>`;
    expect(transformXmpXml(xml, {})).toBe(xml);
    const out = transformXmpXml(xml, { producer: 'Spectra PDF' });
    expect(textAt(out, PDF_NS, 'Producer')).toBe('Spectra PDF');
    expect(one(out, RDF_NS, 'Description').getAttributeNS(RDF_NS, 'about')).toBe('');
  });

  it('an empty rdf:RDF gains one Description for several written fields', () => {
    const xml = `<rdf:RDF xmlns:rdf="${RDF_NS}"/>`;
    const out = transformXmpXml(xml, { producer: 'Spectra PDF', keywords: 'PDFX', title: 'Fresh' });
    expect(els(out, RDF_NS, 'Description')).toHaveLength(1);
    expect(langs(out)).toEqual({ 'x-default': 'Fresh' });
  });
});

describe('transformXmpXml — RDF subject attributes', () => {
  it.each(['rdf:ID="n"', 'rdf:nodeID="n"'])('refuses %s beside rdf:about on one Description', (attr) => {
    expect(() => transformXmpXml(packet('', ` ${attr}`), { producer: 'Spectra PDF' })).toThrow();
  });

  it('accepts a Description whose only subject attribute is rdf:nodeID', () => {
    const xml = `<rdf:RDF xmlns:rdf="${RDF_NS}" xmlns:pdf="${PDF_NS}">` +
      `<rdf:Description rdf:nodeID="n"><pdf:Producer>Old</pdf:Producer></rdf:Description></rdf:RDF>`;
    expect(textAt(transformXmpXml(xml, { producer: 'Spectra PDF' }), PDF_NS, 'Producer')).toBe('Spectra PDF');
  });
});

describe('transformXmpXml — qualified value kinds', () => {
  it('refuses a URI-valued rdf:value rather than making it a literal as well', () => {
    const xml = packet(
      `<pdf:Producer rdf:parseType="Resource"><rdf:value rdf:resource="https://example.invalid/tool"/>` +
        `<pdf:Qualifier>keep</pdf:Qualifier></pdf:Producer>`,
    );
    const before = xml;
    expect(() => transformXmpXml(xml, { producer: 'Spectra PDF' })).toThrow();
    expect(xml).toBe(before);
  });

  it('refuses an rdf:value that carries its own parse type', () => {
    const xml = packet(
      `<pdf:Producer rdf:parseType="Resource"><rdf:value rdf:parseType="Resource"><rdf:value>x</rdf:value>` +
        `</rdf:value></pdf:Producer>`,
    );
    expect(() => transformXmpXml(xml, { producer: 'Spectra PDF' })).toThrow();
  });

  it('keeps every qualifier beside a literal rdf:value it rewrites', () => {
    const xml = packet(
      `<pdf:Producer rdf:parseType="Resource" xmlns:q="https://example.invalid/q/">` +
        `<rdf:value>Old</rdf:value><q:one>a</q:one><q:two>b</q:two></pdf:Producer>`,
    );
    const out = transformXmpXml(xml, { producer: 'Spectra PDF' });
    expect(textAt(out, RDF_NS, 'value')).toBe('Spectra PDF');
    expect(textAt(out, 'https://example.invalid/q/', 'one')).toBe('a');
    expect(textAt(out, 'https://example.invalid/q/', 'two')).toBe('b');
  });
});

describe('transformXmpXml — language identity is case-insensitive', () => {
  const multi = (items: string) => packet(`<dc:title><rdf:Alt>${items}</rdf:Alt></dc:title>`);
  const item = (lang: string, value: string) => `<rdf:li xml:lang="${lang}">${value}</rdf:li>`;

  it('finds and rewrites an X-DEFAULT item without adding a second identity', () => {
    const out = transformXmpXml(multi(item('X-DEFAULT', 'Old') + item('fr', 'Autre')), { title: 'New' });
    expect(els(out, RDF_NS, 'li').map((li) => li.textContent)).toEqual(['New', 'Autre']);
  });

  it.each(['X-Default', 'x-DEFAULT'])('treats %s as the default identity', (spelling) => {
    const out = transformXmpXml(multi(item(spelling, 'Old')), { title: 'New' });
    expect(els(out, RDF_NS, 'li')).toHaveLength(1);
    expect(els(out, RDF_NS, 'li')[0].textContent).toBe('New');
  });

  it.each([
    ['two spellings of one tag', item('x-default', 'Old') + item('en-US', 'One') + item('EN-us', 'Two')],
    ['two x-default spellings', item('x-default', 'One') + item('X-DEFAULT', 'Two')],
  ])('refuses %s as duplicate identities', (_label, items) => {
    expect(() => transformXmpXml(multi(items), { title: 'New' })).toThrow();
  });

  it('refuses an unlabelled alternative', () => {
    expect(() => transformXmpXml(multi('<rdf:li>Unlabelled</rdf:li>'), { title: 'New' })).toThrow();
    expect(() => transformXmpXml(multi(item('x-default', 'Old') + '<rdf:li>Unlabelled</rdf:li>'), { title: 'New' }))
      .toThrow();
  });

  it('refuses an empty xml:lang', () => {
    expect(() => transformXmpXml(multi(item('', 'Old')), { title: 'New' })).toThrow();
  });

  it('moves an existing default to the front, as the toolkit does', () => {
    const out = transformXmpXml(multi(item('fr', 'Autre') + item('x-default', 'Old')), { title: 'New' });
    expect(els(out, RDF_NS, 'li').map((li) => li.textContent)).toEqual(['New', 'Autre']);
  });

  it('propagates the new title case-sensitively by value, not by tag', () => {
    // fr duplicated the old default and moves; FR-ca did not.
    const out = transformXmpXml(
      multi(item('x-default', 'Old') + item('fr', 'Old') + item('FR-ca', 'Different')),
      { title: 'New' },
    );
    expect(langs(out)).toEqual({ 'x-default': 'New', fr: 'New', 'FR-ca': 'Different' });
  });
});

describe('transformXmpXml — registered title aliases', () => {
  const aliased = (alias: string, value: string, titleValue = 'Old') =>
    `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="${RDF_NS}">` +
    `<rdf:Description rdf:about="" xmlns:dc="${DC_NS}" xmlns:pdf="${PDF_NS}" ` +
    `xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" ` +
    `xmlns:png="http://ns.adobe.com/png/1.0/">` +
    `<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${titleValue}</rdf:li></rdf:Alt></dc:title>` +
    `<${alias}>${value}</${alias}></rdf:Description></rdf:RDF></x:xmpmeta>`;

  // Adobe XMP-Toolkit-SDK RegisterStandardAliases registers exactly these four.
  it.each([
    ['pdf:Title', PDF_NS],
    ['xmp:Title', 'http://ns.adobe.com/xap/1.0/'],
    ['photoshop:Title', 'http://ns.adobe.com/photoshop/1.0/'],
    ['png:Title', 'http://ns.adobe.com/png/1.0/'],
  ])('keeps %s consistent with the generated title', (alias, ns) => {
    const out = transformXmpXml(aliased(alias, 'Old'), { title: 'New' });
    expect(textAt(out, ns, 'Title')).toBe('New');
    expect(langs(out)['x-default']).toBe('New');
  });

  it.each([
    ['pdf:Title', PDF_NS],
    ['png:Title', 'http://ns.adobe.com/png/1.0/'],
  ])('refuses when %s already disagrees with dc:title', (alias) => {
    expect(() => transformXmpXml(aliased(alias, 'Different'), { title: 'New' })).toThrow();
  });

  it('leaves an alias alone when no title is supplied', () => {
    const xml = aliased('pdf:Title', 'Different');
    expect(transformXmpXml(xml, { producer: undefined })).toBe(xml);
  });

  it('does not treat a same-named property in an unrelated schema as an alias', () => {
    const xml =
      `<rdf:RDF xmlns:rdf="${RDF_NS}"><rdf:Description rdf:about="" xmlns:dc="${DC_NS}" ` +
      `xmlns:other="https://example.invalid/other/">` +
      `<dc:title><rdf:Alt><rdf:li xml:lang="x-default">Old</rdf:li></rdf:Alt></dc:title>` +
      `<other:Title>Different</other:Title></rdf:Description></rdf:RDF>`;
    const out = transformXmpXml(xml, { title: 'New' });
    expect(langs(out)['x-default']).toBe('New');
    expect(textAt(out, 'https://example.invalid/other/', 'Title')).toBe('Different');
  });

  it('rewrites an alias that is itself a language alternative', () => {
    const xml =
      `<rdf:RDF xmlns:rdf="${RDF_NS}"><rdf:Description rdf:about="" xmlns:dc="${DC_NS}" xmlns:pdf="${PDF_NS}">` +
      `<dc:title><rdf:Alt><rdf:li xml:lang="x-default">Old</rdf:li></rdf:Alt></dc:title>` +
      `<pdf:Title><rdf:Alt><rdf:li xml:lang="x-default">Old</rdf:li>` +
      `<rdf:li xml:lang="de">Alt</rdf:li></rdf:Alt></pdf:Title></rdf:Description></rdf:RDF>`;
    const out = transformXmpXml(xml, { title: 'New' });
    const alias = one(out, PDF_NS, 'Title').getElementsByTagNameNS(RDF_NS, 'li');
    expect([alias.item(0)!.textContent, alias.item(1)!.textContent]).toEqual(['New', 'Alt']);
  });

  it('does not create dc:title when an alias already carries the title', () => {
    const xml =
      `<rdf:RDF xmlns:rdf="${RDF_NS}"><rdf:Description rdf:about="" xmlns:pdf="${PDF_NS}">` +
      `<pdf:Title>Old</pdf:Title></rdf:Description></rdf:RDF>`;
    const out = transformXmpXml(xml, { title: 'New' });
    expect(textAt(out, PDF_NS, 'Title')).toBe('New');
    expect(els(out, DC_NS, 'title')).toHaveLength(0);
  });
});

describe('transformXmpXml — limits', () => {
  it('refuses input past the character bound', () => {
    const body = `<pdf:Producer>${'x'.repeat(2 * 1024 * 1024)}</pdf:Producer>`;
    expect(() => transformXmpXml(packet(body), { producer: 'Spectra PDF' })).toThrow();
  });

  it('refuses a tree past the node bound', () => {
    // One node per self-closing element, so this clears the 50,000 bound.
    const body = `<pdf:Producer>Old</pdf:Producer><pdf:Trapped>${'<rdf:li/>'.repeat(50_100)}</pdf:Trapped>`;
    expect(() => transformXmpXml(packet(body), { producer: 'Spectra PDF' })).toThrow();
  });

  it('refuses a tree past the depth bound', () => {
    const depth = 120;
    const body = `<pdf:Producer>Old</pdf:Producer><pdf:Trapped>${'<rdf:li>'.repeat(depth)}deep${'</rdf:li>'.repeat(depth)}</pdf:Trapped>`;
    expect(() => transformXmpXml(packet(body), { producer: 'Spectra PDF' })).toThrow();
  });

  it('counts attributes toward the node bound', () => {
    // 60,000 attributes on one element, which has only a handful of nodes.
    const attrs = Array.from({ length: 60_000 }, (_, i) => ` a${i}="v"`).join('');
    const body = `<pdf:Producer>Old</pdf:Producer><pdf:Trapped${attrs}>x</pdf:Trapped>`;
    expect(() => transformXmpXml(packet(body), { producer: 'Spectra PDF' })).toThrow();
  });

  it('accepts a packet inside the bounds', () => {
    const body = `<pdf:Producer>Old</pdf:Producer><pdf:Trapped>${'<rdf:li/>'.repeat(200)}</pdf:Trapped>`;
    expect(textAt(transformXmpXml(packet(body), { producer: 'Spectra PDF' }), PDF_NS, 'Producer')).toBe(
      'Spectra PDF',
    );
  });
});

describe('transformXmpXml — output is re-parseable', () => {
  it('produces a packet the transform itself accepts again, unchanged the second time', () => {
    const once = transformXmpXml(RICH, { producer: 'Spectra PDF', title: 'Rapport', keywords: 'PDFX' });
    expect(transformXmpXml(once, { producer: 'Spectra PDF', title: 'Rapport', keywords: 'PDFX' })).toBe(once);
    // And it is well-formed XML by an independent parse and serialize.
    expect(new XMLSerializer().serializeToString(parse(once))).toContain('Spectra PDF');
  });
});
