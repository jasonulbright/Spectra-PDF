// Namespace-aware edits to a decoded XMP packet. The caller supplies the
// decoded XML and owns stream bytes, encoding and any outer time budget.
//
// Only the fields explicitly supplied are written; everything else in the
// packet — unknown schemas, qualifiers, language alternatives, ordered
// sequences, dates, comments and the xpacket processing instructions — is
// carried through untouched. Anything this module cannot preserve provably
// refuses with the shared unverified-operation message instead of reducing
// the packet to the handful of fields it understands.
import { DOMParser, NAMESPACE, Node, XMLSerializer } from '@xmldom/xmldom';
import type { Attr, Document, Element } from '@xmldom/xmldom';

import { tChrome } from '../i18n';

const RDF_NS = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const PDF_NS = 'http://ns.adobe.com/pdf/1.3/';
const DC_NS = 'http://purl.org/dc/elements/1.1/';
const XMP_META_NS = 'adobe:ns:meta/';

const X_DEFAULT = 'x-default';

// Bounds, not predictions: a packet past any of these is refused rather than
// walked. Real document packets are orders of magnitude smaller.
const MAX_INPUT_CHARS = 2 * 1024 * 1024;
const MAX_NODES = 50_000;
const MAX_DEPTH = 100;

/** Property names registered as aliases of dc:title, from the XMP Toolkit's
 * own RegisterStandardAliases (XMPCore/source/XMPMeta.cpp) with the namespace
 * URIs spelled in public/include/XMP_Const.h. A packet carrying one of these
 * states the same title twice, so they move together and a packet where they
 * already disagree has no single prior title to reconcile. */
const TITLE_ALIASES: { ns: string; localName: string }[] = [
  { ns: 'http://ns.adobe.com/xap/1.0/', localName: 'Title' },
  { ns: PDF_NS, localName: 'Title' },
  { ns: 'http://ns.adobe.com/photoshop/1.0/', localName: 'Title' },
  { ns: 'http://ns.adobe.com/png/1.0/', localName: 'Title' },
];

/** RDF/XML permits at most one of these on a node element. */
const SUBJECT_ATTRS = ['about', 'ID', 'nodeID'];

export interface XmpOverrides {
  producer?: string;
  title?: string;
  keywords?: string;
}

const refuse = (): Error => new Error(tChrome('app.operation.unverified'));

/** Either half of an RDF property's two serialization forms. */
type Slot =
  | { kind: 'attribute'; owner: Element; attr: Attr }
  | { kind: 'element'; element: Element };

/** How a title carrier holds its value. */
type TitleForm =
  | { kind: 'attribute'; owner: Element; attr: Attr }
  | { kind: 'literal'; element: Element }
  | { kind: 'alt'; alt: Element };

/** The packet's single RDF root and the Descriptions of the document, with
 * room to gain the first one if a write needs somewhere to go. */
interface Packet {
  doc: Document;
  rdf: Element;
  descriptions: Element[];
}

/** Rewrite the supplied fields in `xml` and return the packet.
 *
 * Returns `xml` byte for byte when nothing changed — an absent override, or a
 * supplied value the packet already carries. An empty string is a supplied
 * value and sets the field empty; `undefined` leaves the field alone and never
 * removes it. Throws the unverified-operation refusal for a packet this cannot
 * transform provably. */
export function transformXmpXml(xml: string, overrides: XmpOverrides): string {
  if (typeof xml !== 'string' || xml.length === 0 || xml.length > MAX_INPUT_CHARS) throw refuse();

  const doc = parsePacket(xml);
  const rdf = rdfRoot(doc);
  const packet: Packet = { doc, rdf, descriptions: documentDescriptions(rdf) };

  let changed = applySimple(packet, PDF_NS, 'Producer', overrides.producer);
  changed = applySimple(packet, PDF_NS, 'Keywords', overrides.keywords) || changed;
  changed = applyTitle(packet, overrides.title) || changed;

  if (!changed) return xml;
  try {
    return new XMLSerializer().serializeToString(doc, { requireWellFormed: true });
  } catch {
    throw refuse();
  }
}

