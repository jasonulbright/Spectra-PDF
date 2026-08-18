"""The widget appearance faces a Ghostscript pass would otherwise flatten.

The producer drops every widget annotation and FLATTENS its appearance into the
page content (measured), while the field reattach that follows puts the widget
back wearing the appearance the ORIGINAL had. That costs the document two
things at once: the field is painted TWICE — once as page content, once by the
widget — and the surviving `/AP` never went through the pass at all, so an RGB
paint inside a widget appearance came out of a grayscale or a CMYK conversion
still RGB.

No producer switch reaches it. `-dPreserveAnnots` changes nothing for a widget
(dropped and flattened under either value, measured), and `-dShowAnnots=false`
suppresses EVERY annotation's appearance — which would cost a dropped
`/PrinterMark` the plate it only keeps because its appearance was flattened
into the page.

So the widget is taken out of the producer's input, leaving nothing to flatten,
and each appearance FACE is staged as a page of its own whose box is the face's
own. The staged pages travel through the op's OWN producer invocation — the
same executable, the same parameters, one pass — and the producer transforms a
page exactly as it transforms a flattened appearance (measured identical, plate
for plate). EVERY face is transformed that way rather than only the one `/AS`
selects. The transformed pages are harvested back onto the faces, and the
fields reattach from that file.

A widget with NO appearance is given one BEFORE any of that, by
`regenerate_appearances_file`, and then rides the staging as an ordinary
appearance-carrying widget.

Boundaries, each measured:
  - one stream worn by two widgets is staged once and transformed once — the
    pairing is by face, not by widget.
  - the harvest runs BEFORE any pass that re-anchors an appearance to its
    annotation rectangle (`prepress._rebase_appearances`), which must never see
    a harvested face: that face's content came from a page, so the pattern
    matrices in it are already stated in the face's own default space, and
    rebasing would re-anchor them to a space they were not written for.
"""

import shutil
from pathlib import Path

import pikepdf
from pikepdf import Dictionary, Name

from .acroform import has_form_fields

IDENTITY = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)


def compose(inner, outer):
    """`inner` then `outer`, in the row-vector convention PDF matrices use."""
    a, b, c, d, e, f = inner
    p, q, r, s, t, u = outer
    return (a * p + b * r, a * q + b * s,
            c * p + d * r, c * q + d * s,
            e * p + f * r + t, e * q + f * s + u)


def matrix_of(obj, key: str):
    """A six-number matrix entry, or the identity when there is none."""
    try:
        entry = obj.get(key)
        if entry is None:
            return IDENTITY
        values = [float(v) for v in entry]
    except (TypeError, ValueError, AttributeError):
        return None
    return tuple(values) if len(values) == 6 else None


def box_of(obj, key: str):
    """A rectangle as (x0, y0, x1, y1) with the corners in order."""
    try:
        values = [float(v) for v in obj.get(key)]
    except (TypeError, ValueError, AttributeError):
        return None
    if len(values) != 4:
        return None
    return (min(values[0], values[2]), min(values[1], values[3]),
            max(values[0], values[2]), max(values[1], values[3]))


def face_box(stream):
    """12.5.5's transformed appearance box: the `/BBox` after the `/Matrix`.

    None for a degenerate one, which is what the standard's own algorithm says
    about a box with no area — it has no map onto anything.
    """
    bbox = box_of(stream, "/BBox")
    matrix = matrix_of(stream, "/Matrix")
    if bbox is None or matrix is None:
        return None
    corners = [compose((1, 0, 0, 1, x, y), matrix)[4:]
               for x in (bbox[0], bbox[2]) for y in (bbox[1], bbox[3])]
    xs = [point[0] for point in corners]
    ys = [point[1] for point in corners]
    box = (min(xs), min(ys), max(xs), max(ys))
    if box[2] - box[0] <= 0 or box[3] - box[1] <= 0:
        return None
    return box


def face_streams(appearance) -> list:
    """Every face an `/AP` wears — `/N`, `/R`, `/D` and their states."""
    out: list = []
    try:
        keys = list(appearance.keys())
    except Exception:  # noqa: BLE001 — an unreadable /AP wears no face
        return out
    for key in keys:
        entry = appearance[key]
        if isinstance(entry, pikepdf.Stream):
            out.append(entry)
        elif isinstance(entry, Dictionary):
            for state in list(entry.keys()):
                face = entry[state]
                if isinstance(face, pikepdf.Stream):
                    out.append(face)
    return out


