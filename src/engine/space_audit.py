"""Per-category byte breakdown of a PDF — which part of the file is the file.

The report exists so a choice of optimization setting is informed rather than
guessed, and it is only worth reading if it adds up. So the governing rule is
an accounting identity, not an estimate:

    every byte of the file belongs to exactly one row, and `overhead` is a
    RESIDUAL (file size minus every category), never a sum of parts

which makes `sum(row.bytes for row in categories) == file_size` true by
construction for every input.

Each live object is charged its STORED EXTENT, taken from the cross-reference
table: for a top-level object the bytes from its `N G obj` header through its
`endobj`, parsed out of the file itself; for an object inside an object stream
its pro-rata share of that object stream's extent, by unparsed length. Two
naive alternatives are wrong in opposite directions and neither can be used:
decoded stream lengths exceed the file (an image decodes to many times what it
occupies), and unparsed lengths exceed what a compressed object costs (sixteen
members unparsing to 2,688 bytes inside an object stream that stores 782).

Cross-reference streams, linearization structures and objects the trailer
cannot reach are deliberately left UNCHARGED so their bytes fall into the
residual, where they belong, instead of inflating a content category.

The audit is a pure read and has no refusal of its own: an encrypted, damaged
or non-PDF input raises out of `pikepdf.open`, which is exactly what the
optimizer does with the same file.
"""

import re
from pathlib import Path

import pikepdf

# Report order, and the priority order that resolves an object reachable by two
# paths: the earlier id wins. `overhead` is the residual and claims no object.
CATEGORY_IDS = (
    "images",
    "fonts",
    "content_streams",
    "annotations",
    "forms",
    "embedded_files",
    "bookmarks",
    "named_destinations",
    "tagged_structure",
    "document_structure",
    "metadata",
    "javascript",
    "other_objects",
    "overhead",
)

_PRIORITY = {cid: i for i, cid in enumerate(CATEGORY_IDS)}

# The control that addresses a category, where the product has one. A category
# with no entry reports no knob: naming a control that does not exist is worse
# than admitting the gap.
KNOBS = {
    "images": "compress",
    "content_streams": "compress_streams",
    "annotations": "sanitize_comments",
    "forms": "sanitize_forms",
    "embedded_files": "sanitize_embedded_files",
    "bookmarks": "sanitize_bookmarks",
    "tagged_structure": "sanitize_structure",
    "metadata": "strip_metadata",
    "javascript": "sanitize_javascript",
    "overhead": "rewrite",
}

# Largest objects named per category. The row's `bytes` is always the true
# total; this caps only what the detail lists.
DETAIL_CAP = 50

_HEADER = re.compile(rb"(\d+)[\s]+(\d+)[\s]+obj")
_STARTXREF = re.compile(rb"startxref[\s]+(\d+)")
_XREF_KEYWORD = re.compile(rb"[\r\n](xref)[\r\n]")

# An appearance stream is a form XObject, but it is the annotation's
# appearance rather than page content — and so is every per-state stream
# beneath it, which is why the edge makes the whole SUBTREE sticky rather than
# just its immediate child.
_STICKY_EDGES = frozenset({"/AP"})

# Claims that hold wherever the object hangs, sticky subtree included: a font
# program embedded in an appearance is still a font program.
_STRONG = frozenset({"images", "fonts", "embedded_files"})

# Edges that say nothing about what the object IS — a back-pointer or a
# structural list. The detail row leaves the name blank rather than printing
# the link that happened to be traversed first.
_UNNAMED_EDGES = frozenset(
    {"/P", "/Parent", "/Root", "/Kids", "/Pages", "/First", "/Last", "/Next",
     "/Prev", "/Annots", "/Fields", "/Info", "/Dest"}
)

