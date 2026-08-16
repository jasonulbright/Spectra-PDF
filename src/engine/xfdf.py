"""XFDF annotation interchange (rung 4 — ISO 19444-1's annots arm).

Exports a document's markup annotations to XFDF and imports an XFDF file's
annotations into a document. Geometry, colors, border width, opacity, author, dates,
subject, names, line endings, cloud intensity, callout leaders, quad points,
ink gestures — and the REVIEW THREAD: /IRT reply chains and /State
//StateModel (Accepted/Rejected/Completed/…) ride on `inreplyto`/`state`/
`statemodel`, so a round trip preserves who replied what to whom.

/IRT names a TARGET; /RT names the RELATIONSHIP, and they are separate
attributes here because they are separate facts. A reply and a group member
both point at one annotation and mean different things — a group moves, cuts
and copies as a unit — so an interchange that carried only `inreplyto` turned
every group into a reply thread. `replyType` carries the relationship, always,
including the default: a consuming tool then needs no knowledge of the default
to read this file correctly.

Relationship names outside the defined pair are TRANSCRIBED rather than
classified in both directions. An interchange's job is fidelity, and
transcribing asserts nothing the document does not hold. What cannot be
transcribed — a relationship that will not read, a target with no name to
reference — refuses BY NAME on both halves; the two sides of one interchange
behave the same way when they cannot tell.

Imported annotations carry no appearance streams. Viewers, including ours via
pdf.js, synthesize defaults or regenerate them on load. That is
the format's own convention, not a shortcut.
"""

from __future__ import annotations

import shutil
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path
from xml.sax.saxutils import escape

import pikepdf
from engine.annotations import (
    relationship_name,
    reply_relationship,
    usable_relationship_name,
)
from engine.pdf_save import save_pdf

XFDF_NS = "http://ns.adobe.com/xfdf/"

#: XML attribute values are written inside double quotes, which `escape` does
#: not cover by default.
_QUOT = {chr(34): "&quot;"}

# PDF subtype ↔ XFDF element name.
_SUBTYPE_TO_ELEMENT = {
    "/Text": "text",
    "/FreeText": "freetext",
    "/Line": "line",
    "/Square": "square",
    "/Circle": "circle",
    "/Polygon": "polygon",
    "/PolyLine": "polyline",
    "/Highlight": "highlight",
    "/Underline": "underline",
    "/StrikeOut": "strikeout",
    "/Squiggly": "squiggly",
    "/Ink": "ink",
    "/Stamp": "stamp",
    "/Caret": "caret",
}
_ELEMENT_TO_SUBTYPE = {v: k for k, v in _SUBTYPE_TO_ELEMENT.items()}

# /F bit flags ↔ XFDF's comma-joined names, spec order.
_FLAG_BITS = [
    (1, "invisible"),
    (2, "hidden"),
    (4, "print"),
    (8, "nozoom"),
    (16, "norotate"),
    (32, "noview"),
    (64, "readonly"),
    (128, "locked"),
    (256, "togglenoview"),
    (512, "lockedcontents"),
]


def _color_hex(arr) -> str | None:
    """/C-style array (1/3/4 components, 0..1) → #RRGGBB."""
    try:
        nums = [float(v) for v in arr]
    except Exception:
        return None
    if len(nums) == 1:
        nums = [nums[0]] * 3
    elif len(nums) == 4:
        c, m, y, k = nums
        nums = [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)]
    elif len(nums) != 3:
        return None
    return "#" + "".join(f"{max(0, min(255, round(v * 255))):02X}" for v in nums)


def _hex_color(s: str) -> list[float] | None:
    s = s.strip().lstrip("#")
    if len(s) != 6:
        return None
    try:
        return [int(s[i : i + 2], 16) / 255 for i in (0, 2, 4)]
    except ValueError:
        return None


def _fmt(v: float) -> str:
    out = f"{v:.4f}".rstrip("0").rstrip(".")
    return out if out else "0"


def _flags_names(f: int) -> str:
    return ",".join(name for bit, name in _FLAG_BITS if f & bit)


def _flags_value(names: str) -> int:
    wanted = {n.strip().lower() for n in names.split(",") if n.strip()}
    return sum(bit for bit, name in _FLAG_BITS if name in wanted)