def staged_faces(pdf) -> list:
    """The widget appearance faces that paint, in the order that names them.

    The same file walked again yields the same list, which is how a transformed
    page pairs back to the face it was staged from. One stream worn by two
    widgets appears once — the pairing is by face, not by widget, so a shared
    appearance is staged once and transformed once.
    """
    seen: set = set()
    out: list = []
    for page in pdf.pages:
        for annot in list(page.obj.get("/Annots") or []):
            try:
                if annot.get("/Subtype") != Name.Widget:
                    continue
                appearance = annot.get("/AP")
            except Exception:  # noqa: BLE001
                continue
            if appearance is None:
                continue
            for face in face_streams(appearance):
                # ISO 32000-2 7.3.8.1: a stream is always an indirect object.
                # That is what lets a face be named by object number across two
                # opens of one file, which both the pairing and the set of
                # widgets to drop rest on.
                if not face.is_indirect or face.objgen in seen:
                    continue
                if face_box(face) is None:
                    continue
                seen.add(face.objgen)
                out.append(face)
    return out


def stage_appearances(pdf) -> list:
    """Give every widget appearance face a page of its own, and drop the
    widgets that now have one. Returns the staged boxes, in page order.

    Every inheritable page attribute (ISO 32000-2 7.7.3.4) is written on the
    staged page: an inherited `/Rotate` would otherwise turn the appearance
    sideways, and an inherited `/CropBox` would cut it (measured).
    """
    if not has_form_fields(pdf):
        return []
    faces = staged_faces(pdf)
    if not faces:
        return []
    boxes: list = []
    idents: set = set()
    for face in faces:
        box = face_box(face)
        # An appearance IS a form XObject (12.5.5); as a page resource it has
        # to say so, and a face that left the keys implicit would draw nothing.
        face["/Type"] = Name.XObject
        face["/Subtype"] = Name.Form
        pdf.pages.append(pikepdf.Page(pdf.make_indirect(Dictionary(
            Type=Name.Page,
            MediaBox=pikepdf.Array(list(box)),
            CropBox=pikepdf.Array(list(box)),
            Rotate=0,
            Resources=Dictionary(XObject=Dictionary(Fm=face)),
            Contents=pdf.make_stream(b"/Fm Do")))))
        boxes.append(box)
        idents.add(face.objgen)
    _drop_staged_widgets(pdf, idents)
    return boxes


def regenerate_appearances_file(source: Path, scratch: Path,
                                font_dir: str = ""):
    """A copy of `source` whose `/AP`-less widgets carry the appearance their
    own field states, or None when there was none to give.

    The producer SYNTHESIZES an appearance for a widget that carries none and
    flattens it into the page (measured), and the field reattach then RESTORES
    the widget over that flatten. The flatten is therefore a duplicate that
    outlives the value it was drawn from: refill the field and the `/AP` says
    the new value while the page content still paints the old one, for good.

    Giving the widget its appearance first leaves the producer nothing to
    synthesize, and the face then travels the op's own pass like every other
    face — so the appearance has ONE author (the fill's own emitters) and ONE
    transform (the op's own producer invocation), rather than one author per
    op deciding what the destination space is.

    Every path that reads the document as CONTENT reads this copy afterwards,
    the reattach included: a widget whose appearance only the staged input
    carried would come back bare.

    A field whose value nothing available can draw keeps no appearance here and
    so stays in the producer's input, which is the one case the flatten still
    happens in — drawing it would need a face `font_dir` did not supply, and
    inventing one spells the value in glyphs that mean something else.
    """
    with pikepdf.open(str(source)) as pdf:
        if not has_form_fields(pdf):
            return None
        from .forms import regenerate_missing_appearances

        drew, _undrawn = regenerate_missing_appearances(pdf, font_dir)
        if not drew:
            return None
        path = Path(scratch) / "regenerated.pdf"
        pdf.save(str(path))
    return path


def stage_appearances_file(source: Path, scratch: Path):
    """(the staged input or None, the staged boxes) for an op whose producer
    input is otherwise the original file.

    None means nothing was staged and the pass runs on the original, which is
    every document that carries no form field.
    """
    with pikepdf.open(str(source)) as pdf:
        boxes = stage_appearances(pdf)
        if not boxes:
            return None, []
        path = Path(scratch) / "staged.pdf"
        pdf.save(str(path))
    return path, boxes