# Edges that decide the child's category by where it hangs.
_EDGE_CATEGORIES = {
    "/FontFile": "fonts",
    "/FontFile2": "fonts",
    "/FontFile3": "fonts",
    "/ToUnicode": "fonts",
    "/CIDSet": "fonts",
    "/CIDToGIDMap": "fonts",
    "/DescendantFonts": "fonts",
    "/Font": "fonts",
    "/Contents": "content_streams",
    "/CharProcs": "content_streams",
    "/Pattern": "content_streams",
    "/Shading": "content_streams",
    "/Metadata": "metadata",
    "/PieceInfo": "metadata",
    "/Thumb": "metadata",
    "/Info": "metadata",
    "/JavaScript": "javascript",
    "/AA": "javascript",
    "/Dests": "named_destinations",
    "/StructTreeRoot": "tagged_structure",
    "/ParentTree": "tagged_structure",
    "/RoleMap": "tagged_structure",
    "/ClassMap": "tagged_structure",
    "/Outlines": "bookmarks",
    "/AcroForm": "forms",
    "/XFA": "forms",
    "/DR": "forms",
    "/EF": "embedded_files",
    "/Resources": "document_structure",
    "/OCProperties": "document_structure",
    "/PageLabels": "document_structure",
    "/Threads": "document_structure",
}

# What an object says it is. Checked after the keyed edges above, so a font
# program reached through /FontFile2 is a font wherever it hangs, while a
# widget annotation reached through /Annots is a form field rather than a
# comment.
_TYPE_CATEGORIES = {
    "/Font": "fonts",
    "/FontDescriptor": "fonts",
    "/EmbeddedFile": "embedded_files",
    "/Filespec": "embedded_files",
    "/StructTreeRoot": "tagged_structure",
    "/StructElem": "tagged_structure",
    "/Catalog": "document_structure",
    "/Pages": "document_structure",
    "/Page": "document_structure",
    "/Outlines": "bookmarks",
    "/Metadata": "metadata",
}


def _name(value) -> str:
    if value is None:
        return ""
    try:
        return str(value)
    except Exception:
        return ""


def _dict_of(obj):
    if isinstance(obj, pikepdf.Stream):
        return obj.stream_dict
    if isinstance(obj, pikepdf.Dictionary):
        return obj
    return None


def _own_category(obj) -> str | None:
    d = _dict_of(obj)
    if d is None:
        return None
    subtype = _name(d.get("/Subtype"))
    if isinstance(obj, pikepdf.Stream):
        if subtype == "/Image":
            return "images"
        if subtype == "/Form":
            return "content_streams"
    kind = _name(d.get("/Type"))
    if kind == "/Annot":
        return "forms" if subtype == "/Widget" else "annotations"
    if kind == "/XObject" and subtype == "/Image":
        return "images"
    if kind in _TYPE_CATEGORIES:
        return _TYPE_CATEGORIES[kind]
    if "/ShadingType" in d or "/PatternType" in d or "/FunctionType" in d:
        return "content_streams"
    return None


def _edge_category(key: str, child) -> str | None:
    if key in ("/SMask", "/Mask", "/Alternates"):
        d = _dict_of(child)
        if d is not None and _name(d.get("/Subtype")) == "/Image":
            return "images"
        return None
    return _EDGE_CATEGORIES.get(key)


# ── byte extents ──────────────────────────────────────────────────────────


def _extent(data: bytes, offset: int, num: int, obj) -> int:
    """Stored length of one top-level object, `N G obj` through `endobj`.

    Returns 0 when the object cannot be located, which makes it unmeasured
    rather than mis-measured: its bytes stay in the residual.
    """
    if offset <= 0 or offset >= len(data):
        return 0
    m = _HEADER.match(data, offset)
    if not m or int(m.group(1)) != num:
        return 0
    pos = m.end()
    if isinstance(obj, pikepdf.Stream):
        kw = data.find(b"stream", pos)
        if kw < 0:
            return 0
        start = kw + 6
        if data[start:start + 2] == b"\r\n":
            start += 2
        elif data[start:start + 1] in (b"\n", b"\r"):
            start += 1
        end = None
        # /Length is what the writer stored, and stays right under encryption
        # where the decoded bytes are shorter than the ciphertext on disk.
        try:
            declared = obj.stream_dict.get("/Length")
            length = int(declared) if declared is not None else None
        except Exception:
            length = None
        if length is not None and length >= 0:
            tail = data[start + length:start + length + 24]
            if b"endstream" in tail:
                end = start + length + tail.index(b"endstream") + 9
        if end is None:
            idx = data.find(b"endstream", start)
            if idx < 0:
                return 0
            end = idx + 9
        pos = end
    close = data.find(b"endobj", pos)
    if close < 0:
        return 0
    return close + 6 - offset


