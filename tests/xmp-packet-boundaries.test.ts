import { describe, expect, it } from 'vitest';
import { DOMParser } from '@xmldom/xmldom';
import { transformXmpXml } from '../src/renderer/lib/xmp-packet';
const rdf = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const wrap = (fields: string, attrs = '') => `<x:xmpmeta xmlns:x="adobe:ns:meta/"><r:RDF xmlns:r="${rdf}"><r:Description r:about="" xmlns:p="http://ns.adobe.com/pdf/1.3/" xmlns:d="http://purl.org/dc/elements/1.1/" ${attrs}>${fields}</r:Description></r:RDF></x:xmpmeta>`;
const title = (items: string) => `<d:title><r:Alt>${items}</r:Alt></d:title>`;
const li = (lang: string, value: string) => `<r:li xml:lang="${lang}">${value}</r:li>`;
const parse = (xml: string) => new DOMParser({ onError: () => { throw new Error('malformed output'); } }).parseFromString(xml, 'text/xml');
describe('independent XML semantic boundaries', () => {
  it('refuses an RDF payload hidden in a foreign non-XMP wrapper', () => {
    const xml = wrap('').replace('<x:xmpmeta xmlns:x="adobe:ns:meta/">', '<foreign>').replace('</x:xmpmeta>', '</foreign>');
    expect(() => transformXmpXml(xml, { producer: 'New' })).toThrow();
  });
  it('refuses mutually exclusive RDF subject declarations even in one description', () => {
    expect(() => transformXmpXml(wrap('', 'r:ID="other"'), { producer: 'New' })).toThrow();
  });
  it('does not turn a URI-valued qualified rdf:value into contradictory literal content', () => {
    expect(() => transformXmpXml(wrap('<p:Producer r:parseType="Resource"><r:value r:resource="https://example.invalid/tool"/><p:Qualifier>keep</p:Qualifier></p:Producer>'), { producer: 'New' })).toThrow();
  });
  it('refuses duplicate language identities case-insensitively', () => {
    expect(() => transformXmpXml(wrap(title(li('x-default', 'Old') + li('en-US', 'One') + li('EN-us', 'Two'))), { title: 'New' })).toThrow();
  });
  it('refuses an unlabelled item in a language alternative', () => {
    expect(() => transformXmpXml(wrap(title('<r:li>Unlabelled</r:li>')), { title: 'New' })).toThrow();
  });
  it('updates the existing X-DEFAULT item without creating a second identity', () => {
    const xml = transformXmpXml(wrap(title(li('X-DEFAULT', 'Old') + li('fr', 'Autre'))), { title: 'New' });
    const list = parse(xml).getElementsByTagNameNS(rdf, 'li');
    expect(list.length).toBe(2); expect(list.item(0)!.textContent).toBe('New'); expect(list.item(1)!.textContent).toBe('Autre');
  });
  it('keeps declared PDF title aliases consistent with the generated title', () => {
    const xml = transformXmpXml(wrap(title(li('x-default', 'Old')) + '<p:Title>Old</p:Title>'), { title: 'New' });
    expect(parse(xml).getElementsByTagNameNS('http://ns.adobe.com/pdf/1.3/', 'Title').item(0)!.textContent).toBe('New');
  });
  it('refuses conflicting title alias values rather than blessing the disagreement', () => {
    expect(() => transformXmpXml(wrap(title(li('x-default', 'Old')) + '<p:Title>Different</p:Title>'), { title: 'New' })).toThrow();
  });
  it('control: literal qualified values retain their qualifiers', () => {
    const xml = transformXmpXml(wrap('<p:Producer r:parseType="Resource"><r:value>Old</r:value><p:Qualifier>keep</p:Qualifier></p:Producer>'), { producer: 'New' });
    const doc = parse(xml); expect(doc.getElementsByTagNameNS(rdf, 'value').item(0)!.textContent).toBe('New'); expect(xml).toContain('keep');
  });
  it('refuses a resource-valued language item instead of adding contradictory text', () => {
    expect(() => transformXmpXml(wrap(title('<r:li xml:lang="x-default" r:resource="https://example.invalid/title"/>')), { title: 'New' })).toThrow();
  });
  it('refuses a non-text RDF datatype before changing a literal', () => {
    expect(() => transformXmpXml(wrap('<p:Producer r:datatype="http://www.w3.org/2001/XMLSchema#integer">12</p:Producer>'), { producer: 'New' })).toThrow();
  });
  it('preserves qualified language values without detaching their qualifiers', () => {
    const xml = transformXmpXml(wrap(title('<r:li xml:lang="x-default" r:parseType="Resource"><r:value>Old</r:value><p:Qualifier>keep</p:Qualifier></r:li>')), { title: 'New' });
    const doc = parse(xml); expect(doc.getElementsByTagNameNS(rdf, 'value').item(0)!.textContent).toBe('New'); expect(xml).toContain('keep');
  });
  it('applies the same literal rule to qualified properties and every language alternative', () => {
    for (const attr of ['r:datatype="http://www.w3.org/2001/XMLSchema#integer"', 'r:nodeID="other"']) {
      expect(() => transformXmpXml(wrap(`<p:Producer r:parseType="Resource"><r:value ${attr}>12</r:value></p:Producer>`), { producer: 'New' })).toThrow();
      expect(() => transformXmpXml(wrap(title(li('x-default', 'Old') + `<r:li xml:lang="fr" ${attr}>12</r:li>`)), { title: 'New' })).toThrow();
    }
    const xml = transformXmpXml(wrap('<p:Producer r:datatype="http://www.w3.org/2001/XMLSchema#string">Old</p:Producer>'), { producer: 'New' });
    expect(parse(xml).getElementsByTagNameNS('http://ns.adobe.com/pdf/1.3/', 'Producer').item(0)!.textContent).toBe('New');
    expect(xml).toContain('XMLSchema#string');
  });
  it('control: an empty valid RDF packet can gain its first identity', () => {
    const xml = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><r:RDF xmlns:r="${rdf}"/></x:xmpmeta>`;
    const result = transformXmpXml(xml, { producer: 'New' });
    expect(parse(result).getElementsByTagNameNS('http://ns.adobe.com/pdf/1.3/', 'Producer').item(0)!.textContent).toBe('New');
    expect(transformXmpXml(xml, {})).toBe(xml);
  });
});