def _drop_staged_widgets(pdf, idents: set) -> None:
    """Remove every widget whose appearance is staged — the producer has
    nothing left to flatten, and the reattach puts the widget back."""
    def staged(annot) -> bool:
        try:
            if annot.get("/Subtype") != Name.Widget:
                return False
            appearance = annot.get("/AP")
        except Exception:  # noqa: BLE001
            return False
        if appearance is None:
            return False
        return any(face.is_indirect and face.objgen in idents
                   for face in face_streams(appearance))

    for page in pdf.pages:
        annots = page.obj.get("/Annots")
        if annots is None:
            continue
        entries = list(annots)
        keep = [annot for annot in entries if not staged(annot)]
        if len(keep) != len(entries):
            page.obj["/Annots"] = pikepdf.Array(keep)


def _page_bytes(page) -> bytes:
    contents = page.obj.get("/Contents")
    if isinstance(contents, pikepdf.Stream):
        return bytes(contents.read_bytes())
    if contents is None:
        return b""
    return b"\n".join(bytes(entry.read_bytes()) for entry in contents
                      if isinstance(entry, pikepdf.Stream))


def _staged_matrix(staged, produced):
    """The `/Matrix` that puts the producer's page back where the face was.

    pdfwrite moves a page's origin to (0, 0) (measured), so the transformed
    content sits at a translation from the box it was staged in. The face's
    `/BBox` becomes the producer's own page box and its `/Matrix` carries the
    map back, which leaves 12.5.5's appearance-to-Rect map the one the face
    already had — the appearance lands exactly where it landed before.
    """
    if staged is None or produced is None:
        return None
    width, height = produced[2] - produced[0], produced[3] - produced[1]
    if width <= 0 or height <= 0:
        return None
    sx = (staged[2] - staged[0]) / width
    sy = (staged[3] - staged[1]) / height
    return (sx, 0.0, 0.0, sy,
            staged[0] - produced[0] * sx, staged[1] - produced[1] * sy)


def harvest_appearances(output: Path, source: Path, scratch: Path,
                        boxes: list, source_pages: int):
    """Harvest the staged pages onto the source's faces, and drop the pages.

    Returns the file the field reattach transplants from, or None when the
    pairing did not hold — the reattach then runs from the original, which
    costs the appearance its transformation and never the document its fields.
    The staged pages come off either way: they are scaffolding, and a document
    that shipped them would carry an extra page per appearance face.
    """
    if not boxes:
        return None
    forms = Path(scratch) / "forms.pdf"
    shutil.copyfile(str(source), str(forms))
    paired = False
    with pikepdf.open(str(output), allow_overwriting_input=True) as converted:
        pages = list(converted.pages)
        if len(pages) != source_pages + len(boxes):
            # Which pages are the scaffolding is known from the count the
            # producer was handed; without that, the scaffolding cannot be told
            # from the document's own pages and neither may be removed. That is
            # already the reattach's own refusal, raised here only because the
            # pages it counts have not come off yet.
            raise ValueError(
                "The regenerated file's page count differs from the original; "
                "cannot reattach its form fields."
            )
        staged_pages = pages[source_pages:]
        with pikepdf.open(str(forms), allow_overwriting_input=True) as src:
            faces = staged_faces(src)
            if len(faces) == len(boxes):
                for face, page, box in zip(faces, staged_pages, boxes):
                    produced = box_of(page.obj, "/MediaBox")
                    matrix = _staged_matrix(box, produced)
                    if matrix is None:
                        continue
                    resources = page.obj.get("/Resources")
                    face.write(_page_bytes(page))
                    face["/BBox"] = pikepdf.Array(list(produced))
                    face["/Matrix"] = pikepdf.Array(list(matrix))
                    if resources is not None:
                        face["/Resources"] = src.copy_foreign(
                            converted.make_indirect(resources))
                    elif face.get("/Resources") is not None:
                        del face["/Resources"]
                # Saved while `converted` is still open: a foreign copy
                # resolves lazily, so its source has to outlive the save.
                src.save(str(forms))
                paired = True
        for index in range(len(pages) - 1, source_pages - 1, -1):
            del converted.pages[index]
        converted.save(str(output))
    return forms if paired else None