def _merge(intervals: list) -> list:
    out: list = []
    for start, end in sorted(intervals):
        if end <= start:
            continue
        if out and start <= out[-1][1]:
            out[-1][1] = max(out[-1][1], end)
        else:
            out.append([start, end])
    return out


def _subtract(base: list, cut: list) -> list:
    """base minus cut, both merged interval lists."""
    out: list = []
    cuts = _merge(cut)
    i = 0
    for start, end in base:
        pos = start
        while i < len(cuts) and cuts[i][1] <= pos:
            i += 1
        j = i
        while j < len(cuts) and cuts[j][0] < end:
            if cuts[j][0] > pos:
                out.append([pos, min(cuts[j][0], end)])
            pos = max(pos, cuts[j][1])
            if pos >= end:
                break
            j += 1
        if pos < end:
            out.append([pos, end])
    return _merge(out)


def _length(intervals: list) -> int:
    return sum(end - start for start, end in intervals)


def _clip(intervals: list, limit: int) -> list:
    out = []
    for start, end in intervals:
        if start >= limit:
            continue
        out.append([start, min(end, limit)])
    return _merge(out)


# ── the walk ──────────────────────────────────────────────────────────────


class _Attribution:
    """Which category owns each object, plus where it was first reached.

    An object reachable by two paths takes the earlier category in
    CATEGORY_IDS, so the answer does not depend on traversal order.
    """

    def __init__(self):
        self.category: dict = {}
        self.page: dict = {}
        self.key: dict = {}

    def claim(self, og, category: str, page, key: str) -> bool:
        current = self.category.get(og)
        if current is not None and _PRIORITY[current] <= _PRIORITY[category]:
            return False
        self.category[og] = category
        if page is not None and og not in self.page:
            self.page[og] = page
        if key and og not in self.key:
            self.key[og] = key
        return True


def _attribute(pdf) -> _Attribution:
    found = _Attribution()
    page_of = {}
    for index, page in enumerate(pdf.pages):
        try:
            page_of[page.objgen] = index + 1
        except Exception:
            continue

    # (object, inherited category, page, edge key, inside a sticky subtree)
    stack = [(pdf.trailer, None, None, "", False)]
    guard = 0
    limit = 4_000_000
    while stack and guard < limit:
        guard += 1
        obj, inherited, page, key, sticky = stack.pop()
        try:
            og = obj.objgen
        except Exception:
            og = None
        indirect = og is not None and og != (0, 0)

        claimed = _edge_category(key, obj) or _own_category(obj)
        if sticky and claimed not in _STRONG:
            claimed = None
        category = claimed or inherited
        if category is None and indirect:
            category = "other_objects"

        if indirect:
            page = page_of.get(og, page)
            if not found.claim(og, category, page, "" if key in _UNNAMED_EDGES else key):
                continue

        child_sticky = sticky or key in _STICKY_EDGES
        try:
            if isinstance(obj, (pikepdf.Dictionary, pikepdf.Stream)):
                d = _dict_of(obj)
                for child_key in d.keys():
                    try:
                        stack.append((d[child_key], category, page, str(child_key), child_sticky))
                    except Exception:
                        continue
            elif isinstance(obj, pikepdf.Array):
                for item in obj:
                    stack.append((item, category, page, key, child_sticky))
        except Exception:
            continue
    return found


def _is_xref_stream(obj) -> bool:
    d = _dict_of(obj)
    return d is not None and _name(d.get("/Type")) == "/XRef"


def _is_object_stream(obj) -> bool:
    d = _dict_of(obj)
    return d is not None and _name(d.get("/Type")) == "/ObjStm"


