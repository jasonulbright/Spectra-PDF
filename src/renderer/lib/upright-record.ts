// Which stamps of a page a render draws upright (ISO 32000-2 12.5.3: the
// NoRotate flag), kept per content key and page index.
//
// The workspace index writes the record from the annotations it reads for the
// import. A render looks the record up and reads nothing: a lookup is two map
// reads. Every document over equal bytes shares one record, and other bytes
// have another key, so a record never describes bytes it was not read from.
//
// A page with no record is not known. A render of such a page draws it as
// pdf.js does, unless the page is marked as below; a listener learns when a
// record arrives.
//
// A document that replaces another is told the pages the replaced one had an
// upright stamp on (`carryUprightPages`). The mark carries no stamp: the ids
// of the replaced document name other objects in the new one. A render of a
// marked page with no record reads the annotations of that page from the new
// document once, then renders. Every render draws the document it is given:
// no plan keeps pixels of other bytes (`uprightRenderPlan`).

export type PdfRect = [number, number, number, number];

export interface UprightStamp {
  /** pdf.js's id of the annotation in the document that is rendered. */
  id: string;
  /** /Rect, lower-left corner first. */
  rect: PdfRect;
}

interface ListedAnnotation {
  id?: string;
  subtype?: string;
  rect?: number[] | null;
  noRotate?: boolean;
  hasAppearance?: boolean;
}

function rectOf(entry: ListedAnnotation): PdfRect | null {
  const rect = entry.rect;
  if (!Array.isArray(rect) || rect.length < 4 || !rect.slice(0, 4).every((value) => Number.isFinite(value))) return null;
  return [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])];
}

/** One list for every page that holds no upright stamp. */
export const NO_UPRIGHT_STAMPS: readonly UprightStamp[] = Object.freeze([]);

/** The stamps of `annotations` that stand upright: the NoRotate flag, an
 *  appearance and a rectangle with an area. */
export function uprightStampsAmong(annotations: readonly unknown[]): readonly UprightStamp[] {
  let stamps: UprightStamp[] | null = null;
  for (const entry of annotations as readonly ListedAnnotation[]) {
    if (!entry || entry.subtype !== 'Stamp' || entry.noRotate !== true || !entry.hasAppearance || !entry.id) continue;
    const rect = rectOf(entry);
    if (rect && rect[2] > rect[0] && rect[3] > rect[1]) (stamps ??= []).push({ id: entry.id, rect });
  }
  return stamps ?? NO_UPRIGHT_STAMPS;
}

interface Entry {
  pages: Map<number, readonly UprightStamp[]>;
  /** Cached documents that show these bytes. */
  holders: number;
}

/** Records no cached document holds yet: bytes that are read before they are
 *  placed. The oldest leaves when there are more. */
const UNHELD_LIMIT = 16;

const records = new Map<string, Entry>();
const keyOfDocument = new WeakMap<object, string>();
const ownListings = new WeakMap<object, Map<number, readonly UprightStamp[]>>();
const ownReads = new WeakMap<object, Map<number, Promise<readonly UprightStamp[]>>>();
const carriedPages = new WeakMap<object, ReadonlySet<number>>();
const pendingKeys = new WeakMap<object, Promise<string>>();
const destroyedDocuments = new WeakSet<object>();
const destructionWaiters = new WeakMap<object, Set<() => void>>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

/** Whether two lists name the same stamps at the same rectangles. */
export function sameUprightStamps(a: readonly UprightStamp[], b: readonly UprightStamp[]): boolean {
  return a === b || (a.length === b.length
    && a.every((stamp, index) => stamp.id === b[index].id && stamp.rect.every((value, k) => value === b[index].rect[k])));
}

function dropOldestUnheld(): void {
  let unheld = 0;
  for (const entry of records.values()) if (entry.holders === 0) unheld++;
  for (const [key, entry] of records) {
    if (unheld <= UNHELD_LIMIT) return;
    if (entry.holders > 0) continue;
    records.delete(key);
    unheld--;
  }
}

function write(key: string, pages: ReadonlyArray<readonly UprightStamp[] | undefined>): void {
  let entry = records.get(key);
  if (!entry) {
    entry = { pages: new Map(), holders: 0 };
    records.set(key, entry);
    dropOldestUnheld();
  }
  let changed = false;
  pages.forEach((stamps, pageIndex) => {
    if (!stamps) return;
    const known = entry.pages.get(pageIndex);
    if (known && sameUprightStamps(known, stamps)) return;
    entry.pages.set(pageIndex, stamps.length === 0 ? NO_UPRIGHT_STAMPS : stamps);
    changed = true;
  });
  if (changed) notify();
}