function parsePacket(xml: string): Document {
  let doc: Document;
  try {
    doc = new DOMParser({
      // Every level refuses. xmldom reports an unresolvable entity reference,
      // an unbound prefix and a malformed tag as warning/error/fatalError, and
      // a throw here stops parsing — so none of them reach the DOM.
      onError: () => {
        throw refuse();
      },
      locator: false,
    }).parseFromString(xml, 'text/xml');
  } catch {
    throw refuse();
  }
  // A DTD means content whose meaning depends on declarations this parser
  // never applies: its entity map is the five predefined XML entities and is
  // not extended from an internal subset, and it resolves nothing externally.
  if (doc.doctype) throw refuse();
  if (!doc.documentElement) throw refuse();
  auditTree(doc);
  return doc;
}

/** One iterative pass for size, depth and node kinds — no recursion, so a
 * deep packet is refused rather than overflowing the stack on the way.
 * Attributes count: they are tree the transform walks and the serializer
 * writes, so an element with thousands of them is not a cheap element. */
function auditTree(doc: Document): void {
  let nodes = 0;
  const stack: { node: Node; depth: number }[] = [{ node: doc, depth: 0 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) throw refuse();
    if (
      node.nodeType === Node.ENTITY_REFERENCE_NODE ||
      node.nodeType === Node.ENTITY_NODE ||
      node.nodeType === Node.DOCUMENT_TYPE_NODE
    ) {
      throw refuse();
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      nodes += (node as Element).attributes.length;
      if (nodes > MAX_NODES) throw refuse();
    }
    for (let child = node.firstChild; child; child = child.nextSibling) {
      stack.push({ node: child, depth: depth + 1 });
    }
  }
}

/** The packet's one rdf:RDF, reached only through an XMP wrapper or as the
 * document element itself. RDF sitting inside some other document is not an
 * XMP packet — the wrapper is what says this RDF describes this document. */
function rdfRoot(doc: Document): Element {
  const root = doc.documentElement!;
  const wrapped =
    root.namespaceURI === XMP_META_NS && (root.localName === 'xmpmeta' || root.localName === 'xapmeta');
  const bare = root.namespaceURI === RDF_NS && root.localName === 'RDF';
  if (!wrapped && !bare) throw refuse();

  const roots = elementsNS(doc, RDF_NS, 'RDF');
  if (roots.length !== 1) throw refuse();
  if (bare ? roots[0] !== root : roots[0].parentNode !== root) throw refuse();
  return roots[0];
}

/** The top-level rdf:Description elements, which are the ones describing the
 * document itself. A Description nested as a struct value is not one of these,
 * so a property of the same name inside one is never mistaken for the
 * document's property. An empty rdf:RDF is valid and yields none. */
function documentDescriptions(rdf: Element): Element[] {
  const descriptions: Element[] = [];
  for (const child of elementChildren(rdf)) {
    // XMP serializes document properties under rdf:Description only. A typed
    // node element here is legal RDF but outside what this can place a
    // property into, so it refuses rather than guessing.
    if (child.namespaceURI !== RDF_NS || child.localName !== 'Description') throw refuse();
    descriptions.push(child);
  }
  const subjects = new Set<string>();
  for (const description of descriptions) {
    const present = SUBJECT_ATTRS.filter((name) => description.getAttributeNS(RDF_NS, name) !== null);
    // Two of them on one Description name two subjects in one place.
    if (present.length > 1) throw refuse();
    // An absent rdf:about is the empty subject, the one rdf:about="" names.
    subjects.add(present.length === 0 ? 'about=' : `${present[0]}=${description.getAttributeNS(RDF_NS, present[0])}`);
  }
  // Two different subjects mean the packet describes more than the one
  // document, and there is no single field to rewrite.
  if (subjects.size > 1) throw refuse();
  return descriptions;
}

/** Where a created property goes. Made on demand, so a packet with no
 * Description gains one only when something is actually written to it. */
function targetDescription(packet: Packet): Element {
  if (packet.descriptions.length > 0) return packet.descriptions[0];
  const description = packet.doc.createElementNS(RDF_NS, qualify(packet.rdf, RDF_NS, 'Description'));
  description.setAttributeNS(RDF_NS, qualify(packet.rdf, RDF_NS, 'about'), '');
  packet.rdf.appendChild(description);
  packet.descriptions.push(description);
  return description;
}