def _linearization_objects(pdf, offsets: dict) -> set:
    """The linearization parameter dictionary and its hint stream.

    Both describe the file's layout rather than its content, so they are left
    uncharged and land in the residual with the cross-reference machinery.
    """
    out: set = set()
    for og, offset in offsets.items():
        try:
            obj = pdf.get_object(og[0], og[1])
        except Exception:
            continue
        d = _dict_of(obj)
        if d is None or "/Linearized" not in d:
            continue
        out.add(og)
        hint = d.get("/H")
        try:
            starts = {int(hint[i]) for i in range(0, len(hint), 2)}
        except Exception:
            starts = set()
        for other, other_offset in offsets.items():
            if other_offset in starts:
                out.add(other)
    return out


def _xref_ranges(data: bytes) -> list:
    """Every cross-reference section, from its first byte to its %%EOF.

    Sections are found both by what `startxref` points at and by the `xref`
    keyword itself: a linearized file ends with `startxref 0`, so its
    first-page table is reachable only through the keyword.
    """
    starts = set()
    for m in _STARTXREF.finditer(data):
        try:
            starts.add(int(m.group(1)))
        except ValueError:
            continue
    for m in _XREF_KEYWORD.finditer(data):
        starts.add(m.start(1))
    out = []
    for start in starts:
        if start <= 0 or start >= len(data):
            continue
        end = data.find(b"%%EOF", start)
        if end < 0:
            continue
        out.append([start, end + 5])
    return _merge(out)


def _revisions(data: bytes) -> tuple:
    """Revision count, and the first byte of the LAST revision.

    A revision ends at its end-of-file marker, so everything before the last
    marker that no live object occupies is content an earlier revision left
    behind.
    """
    ends = []
    pos = 0
    while True:
        idx = data.find(b"%%EOF", pos)
        if idx < 0:
            break
        ends.append(idx + 5)
        pos = idx + 5
    if len(ends) <= 1:
        return max(1, len(ends)), 0
    return len(ends), ends[-2]


def _filter_of(obj) -> str:
    d = _dict_of(obj)
    if d is None:
        return ""
    value = d.get("/Filter")
    if value is None:
        return (_name(d.get("/Subtype")) or _name(d.get("/Type"))).lstrip("/")
    if isinstance(value, pikepdf.Array):
        return ",".join(_name(v).lstrip("/") for v in value)
    return _name(value).lstrip("/")


# ── the audit door ────────────────────────────────────────────────────────