/** Records the upright stamps of the pages of the bytes with content key
 *  `key`, by page index. A page left undefined keeps what it has. A record
 *  equal to the one a page has keeps that list, so a reader that compares
 *  lists sees no change. */
export function recordUprightStamps(
  key: string | Promise<string>,
  pages: ReadonlyArray<readonly UprightStamp[] | undefined>,
): void {
  if (typeof key === 'string') write(key, pages);
  else void key.then((settled) => write(settled, pages), () => {});
}

/** A cached document shows the bytes of `key`: their record stays. */
export function holdUprightRecord(key: string): void {
  const entry = records.get(key);
  if (entry) entry.holders++;
  else records.set(key, { pages: new Map(), holders: 1 });
}

/** A cached document that showed the bytes of `key` is gone. The record
 *  leaves with the last one. */
export function releaseUprightRecord(key: string): void {
  const entry = records.get(key);
  if (!entry) return;
  entry.holders--;
  if (entry.holders <= 0) records.delete(key);
}

/** `pdf` is a document over the bytes of `key`. */
export function bindUprightDocument(pdf: object, key: string): void {
  if (keyOfDocument.get(pdf) === key) return;
  keyOfDocument.set(pdf, key);
  notify();
}

/** The upright stamps of a page of `pdf`, or undefined when no record and no
 *  read of that page is known. Reads nothing and waits for nothing. */
export function uprightStampsOn(pdf: object, pageIndex: number): readonly UprightStamp[] | undefined {
  const key = keyOfDocument.get(pdf);
  const recorded = key === undefined ? undefined : records.get(key)?.pages.get(pageIndex);
  return recorded ?? ownListings.get(pdf)?.get(pageIndex);
}

/** The page indexes of `pdf` its replacement is told: those with an upright
 *  stamp by the record or by a read, and the pages it was told itself and
 *  knows nothing of yet. */
export function uprightPagesOf(pdf: object): number[] {
  const key = keyOfDocument.get(pdf);
  const candidates = new Set<number>(carriedPages.get(pdf));
  for (const pageIndex of (key === undefined ? undefined : records.get(key))?.pages.keys() ?? []) candidates.add(pageIndex);
  for (const pageIndex of ownListings.get(pdf)?.keys() ?? []) candidates.add(pageIndex);
  const pages: number[] = [];
  for (const pageIndex of candidates) {
    const known = uprightStampsOn(pdf, pageIndex);
    if (known === undefined ? uprightCarried(pdf, pageIndex) : known.length > 0) pages.push(pageIndex);
  }
  return pages.sort((x, y) => x - y);
}

/** `pdf` replaces a document that had an upright stamp on `pageIndexes`:
 *  each of those pages may hold one. With no page nothing is kept. */
export function carryUprightPages(pdf: object, pageIndexes: readonly number[]): void {
  if (pageIndexes.length > 0) carriedPages.set(pdf, new Set(pageIndexes));
}

/** Whether the page of the document `pdf` replaced had an upright stamp. */
export function uprightCarried(pdf: object, pageIndex: number): boolean {
  return carriedPages.get(pdf)?.has(pageIndex) === true;
}

/** How a page is rendered. Each plan renders the document it is asked for:
 *  none keeps the pixels a raster holds.
 *  - `plain`: `page.render` in the turn of the call.
 *  - `stamps`: the upright render with the known stamps, in the turn of the
 *    call.
 *  - `read`: the annotations of the page are read from the document once,
 *    then one of the other two. */
export type UprightRenderPlan = 'plain' | 'stamps' | 'read';

/** The plan for a page whose upright stamps are `known` (undefined: no record
 *  and no read), on a page that is `carried` or not. */
export function uprightRenderPlan(known: readonly UprightStamp[] | undefined, carried: boolean): UprightRenderPlan {
  if (known === undefined) return carried ? 'read' : 'plain';
  return known.length > 0 ? 'stamps' : 'plain';
}

/** The content key of `pdf` settles as `key`. A read of a page waits for
 *  it, so a record of the key is used and no annotation is read. */
export function expectUprightKey(pdf: object, key: Promise<string>): void {
  pendingKeys.set(pdf, key);
}