function applySimple(packet: Packet, ns: string, localName: string, value: string | undefined): boolean {
  if (value === undefined) return false;
  const slots = findSlots(packet.descriptions, ns, localName);
  if (slots.length > 1) throw refuse();
  if (slots.length === 0) {
    const owner = targetDescription(packet);
    owner.appendChild(createProperty(packet.doc, owner, ns, localName, value));
    return true;
  }
  return writeSlot(packet.doc, slots[0], value);
}

/** dc:title is a language alternative: the supplied title replaces the
 * x-default alternative and leaves every other language alone. Its registered
 * aliases state the same title and move with it. */
function applyTitle(packet: Packet, value: string | undefined): boolean {
  if (value === undefined) return false;
  const carriers: TitleForm[] = [];
  for (const name of [{ ns: DC_NS, localName: 'title' }, ...TITLE_ALIASES]) {
    const slots = findSlots(packet.descriptions, name.ns, name.localName);
    if (slots.length > 1) throw refuse();
    if (slots.length === 1) carriers.push(titleForm(slots[0]));
  }
  if (carriers.length === 0) {
    createTitle(packet, value);
    return true;
  }
  // Every carrier that already states a title must state the same one.
  const priors = new Set(carriers.map(titleOf).filter((prior): prior is string => prior !== undefined));
  if (priors.size > 1) throw refuse();

  let changed = false;
  for (const carrier of carriers) changed = writeTitle(packet.doc, carrier, value) || changed;
  return changed;
}

function createTitle(packet: Packet, value: string): void {
  const owner = targetDescription(packet);
  const title = createProperty(packet.doc, owner, DC_NS, 'title');
  const alt = packet.doc.createElementNS(RDF_NS, qualify(owner, RDF_NS, 'Alt'));
  alt.appendChild(languageItem(packet.doc, owner, value));
  title.appendChild(alt);
  owner.appendChild(title);
}

/** Which of a title carrier's three shapes this is. The attribute and
 * simple-literal shorthands each hold one unqualified value, which is the
 * default by construction; an rdf:Alt is a real language alternative. */
function titleForm(slot: Slot): TitleForm {
  if (slot.kind === 'attribute') return { kind: 'attribute', owner: slot.owner, attr: slot.attr };
  const element = slot.element;
  const children = elementChildren(element);
  const alt = children.find((child) => child.namespaceURI === RDF_NS && child.localName === 'Alt');
  if (alt) {
    if (children.length > 1) throw refuse();
    if (element.getAttributeNS(RDF_NS, 'resource') !== null) throw refuse();
    if (element.getAttributeNS(RDF_NS, 'parseType') !== null) throw refuse();
    return { kind: 'alt', alt };
  }
  // rdf:Bag and rdf:Seq are unordered and ordered arrays, not language
  // alternatives; rewriting one as if it had a default would change its kind.
  if (children.some((child) => child.namespaceURI === RDF_NS && (child.localName === 'Bag' || child.localName === 'Seq'))) {
    throw refuse();
  }
  return { kind: 'literal', element: valueElement(element) };
}

/** A carrier's effective title, or undefined when it states none. */
function titleOf(form: TitleForm): string | undefined {
  if (form.kind === 'attribute') return form.attr.value;
  if (form.kind === 'literal') return textOf(form.element);
  const items = languageItems(form.alt);
  const target = items.find((item) => item.lang === X_DEFAULT);
  return target ? textOf(target.value) : undefined;
}

function writeTitle(doc: Document, form: TitleForm, value: string): boolean {
  if (form.kind === 'attribute') return writeSlot(doc, { kind: 'attribute', owner: form.owner, attr: form.attr }, value);
  if (form.kind === 'literal') {
    if (textOf(form.element) === value) return false;
    setText(doc, form.element, value);
    return true;
  }
  return writeLanguageAlt(doc, form.alt, value);
}

