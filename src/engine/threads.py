"""Article threads — /Threads read and write.

An article is an ordered sequence of rectangles ("beads") across pages, and a
reader that follows one walks the boxes in that order rather than the pages'.
The format is small and fully specified:

    catalog  /Threads  [ thread … ]
    thread   << /Type /Thread  /F <first bead>  /I <info dict> >>
    bead     << /Type /Bead  /T <thread>  /N <next>  /V <prev>
                /P <page>  /R [x0 y0 x1 y1] >>
    page     /B [ bead … ]        the beads on that page, in thread order

The beads of one thread form a CIRCULAR doubly-linked list: the last bead's
/N is the first, and the first bead's /V is the last. That circularity is what
"next" means at the end of an article, and it is asserted rather than assumed
by the round-trip test.

`set_threads` is a FULL REPLACE, the `outline.set_outline` contract, for the
same reason: a thread's identity is its position in /Threads, so a per-item
mutation API would be an index convention layered over an object graph with no
stable names. One writer, one shape, and no partial-update class of bug.

Reader support in the wild is thin — the commercial editor defines and follows
articles, most other viewers ignore /Threads entirely. That is a fact about
readers, not about the document: what this module writes is the real
structure, and the panel says plainly which readers will act on it.
"""

from pathlib import Path

import pikepdf
from pikepdf import Array, Dictionary, Name, String

from engine.inplace import is_same_file, staged_write
from engine.pdf_save import save_pdf

MAX_THREADS = 512
MAX_BEADS = 4096

_INFO_KEYS = (("title", "/Title"), ("author", "/Author"), ("subject", "/Subject"), ("keywords", "/Keywords"))


def _page_index_map(pdf) -> dict:
    return {page.obj.objgen: i for i, page in enumerate(pdf.pages)}


def _rect_of(bead) -> list[float] | None:
    try:
        raw = [float(v) for v in bead.get("/R")]
    except (TypeError, ValueError):
        return None
    if len(raw) != 4:
        return None
    return [min(raw[0], raw[2]), min(raw[1], raw[3]), max(raw[0], raw[2]), max(raw[1], raw[3])]


def _info_of(thread) -> dict:
    info = thread.get("/I")
    out = {key: "" for key, _ in _INFO_KEYS}
    if info is None or not isinstance(info, pikepdf.Dictionary):
        return out
    for key, pdf_key in _INFO_KEYS:
        value = info.get(pdf_key)
        if value is None:
            continue
        try:
            out[key] = str(value)
        except Exception:
            continue
    return out


def _beads_of(thread, pages_by_og) -> list[dict]:
    """The thread's beads in order, stopping when the ring closes.

    A malformed chain (a bead pointing into another thread, a /N cycle that
    never returns to the head) terminates on the visited set rather than
    looping — a document is allowed to be broken; the reader of it is not.
    """
    first = thread.get("/F")
    if first is None:
        return []
    beads: list[dict] = []
    visited: set = set()
    node = first
    while node is not None and len(beads) < MAX_BEADS:
        try:
            og = node.objgen
        except Exception:
            break
        if og in visited:
            break
        visited.add(og)
        rect = _rect_of(node)
        page = None
        ref = node.get("/P")
        if ref is not None:
            try:
                page = pages_by_og.get(ref.objgen)
            except Exception:
                page = None
        if rect is not None and page is not None:
            beads.append({"page": page + 1, "rect": rect})
        node = node.get("/N")
    return beads


def list_threads(file: str) -> dict:
    """Every article in the document, with its beads in reading order."""
    with pikepdf.open(file) as pdf:
        raw = pdf.Root.get("/Threads")
        if raw is None or not isinstance(raw, pikepdf.Array):
            return {"threads": [], "count": 0}
        pages_by_og = _page_index_map(pdf)
        threads: list[dict] = []
        for index, thread in enumerate(raw):
            if not isinstance(thread, pikepdf.Dictionary):
                continue
            entry = {"index": len(threads), **_info_of(thread)}
            entry["beads"] = _beads_of(thread, pages_by_og)
            threads.append(entry)
            if len(threads) >= MAX_THREADS:
                break
        return {"threads": threads, "count": len(threads)}