interface Destroyable {
  loadingTask?: { destroyed?: boolean };
  destroyed?: boolean;
}

/** Whether `pdf` is destroyed: by the word of its holder, by its loading
 *  task, or by `page`. A request to a destroyed document may never settle. */
export function uprightDocumentGone(pdf: object, page?: object): boolean {
  return destroyedDocuments.has(pdf)
    || (pdf as Destroyable).loadingTask?.destroyed === true
    || (page as Destroyable | undefined)?.destroyed === true;
}

/** `pdf` is about to be destroyed: every pending read of it settles now with
 *  no upright stamp and keeps nothing. */
export function uprightDocumentDestroyed(pdf: object): void {
  destroyedDocuments.add(pdf);
  carriedPages.delete(pdf);
  const waiters = destructionWaiters.get(pdf);
  if (!waiters) return;
  destructionWaiters.delete(pdf);
  for (const waiter of [...waiters]) waiter();
}

interface ReadablePage {
  pageNumber: number;
  getAnnotations: () => Promise<unknown[]>;
}

function readOwn(pdf: object, page: ReadablePage): Promise<readonly UprightStamp[]> {
  const pageIndex = page.pageNumber - 1;
  const known = uprightStampsOn(pdf, pageIndex);
  if (known) return Promise.resolve(known);
  if (uprightDocumentGone(pdf, page)) return Promise.resolve(NO_UPRIGHT_STAMPS);
  let reads = ownReads.get(pdf);
  if (!reads) ownReads.set(pdf, (reads = new Map()));
  const pending = reads.get(pageIndex);
  if (pending) return pending;
  const keep = (stamps: readonly UprightStamp[]): readonly UprightStamp[] => {
    let listing = ownListings.get(pdf);
    if (!listing) ownListings.set(pdf, (listing = new Map()));
    listing.set(pageIndex, stamps);
    return uprightStampsOn(pdf, pageIndex) ?? stamps;
  };
  let listed: Promise<unknown[]>;
  try {
    listed = page.getAnnotations();
  } catch (error) {
    listed = Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
  const read = new Promise<readonly UprightStamp[]>((resolve) => {
    const gone = (): void => resolve(NO_UPRIGHT_STAMPS);
    let waiters = destructionWaiters.get(pdf);
    if (!waiters) destructionWaiters.set(pdf, (waiters = new Set()));
    waiters.add(gone);
    const settle = (stamps: readonly UprightStamp[]): void => {
      destructionWaiters.get(pdf)?.delete(gone);
      resolve(uprightDocumentGone(pdf, page) ? NO_UPRIGHT_STAMPS : keep(stamps));
    };
    listed.then((annotations) => settle(uprightStampsAmong(annotations)), () => settle(NO_UPRIGHT_STAMPS));
  });
  reads.set(pageIndex, read);
  return read;
}

/** The upright stamps of `page` of `pdf`, read from the page when no record
 *  is known. A document whose content key has not settled waits for it
 *  first: with a record of that key nothing is read. One read per document
 *  object and page: a read that fails is kept as a page with no upright
 *  stamp, so no later call reads again. A read never outlasts its document:
 *  when the document is destroyed the read settles with no upright stamp. */
export function readUprightStamps(pdf: object, page: ReadablePage): Promise<readonly UprightStamp[]> {
  const known = uprightStampsOn(pdf, page.pageNumber - 1);
  if (known) return Promise.resolve(known);
  const key = keyOfDocument.has(pdf) ? undefined : pendingKeys.get(pdf);
  if (!key) return readOwn(pdf, page);
  return key.then(
    (settled) => {
      bindUprightDocument(pdf, settled);
      return readOwn(pdf, page);
    },
    () => readOwn(pdf, page),
  );
}

/** Calls `listener` after a record or a document's key arrives. */
export function subscribeUprightRecord(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether a raster renders again: a render of it started, and the upright
 *  stamps known `now` differ from those the render had (`startedWith`;
 *  undefined for a plain render). An equal list from another source (the
 *  record after a read of the page) asks for nothing. */
export function recordAsksRepaint(
  now: readonly UprightStamp[] | undefined,
  begun: boolean,
  startedWith: readonly UprightStamp[] | undefined,
): boolean {
  return begun && now !== undefined && !sameUprightStamps(now, startedWith ?? NO_UPRIGHT_STAMPS);
}

/** How many records are kept. */
export function uprightRecordCount(): number {
  return records.size;
}