function writeLanguageAlt(doc: Document, alt: Element, value: string): boolean {
  const items = languageItems(alt);
  const target = items.find((item) => item.lang === X_DEFAULT);
  if (!target) {
    // No default is present. Add one instead of promoting an existing item:
    // which alternative was meant as the default is not recorded anywhere, and
    // relabelling one would change that alternative's language. First, per the
    // XMP Toolkit's SetLocalizedText (XMPCore/source/XMPMeta-GetSet.cpp).
    alt.insertBefore(languageItem(doc, alt, value), items.length > 0 ? items[0].element : null);
    return true;
  }
  // SetLocalizedText also keeps an existing x-default first. Measured against
  // the first ITEM, not the first child, so indentation is not the difference.
  let changed = false;
  if (items[0].element !== target.element) {
    alt.insertBefore(target.element, items[0].element);
    changed = true;
  }
  const prior = textOf(target.value);
  if (prior === value) return changed;
  setText(doc, target.value, value);
  // The x-default alternative duplicates one of the language alternatives, so
  // the ones that spelled the old default exactly move with it. An alternative
  // that said something else keeps saying it.
  for (const item of items) {
    if (item.element !== target.element && textOf(item.value) === prior) setText(doc, item.value, value);
  }
  return true;
}

interface LangItem {
  element: Element;
  value: Element;
  lang: string;
}

/** The alternatives of a language array, each with one identity.
 *
 * The XMP Toolkit's NormalizeLangArray (XMPCore/source/XMPCore_Impl.cpp)
 * refuses an alt-text item with no xml:lang qualifier, and NormalizeLangValue
 * lowercases the tag's ASCII letters before anything compares them — so two
 * spellings of one tag are one identity, and two items sharing an identity
 * make the alternative ambiguous. */
function languageItems(alt: Element): LangItem[] {
  const items: LangItem[] = [];
  const seen = new Set<string>();
  for (const element of elementChildren(alt)) {
    if (element.namespaceURI !== RDF_NS || element.localName !== 'li') throw refuse();
    const declared = element.getAttributeNS(NAMESPACE.XML, 'lang');
    if (declared === null || !/^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$/.test(declared)) throw refuse();
    const lang = asciiLower(declared);
    if (seen.has(lang)) throw refuse();
    seen.add(lang);
    const value = valueElement(element);
    textOf(value); // Prove every alternative is literal before changing any.
    items.push({ element, value, lang });
  }
  return items;
}

/** ASCII-only, matching the toolkit's `+= 0x20`: a locale-aware lowercase
 * would fold characters outside the tag grammar as well. */
const asciiLower = (value: string): string =>
  value.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x20));

/** Both serialization forms, taken only from the document's own Descriptions.
 * Matching is by namespace and local name, so a prefix alias or a default
 * namespace resolves the same and a same-named property in another namespace
 * is left alone. An unprefixed attribute is in no namespace at all, so the
 * attribute form is only ever a prefixed one. */
function findSlots(descriptions: Element[], ns: string, localName: string): Slot[] {
  const slots: Slot[] = [];
  for (const owner of descriptions) {
    const attrs = owner.attributes;
    for (let i = 0, n = attrs.length; i < n; i++) {
      const attr = attrs.item(i);
      if (attr && attr.namespaceURI === ns && attr.localName === localName) {
        slots.push({ kind: 'attribute', owner, attr });
      }
    }
    for (const child of elementChildren(owner)) {
      if (child.namespaceURI === ns && child.localName === localName) {
        slots.push({ kind: 'element', element: child });
      }
    }
  }
  return slots;
}

function writeSlot(doc: Document, slot: Slot, value: string): boolean {
  if (slot.kind === 'attribute') {
    if (slot.attr.value === value) return false;
    // Reuse the attribute's own qualified name so its prefix survives.
    slot.owner.setAttributeNS(slot.attr.namespaceURI, slot.attr.name, value);
    return true;
  }
  const target = valueElement(slot.element);
  if (textOf(target) === value) return false;
  setText(doc, target, value);
  return true;
}

/** Where a property's literal value actually lives. A qualified property
 * keeps its value in rdf:value beside its qualifiers, in either the nested
 * rdf:Description form or the rdf:parseType="Resource" shorthand; the
 * qualifiers are not touched. */