def _str(v) -> str | None:
    if v is None:
        return None
    try:
        return str(v)
    except Exception:
        return None


def export_xfdf(file: str, output: str) -> dict:
    """Write every recognized markup annotation to an XFDF file."""
    count = 0
    by_type: dict[str, int] = {}
    relationships: dict[str, int] = {}
    dangling = 0
    parts: list[str] = []
    with pikepdf.open(file) as pdf:
        for page_index, page in enumerate(pdf.pages):
            annots = page.obj.get("/Annots")
            if annots is None:
                continue
            for a in annots:
                try:
                    subtype = str(a.get("/Subtype"))
                except Exception:
                    continue
                element = _SUBTYPE_TO_ELEMENT.get(subtype)
                if element is None:
                    continue
                attrs: list[str] = [f'page="{page_index}"']
                rect = a.get("/Rect")
                if rect is not None:
                    attrs.append(
                        'rect="' + ",".join(_fmt(float(v)) for v in rect) + '"'
                    )
                color = _color_hex(a.get("/C")) if a.get("/C") is not None else None
                if color:
                    attrs.append(f'color="{color}"')
                ic = _color_hex(a.get("/IC")) if a.get("/IC") is not None else None
                if ic:
                    attrs.append(f'interior-color="{ic}"')
                bs = a.get("/BS")
                if bs is not None and bs.get("/W") is not None:
                    attrs.append(f'width="{_fmt(float(bs.get("/W")))}"')
                if a.get("/CA") is not None:
                    attrs.append(f'opacity="{_fmt(float(a.get("/CA")))}"')
                for key, attr in (
                    ("/T", "title"),
                    ("/Subj", "subject"),
                    ("/M", "date"),
                    ("/CreationDate", "creationdate"),
                    ("/NM", "name"),
                ):
                    v = _str(a.get(key))
                    if v:
                        attrs.append(f'{attr}="{escape(v, {chr(34): "&quot;"})}"')
                if a.get("/F") is not None:
                    names = _flags_names(int(a.get("/F")))
                    if names:
                        attrs.append(f'flags="{names}"')
                # Review thread: reply target, the relationship, and status.
                relationship = reply_relationship(a)
                spelling = relationship_name(relationship.kind, relationship.name)
                if not relationship.readable or (
                    relationship.target is not None and spelling is None
                ):
                    raise ValueError(
                        "the reply relationship of an annotation on page "
                        f"{page_index + 1} cannot be read"
                    )
                if relationship.target is not None:
                    try:
                        irt_name = _str(relationship.target.get("/NM"))
                    except Exception:
                        irt_name = None
                    if not irt_name:
                        # XFDF references by name and there is none. Dropping
                        # the attribute loses the relationship silently;
                        # inventing a name would put an identifier into the
                        # interchange that a re-import would make real.
                        raise ValueError(
                            f"the annotation replied to on page {page_index + 1} "
                            "has no name, so XFDF cannot reference it"
                        )
                    attrs.append(f'inreplyto="{escape(irt_name, _QUOT)}"')
                    attrs.append(f'replyType="{escape(spelling, _QUOT)}"')
                    relationships[spelling] = relationships.get(spelling, 0) + 1
                elif relationship.name is not None:
                    dangling += 1
                for key, attr in (("/State", "state"), ("/StateModel", "statemodel")):
                    v = _str(a.get(key))
                    if v:
                        attrs.append(f'{attr}="{escape(v, {chr(34): "&quot;"})}"')
                if subtype == "/Text" and a.get("/Name") is not None:
                    attrs.append(f'icon="{str(a.get("/Name")).lstrip("/")}"')
                # Geometry per subtype.
                children: list[str] = []
                if subtype == "/Line":
                    line = a.get("/L")
                    if line is not None and len(line) == 4:
                        pts = [float(v) for v in line]
                        attrs.append(f'start="{_fmt(pts[0])},{_fmt(pts[1])}"')
                        attrs.append(f'end="{_fmt(pts[2])},{_fmt(pts[3])}"')
                    le = a.get("/LE")
                    if le is not None and len(le) == 2:
                        attrs.append(f'head="{str(le[0]).lstrip("/")}"')
                        attrs.append(f'tail="{str(le[1]).lstrip("/")}"')
                if subtype in ("/Polygon", "/PolyLine"):
                    verts = a.get("/Vertices")
                    if verts is not None:
                        nums = [float(v) for v in verts]
                        pairs = ";".join(
                            f"{_fmt(nums[i])},{_fmt(nums[i + 1])}" for i in range(0, len(nums) - 1, 2)
                        )
                        children.append(f"<vertices>{pairs}</vertices>")
                    be = a.get("/BE")
                    if be is not None and str(be.get("/S")) == "/C":
                        attrs.append('style="cloudy"')
                        if be.get("/I") is not None:
                            attrs.append(f'intensity="{_fmt(float(be.get("/I")))}"')
                if subtype in ("/Highlight", "/Underline", "/StrikeOut", "/Squiggly"):
                    qp = a.get("/QuadPoints")
                    if qp is not None:
                        attrs.append(
                            'coords="' + ",".join(_fmt(float(v)) for v in qp) + '"'
                        )
                if subtype == "/Ink":
                    ink = a.get("/InkList")
                    if ink is not None:
                        gestures = []
                        for stroke in ink:
                            nums = [float(v) for v in stroke]
                            gestures.append(
                                "<gesture>"
                                + ";".join(
                                    f"{_fmt(nums[i])},{_fmt(nums[i + 1])}"
                                    for i in range(0, len(nums) - 1, 2)
                                )
                                + "</gesture>"
                            )
                        children.append("<inklist>" + "".join(gestures) + "</inklist>")
                if subtype == "/FreeText":
                    it = a.get("/IT")
                    if it is not None:
                        attrs.append(f'IT="{str(it).lstrip("/")}"')
                    cl = a.get("/CL")
                    if cl is not None:
                        attrs.append(
                            'callout-line="' + ",".join(_fmt(float(v)) for v in cl) + '"'
                        )
                    rd = a.get("/RD")
                    if rd is not None:
                        attrs.append(
                            'fringe="' + ",".join(_fmt(float(v)) for v in rd) + '"'
                        )
                contents = _str(a.get("/Contents"))
                if contents:
                    children.append(f"<contents>{escape(contents)}</contents>")
                body = "".join(children)
                parts.append(
                    f"<{element} {' '.join(attrs)}>{body}</{element}>"
                    if body
                    else f"<{element} {' '.join(attrs)}/>"
                )
                count += 1
                key = element
                by_type[key] = by_type.get(key, 0) + 1
    xml = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<xfdf xmlns="{XFDF_NS}" xml:space="preserve">\n<annots>\n'
        + "\n".join(parts)
        + "\n</annots>\n</xfdf>\n"
    )
    with open(output, "w", encoding="utf-8") as f:
        f.write(xml)
    out = {
        "output": output,
        "count": count,
        "by_type": by_type,
        "relationships": relationships,
    }
    if dangling:
        # A /RT with no /IRT names no relationship, so nothing is written for
        # it. The count says a key was read and deliberately not carried.
        out["dangling_reply_type"] = dangling
    return out