def _clean_threads(specs, page_count: int) -> list[dict]:
    if not isinstance(specs, list):
        raise ValueError("threads must be a list of articles")
    if len(specs) > MAX_THREADS:
        raise ValueError(f"a document may carry at most {MAX_THREADS} articles")
    out: list[dict] = []
    for i, spec in enumerate(specs):
        number = i + 1
        if not isinstance(spec, dict):
            raise ValueError(f"Article {number} is not an article object.")
        beads_in = spec.get("beads") or []
        if not isinstance(beads_in, list) or not beads_in:
            raise ValueError(f"Article {number} has no boxes — an article needs at least one.")
        if len(beads_in) > MAX_BEADS:
            raise ValueError(f"Article {number} has more than {MAX_BEADS} boxes.")
        beads: list[dict] = []
        for j, bead in enumerate(beads_in):
            box = j + 1
            if not isinstance(bead, dict):
                raise ValueError(f"Article {number}, box {box} is not a box object.")
            try:
                page = int(bead.get("page"))
            except (TypeError, ValueError):
                raise ValueError(f"Article {number}, box {box} names no page.") from None
            if not (1 <= page <= page_count):
                raise ValueError(
                    f"Article {number}, box {box} targets page {page} of {page_count}."
                )
            try:
                raw = [float(v) for v in bead.get("rect") or []]
            except (TypeError, ValueError):
                raise ValueError(f"Article {number}, box {box} has no rectangle.") from None
            if len(raw) != 4:
                raise ValueError(f"Article {number}, box {box} has no rectangle.")
            x0, y0 = min(raw[0], raw[2]), min(raw[1], raw[3])
            x1, y1 = max(raw[0], raw[2]), max(raw[1], raw[3])
            if x1 - x0 <= 0 or y1 - y0 <= 0:
                raise ValueError(f"Article {number}, box {box} has no area.")
            beads.append({"page": page, "rect": [x0, y0, x1, y1]})
        info = {}
        for key, _pdf_key in _INFO_KEYS:
            value = spec.get(key)
            if value is None:
                continue
            text = str(value).strip()
            if text:
                info[key] = text
        out.append({"beads": beads, "info": info})
    return out


def set_threads(file: str, output: str, threads) -> dict:
    """Replace the document's articles.

    Every page's /B array is rebuilt from scratch and removed where no bead
    remains, so a replace can never leave a page pointing at a thread that no
    longer exists.
    """
    output_path = Path(output)
    same_file = is_same_file(file, output)
    with pikepdf.open(file) as pdf:
        cleaned = _clean_threads(threads or [], len(pdf.pages))

        for page in pdf.pages:
            if "/B" in page.obj:
                del page.obj["/B"]

        if not cleaned:
            if "/Threads" in pdf.Root:
                del pdf.Root["/Threads"]
            bead_total = 0
        else:
            per_page: dict[int, list] = {}
            thread_objs = []
            bead_total = 0
            for spec in cleaned:
                thread = pdf.make_indirect(Dictionary(Type=Name.Thread))
                bead_objs = []
                for bead in spec["beads"]:
                    obj = pdf.make_indirect(
                        Dictionary(
                            Type=Name.Bead,
                            P=pdf.pages[bead["page"] - 1].obj,
                            R=Array([float(v) for v in bead["rect"]]),
                        )
                    )
                    bead_objs.append(obj)
                    per_page.setdefault(bead["page"], []).append(obj)
                    bead_total += 1
                count = len(bead_objs)
                for k, obj in enumerate(bead_objs):
                    # Circular in both directions: the last bead's next is the
                    # first, which is what "next" means at the end of an
                    # article.
                    obj["/N"] = bead_objs[(k + 1) % count]
                    obj["/V"] = bead_objs[(k - 1) % count]
                    # /T is required on the first bead and optional elsewhere;
                    # writing it on every bead means a reader that lands on any
                    # bead can name its article.
                    obj["/T"] = thread
                thread["/F"] = bead_objs[0]
                if spec["info"]:
                    info = Dictionary()
                    for key, pdf_key in _INFO_KEYS:
                        if key in spec["info"]:
                            info[Name(pdf_key)] = String(spec["info"][key])
                    thread["/I"] = pdf.make_indirect(info)
                thread_objs.append(thread)
            pdf.Root["/Threads"] = pdf.make_indirect(Array(thread_objs))
            for page_no, objs in per_page.items():
                pdf.pages[page_no - 1].obj["/B"] = Array(objs)

        # The Pdf is closed inside the block: the destination cannot be
        # replaced while it is held open.
        if same_file:
            with staged_write(output_path) as staged:
                save_pdf(pdf, staged)
                pdf.close()
        else:
            save_pdf(pdf, output_path)

    return {"output": str(output_path), "count": len(cleaned), "beads": bead_total}