function valueElement(property: Element): Element {
  // A URI-valued property carries its value in the attribute, and the other
  // parse types (Literal, Collection) give the content different meaning.
  if (property.getAttributeNS(RDF_NS, 'resource') !== null) throw refuse();
  if (property.getAttributeNS(RDF_NS, 'nodeID') !== null) throw refuse();
  const datatype = property.getAttributeNS(RDF_NS, 'datatype');
  if (datatype !== null && datatype !== 'http://www.w3.org/2001/XMLSchema#string') throw refuse();
  const parseType = property.getAttributeNS(RDF_NS, 'parseType');
  if (parseType !== null && parseType !== 'Resource') throw refuse();

  const children = elementChildren(property);
  let target: Element;
  if (parseType === 'Resource') target = rdfValue(children);
  else if (children.length === 0) target = property;
  else if (children.length === 1 && children[0].namespaceURI === RDF_NS && children[0].localName === 'Description') {
    target = rdfValue(elementChildren(children[0]));
  } else {
    // A structured or array value where this expects a literal one.
    throw refuse();
  }

  if (target !== property) {
    // A URI-valued rdf:value states its value in that attribute. Writing
    // content into it would leave the property asserting a literal and a
    // resource at once, so the packet refuses instead.
    if (target.getAttributeNS(RDF_NS, 'resource') !== null) throw refuse();
    if (target.getAttributeNS(RDF_NS, 'parseType') !== null) throw refuse();
    // Reuse the same literal rule for qualified values, including datatype
    // and blank-node identity. A nested structured rdf:value is not a string.
    if (valueElement(target) !== target) throw refuse();
  }
  return target;
}

function rdfValue(children: Element[]): Element {
  const found = children.filter((child) => child.namespaceURI === RDF_NS && child.localName === 'value');
  if (found.length !== 1) throw refuse();
  return found[0];
}

/** A literal value's text. Refuses on any other child kind rather than
 * dropping it: a comment or nested element inside the value is content this
 * cannot rewrite without losing it. */
function textOf(element: Element): string {
  let text = '';
  for (let child = element.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === Node.TEXT_NODE || child.nodeType === Node.CDATA_SECTION_NODE) {
      text += child.nodeValue ?? '';
    } else {
      throw refuse();
    }
  }
  return text;
}

function setText(doc: Document, element: Element, value: string): void {
  while (element.firstChild) element.removeChild(element.firstChild);
  if (value !== '') element.appendChild(doc.createTextNode(value));
}

function createProperty(doc: Document, scope: Element, ns: string, localName: string, value?: string): Element {
  const element = doc.createElementNS(ns, qualify(scope, ns, localName));
  if (value !== undefined && value !== '') element.appendChild(doc.createTextNode(value));
  return element;
}

function languageItem(doc: Document, scope: Element, value: string): Element {
  const item = doc.createElementNS(RDF_NS, qualify(scope, RDF_NS, 'li'));
  item.setAttributeNS(NAMESPACE.XML, 'xml:lang', X_DEFAULT);
  if (value !== '') item.appendChild(doc.createTextNode(value));
  return item;
}

/** Spell a new element with the prefix the packet already binds to that
 * namespace, so a created property reads like the ones around it. */
function qualify(scope: Element, ns: string, localName: string): string {
  const prefix = scope.lookupPrefix(ns) ?? DEFAULT_PREFIXES[ns];
  return prefix ? `${prefix}:${localName}` : localName;
}

const DEFAULT_PREFIXES: Record<string, string | undefined> = {
  [RDF_NS]: 'rdf',
  [PDF_NS]: 'pdf',
  [DC_NS]: 'dc',
};

function elementChildren(parent: Element): Element[] {
  const out: Element[] = [];
  for (let child = parent.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === Node.ELEMENT_NODE) out.push(child as Element);
  }
  return out;
}

function elementsNS(doc: Document, ns: string, localName: string): Element[] {
  const list = doc.getElementsByTagNameNS(ns, localName);
  const out: Element[] = [];
  for (let i = 0, n = list.length; i < n; i++) {
    const item = list.item(i);
    if (item) out.push(item);
  }
  return out;
}