def _parse_pairs(text: str) -> list[float]:
    out: list[float] = []
    for pair in text.strip().split(";"):
        if not pair.strip():
            continue
        for num in pair.split(","):
            out.append(float(num))
    return out


def import_xfdf(file: str, xfdf: str, output: str) -> dict:
    """Add an XFDF file's annotations to the document (new objects; nothing
    existing is touched). Unknown elements are skipped and reported."""
    tree = ET.parse(xfdf)
    root = tree.getroot()

    def local(tag: str) -> str:
        return tag.rsplit("}", 1)[-1]

    annots_el = None
    for child in root:
        if local(child.tag) == "annots":
            annots_el = child
            break
    if annots_el is None:
        raise ValueError("the XFDF file has no <annots> section")

    added = 0
    skipped: list[dict] = []
    relationships: dict[str, int] = {}
    dangling = 0
    unresolved = 0
    pending_irt: list[tuple[pikepdf.Object, int, str, str]] = []

    with pikepdf.open(file) as pdf:
        page_count = len(pdf.pages)
        for el in annots_el:
            element = local(el.tag)
            subtype = _ELEMENT_TO_SUBTYPE.get(element)
            if subtype is None:
                skipped.append({"element": element, "reason": "unsupported element"})
                continue
            try:
                page_index = int(el.get("page", "0"))
            except ValueError:
                skipped.append({"element": element, "reason": "bad page attribute"})
                continue
            if not (0 <= page_index < page_count):
                skipped.append({"element": element, "reason": f"page {page_index} out of range"})
                continue
            rect_attr = el.get("rect")
            if not rect_attr:
                skipped.append({"element": element, "reason": "missing rect"})
                continue
            try:
                rect = [float(v) for v in rect_attr.split(",")]
                if len(rect) != 4:
                    raise ValueError
            except ValueError:
                skipped.append({"element": element, "reason": "bad rect"})
                continue

            a = pikepdf.Dictionary(
                Type=pikepdf.Name("/Annot"),
                Subtype=pikepdf.Name(subtype),
                Rect=pikepdf.Array(rect),
            )
            color = _hex_color(el.get("color") or "")
            if color:
                a["/C"] = pikepdf.Array(color)
            ic = _hex_color(el.get("interior-color") or "")
            if ic:
                a["/IC"] = pikepdf.Array(ic)
            if el.get("width"):
                try:
                    a["/BS"] = pikepdf.Dictionary(W=float(el.get("width")))
                except ValueError:
                    pass
            if el.get("opacity"):
                try:
                    a["/CA"] = float(el.get("opacity"))
                except ValueError:
                    pass
            for attr, key in (
                ("title", "/T"),
                ("subject", "/Subj"),
                ("date", "/M"),
                ("creationdate", "/CreationDate"),
                ("name", "/NM"),
                ("state", "/State"),
                ("statemodel", "/StateModel"),
            ):
                v = el.get(attr)
                if v:
                    a[key] = pikepdf.String(v)
            flags = el.get("flags")
            a["/F"] = _flags_value(flags) if flags else 4  # default: print
            if subtype == "/Text" and el.get("icon"):
                a["/Name"] = pikepdf.Name("/" + el.get("icon"))
            if subtype == "/Line":
                start = el.get("start")
                end = el.get("end")
                if start and end:
                    try:
                        pts = [float(v) for v in start.split(",")] + [float(v) for v in end.split(",")]
                        a["/L"] = pikepdf.Array(pts)
                    except ValueError:
                        pass
                head = el.get("head")
                tail = el.get("tail")
                if head or tail:
                    a["/LE"] = pikepdf.Array(
                        [pikepdf.Name("/" + (head or "None")), pikepdf.Name("/" + (tail or "None"))]
                    )
            if subtype in ("/Polygon", "/PolyLine"):
                for child in el:
                    if local(child.tag) == "vertices" and child.text:
                        try:
                            a["/Vertices"] = pikepdf.Array(_parse_pairs(child.text))
                        except ValueError:
                            pass
                if (el.get("style") or "").lower() == "cloudy":
                    be = pikepdf.Dictionary(S=pikepdf.Name("/C"))
                    if el.get("intensity"):
                        try:
                            be["/I"] = float(el.get("intensity"))
                        except ValueError:
                            pass
                    a["/BE"] = be
                    if subtype == "/Polygon":
                        a["/IT"] = pikepdf.Name("/PolygonCloud")
            if subtype in ("/Highlight", "/Underline", "/StrikeOut", "/Squiggly"):
                coords = el.get("coords")
                if coords:
                    try:
                        a["/QuadPoints"] = pikepdf.Array([float(v) for v in coords.split(",")])
                    except ValueError:
                        pass
            if subtype == "/Ink":
                for child in el:
                    if local(child.tag) == "inklist":
                        strokes = []
                        for g in child:
                            if local(g.tag) == "gesture" and g.text:
                                try:
                                    strokes.append(pikepdf.Array(_parse_pairs(g.text)))
                                except ValueError:
                                    pass
                        if strokes:
                            a["/InkList"] = pikepdf.Array(strokes)
            if subtype == "/FreeText":
                if el.get("IT"):
                    a["/IT"] = pikepdf.Name("/" + el.get("IT"))
                if el.get("callout-line"):
                    try:
                        a["/CL"] = pikepdf.Array([float(v) for v in el.get("callout-line").split(",")])
                    except ValueError:
                        pass
                if el.get("fringe"):
                    try:
                        a["/RD"] = pikepdf.Array([float(v) for v in el.get("fringe").split(",")])
                    except ValueError:
                        pass
                # A minimal /DA so viewers can synthesize text (spec-required).
                a["/DA"] = pikepdf.String("0 0 0 rg /Helv 12 Tf")
            for child in el:
                if local(child.tag) == "contents" and child.text:
                    a["/Contents"] = pikepdf.String(child.text)

            obj = pdf.make_indirect(a)
            page = pdf.pages[page_index]
            if page.obj.get("/Annots") is None:
                page.obj["/Annots"] = pdf.make_indirect(pikepdf.Array())
            page.obj["/Annots"].append(obj)
            added += 1

            irt = el.get("inreplyto")
            reply_type = el.get("replyType")
            if not irt:
                if reply_type:
                    dangling += 1
                continue
            spelling = "R"
            if reply_type:
                spelling = usable_relationship_name(reply_type)
                if spelling is None:
                    raise ValueError(
                        f"not a reply relationship XFDF can carry: {reply_type}"
                    )
            if el.get("name") == irt:
                # An annotation naming itself is not a relationship, and the
                # readers that walk /IRT would have to cut the loop anyway.
                unresolved += 1
                continue
            pending_irt.append((obj, page_index, irt, spelling))

        # Second pass: resolve reply targets by /NM. /NM is unique only within
        # a PAGE and an /IRT pair is required to be on one page, so the name is
        # a page-scoped identifier: a document-wide first-match scan can bind a
        # reply to a same-named annotation on another page and never say so.
        # A name that is ambiguous on its page resolves to nothing rather than
        # to a coin flip; a name unique across the whole document still binds,
        # so a cross-page thread from a producer that ignores the page rule
        # survives where its intent is unmistakable.
        by_page_name: dict[tuple[int, str], pikepdf.Object] = {}
        page_counts: dict[tuple[int, str], int] = {}
        name_counts: dict[str, int] = {}
        name_first: dict[str, pikepdf.Object] = {}
        for index, page in enumerate(pdf.pages):
            annots = page.obj.get("/Annots")
            if annots is None:
                continue
            for existing in annots:
                try:
                    nm = _str(existing.get("/NM"))
                except Exception:
                    continue
                if not nm:
                    continue
                by_page_name.setdefault((index, nm), existing)
                page_counts[(index, nm)] = page_counts.get((index, nm), 0) + 1
                name_counts[nm] = name_counts.get(nm, 0) + 1
                name_first.setdefault(nm, existing)

        for obj, page_index, target, spelling in pending_irt:
            key = (page_index, target)
            ref = by_page_name.get(key) if page_counts.get(key, 0) == 1 else None
            if ref is None and name_counts.get(target, 0) == 1:
                ref = name_first.get(target)
            if ref is None:
                unresolved += 1
                continue
            # /RT is written only where /IRT was: the format requires the
            # target beside the relationship, so an unresolved reply must not
            # be left holding a relationship that points at nothing.
            obj["/IRT"] = ref
            obj["/RT"] = pikepdf.Name("/" + spelling)
            relationships[spelling] = relationships.get(spelling, 0) + 1
        # In-place safe: pikepdf can't save over its own open input — stage
        # beside it and swap (the attachments/_save pattern; the CLI's
        # in-place bug class). A signed input's landed bytes become an
        # incremental append, so importing a review file onto a signed
        # document keeps its signature verifiable.
        from engine.incremental import finalize_preserving_signatures

        in_path = Path(file)
        out_path = Path(output)
        if in_path.resolve() == out_path.resolve():
            with tempfile.NamedTemporaryFile(
                suffix=".pdf", delete=False, dir=str(in_path.parent)
            ) as tmp:
                tmp_path = tmp.name
            save_pdf(pdf, tmp_path)
            preserved = finalize_preserving_signatures(str(in_path), tmp_path)
            shutil.move(tmp_path, str(out_path))
        else:
            save_pdf(pdf, output)
            preserved = finalize_preserving_signatures(str(in_path), str(out_path))
    out: dict = {
        "output": output,
        "added": added,
        "skipped": skipped,
        "relationships": relationships,
    }
    if unresolved:
        out["unresolved_replies"] = unresolved
    if dangling:
        out["dangling_reply_type"] = dangling
    if preserved.get("preserved"):
        out["signatures_preserved"] = True
    return out