def audit_space_usage(file: str) -> dict:
    """Attribute every byte of `file` to exactly one category.

    Args:
        file: PDF path.

    Returns a report whose category byte totals sum to the file size exactly.
    """
    path = Path(file)
    data = path.read_bytes()
    size = len(data)

    with pikepdf.open(file) as pdf:
        table = pdf.get_xref_table()
        found = _attribute(pdf)

        offsets: dict = {}
        members: dict = {}
        for (num, gen), entry in table.items():
            if entry.type == 1:
                offsets[(num, gen)] = entry.offset
            elif entry.type == 2:
                members.setdefault((entry.obj_stream_number, 0), []).append((num, gen))

        objects: dict = {}
        for og, offset in offsets.items():
            try:
                objects[og] = pdf.get_object(og[0], og[1])
            except Exception:
                objects[og] = None

        extents: dict = {}
        unmeasured = 0
        for og, offset in offsets.items():
            n = _extent(data, offset, og[0], objects.get(og))
            if n <= 0:
                unmeasured += 1
                continue
            extents[og] = n

        linearization = _linearization_objects(pdf, offsets)

        charged: dict = {cid: 0 for cid in CATEGORY_IDS}
        counts: dict = {cid: 0 for cid in CATEGORY_IDS}
        details: dict = {cid: [] for cid in CATEGORY_IDS}
        charged_intervals: list = []
        objstm_intervals: list = []
        layout_intervals: list = []
        unreferenced_intervals: list = []
        unreferenced_objects = 0
        # An unreachable object inside an object stream has no extent of its
        # own to subtract from the residual, so its share is counted here and
        # the `unreferenced` row still names its bytes.
        unreferenced_packed = 0

        def record(og, category: str, nbytes: int) -> None:
            charged[category] += nbytes
            counts[category] += 1
            details[category].append(
                {
                    "page": found.page.get(og),
                    "name": found.key.get(og, ""),
                    "type": _filter_of(objects.get(og)),
                    "bytes": nbytes,
                }
            )

        for og, nbytes in extents.items():
            offset = offsets[og]
            obj = objects.get(og)
            if _is_object_stream(obj):
                objstm_intervals.append([offset, offset + nbytes])
                continue
            if _is_xref_stream(obj) or og in linearization:
                layout_intervals.append([offset, offset + nbytes])
                continue
            category = found.category.get(og)
            if category is None:
                unreferenced_objects += 1
                unreferenced_intervals.append([offset, offset + nbytes])
                continue
            charged_intervals.append([offset, offset + nbytes])
            record(og, category, nbytes)

        # An object stream's extent is what the file spends on its members, so
        # it is divided among them by unparsed length. The rounding remainder
        # stays uncharged rather than being handed to whichever member sorts
        # first.
        for stream_og, member_ogs in members.items():
            extent = extents.get(stream_og)
            if not extent:
                continue
            weights = []
            for og in member_ogs:
                try:
                    weights.append((og, len(pdf.get_object(og[0], og[1]).unparse(resolved=True))))
                except Exception:
                    weights.append((og, 0))
            total_weight = sum(w for _, w in weights)
            if total_weight <= 0:
                continue
            for og, weight in weights:
                category = found.category.get(og)
                if category is None:
                    unreferenced_objects += 1
                    unreferenced_packed += extent * weight // total_weight
                    continue
                if og not in objects:
                    try:
                        objects[og] = pdf.get_object(og[0], og[1])
                    except Exception:
                        objects[og] = None
                record(og, category, extent * weight // total_weight)

        attributed = sum(charged[cid] for cid in CATEGORY_IDS)
        overhead = size - attributed
        charged["overhead"] = overhead

        # The residual is split into measured parts that partition it exactly:
        # each is a subset of the bytes no category was charged for, and the
        # last is what is left after the other three.
        occupied = _merge(charged_intervals + objstm_intervals)
        uncharged = _subtract([[0, size]], occupied)
        xref_iv = _subtract(_merge(_xref_ranges(data) + layout_intervals), occupied)
        unref_iv = _subtract(_merge(unreferenced_intervals), xref_iv)
        revisions, last_start = _revisions(data)
        superseded_iv = _subtract(_clip(uncharged, last_start), _merge(xref_iv + unref_iv))

        xref_bytes = _length(xref_iv)
        unref_bytes = _length(unref_iv) + unreferenced_packed
        superseded_bytes = _length(superseded_iv)
        structural = overhead - xref_bytes - unref_bytes - superseded_bytes

        categories = []
        for cid in CATEGORY_IDS:
            nbytes = charged[cid]
            row = {
                "id": cid,
                "bytes": nbytes,
                "share": (nbytes / size) if size else 0.0,
                "objects": counts[cid],
            }
            knob = KNOBS.get(cid)
            if knob:
                row["knob"] = knob
            if cid == "overhead":
                row["residual"] = True
                row["objects"] = unreferenced_objects
                row["detail"] = [
                    {"kind": "cross_reference", "bytes": xref_bytes},
                    {"kind": "superseded", "bytes": superseded_bytes},
                    {"kind": "unreferenced", "bytes": unref_bytes},
                    {"kind": "structural", "bytes": structural},
                ]
            else:
                rows = sorted(details[cid], key=lambda r: -r["bytes"])
                row["detail"] = rows[:DETAIL_CAP]
                if len(rows) > DETAIL_CAP:
                    row["detail_truncated"] = True
            categories.append(row)

        return {
            "file_size": size,
            "total": sum(row["bytes"] for row in categories),
            "objects": len(table),
            "revisions": revisions,
            "unmeasured_objects": unmeasured,
            "categories": categories,
        }
