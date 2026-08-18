"""Writing back over the input, for every op that accepts `output == file`.

The panel hands the open document's path twice and the fixup chain feeds each
door the file the door before it wrote, so in place is the shape the real
callers use — not an edge case. Three properties are pinned for each op, as one
family rather than a pile of coincidences:

  * in place lands what a distinct output lands, byte for byte;
  * a write that dies leaves the input whole and nothing staged beside it;
  * one physical file under two names is recognised as one file.

`save_pdf` derives the trailer `/ID` from the written bytes, so one input has
exactly one output — which makes "in place did the same thing" a byte
comparison rather than an assertion. An op whose own output varies run to run
says so on its case (`deterministic=False`) and is compared by what it drew
instead; nothing is quietly excluded.
"""

import os
import shutil
import zlib
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import pikepdf
import pytest
from pikepdf import Array, Dictionary, Name, String

from engine import annotations as annotations_mod
from engine import attachments as attachments_mod
from engine import content_crop as content_crop_mod
from engine import delete as delete_mod
from engine import form_authoring as form_authoring_mod
from engine import forms as forms_mod
from engine import headers as headers_mod
from engine import layers as layers_mod
from engine import links as links_mod
from engine import mrc as mrc_mod
from engine import ocr_layer as ocr_layer_mod
from engine import outline as outline_mod
from engine import page_boxes as page_boxes_mod
from engine import page_images as page_images_mod
from engine import page_labels as page_labels_mod
from engine import printer_marks as printer_marks_mod
from engine import redact as redact_mod
from engine import redact_marks as redact_marks_mod
from engine import rotate as rotate_mod
from engine import struct_audit as struct_audit_mod
from engine import struct_fix as struct_fix_mod
from engine import struct_tree as struct_tree_mod
from engine import watermark as watermark_mod
from engine import xfdf as xfdf_mod
from engine.extract_text import extract_text

FIXTURES = Path(__file__).resolve().parent / "fixtures"


# ── the documents ──────────────────────────────────────────────────────────


def _scanlike(path: Path) -> Path:
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(400, 300))
    page.Contents = pdf.make_stream(b"q 0.9 0.9 0.9 rg 20 20 360 260 re f Q")
    pdf.save(str(path))
    pdf.close()
    return path


def _with_images(path: Path) -> Path:
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(612, 792))

    def image(r, g, b):
        stream = pdf.make_stream(zlib.compress(bytes([r, g, b]) * 16))
        stream["/Type"] = Name("/XObject")
        stream["/Subtype"] = Name("/Image")
        stream["/Width"] = 4
        stream["/Height"] = 4
        stream["/ColorSpace"] = Name("/DeviceRGB")
        stream["/BitsPerComponent"] = 8
        stream["/Filter"] = Name("/FlateDecode")
        return pdf.make_indirect(stream)

    page.obj["/Resources"] = Dictionary(
        XObject=Dictionary(ImA=image(255, 0, 0), ImB=image(0, 0, 255))
    )
    page.Contents = pdf.make_stream(
        b"q 100 0 0 80 50 600 cm /ImA Do Q q 200 0 0 150 50 300 cm /ImB Do Q"
    )
    pdf.save(str(path))
    pdf.close()
    return path


def _tagged(path: Path) -> Path:
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(300, 400))

    def elem(**kw):
        return pdf.make_indirect(Dictionary(Type=Name.StructElem, **kw))

    doc = elem(S=Name.Document)
    h1 = elem(S=Name.H1, P=doc, Pg=page.obj, K=0)
    para = elem(S=Name.P, P=doc, Pg=page.obj, K=Array([1]))
    doc[Name.K] = Array([h1, para])
    st = pdf.make_indirect(Dictionary(Type=Name.StructTreeRoot))
    doc[Name.P] = st
    st[Name.K] = Array([doc])
    st[Name.ParentTree] = pdf.make_indirect(
        Dictionary(Nums=Array([0, pdf.make_indirect(Array([h1, para]))]))
    )
    st[Name.ParentTreeNextKey] = 1
    page.obj[Name.StructParents] = 0
    pdf.Root[Name.StructTreeRoot] = st
    pdf.Root[Name.MarkInfo] = Dictionary(Marked=True)
    pdf.save(str(path))
    pdf.close()
    return path


def _tagged_table(path: Path) -> Path:
    """A tagged table whose first row is ordinary cells — what promoting a
    header row is offered on. Built by the accessibility fixtures so the
    document the fix runs against here is the one it runs against there."""
    import a11y_builders

    a11y_builders.table_no_headers(str(path))
    return path


def _with_links(path: Path) -> Path:
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(300, 400))
    uri = pdf.make_indirect(Dictionary(
        Type=Name.Annot, Subtype=Name.Link, Rect=[10, 10, 100, 30],
        A=Dictionary(Type=Name.Action, S=Name.URI, URI=String("https://example.com")),
    ))
    page.obj["/Annots"] = Array([uri])
    pdf.save(str(path))
    pdf.close()
    return path


def _with_attachment(path: Path) -> Path:
    payload = path.parent / "payload.txt"
    payload.write_bytes(b"hello attachment")
    plain = path.parent / "plain.pdf"
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(200, 200))
    pdf.save(str(plain))
    pdf.close()
    attachments_mod.add_attachment(str(plain), str(path), str(payload))
    payload.unlink()
    plain.unlink()
    return path


def _blank(path: Path, pages: int = 2, size=(300, 400)) -> Path:
    pdf = pikepdf.new()
    for _ in range(pages):
        pdf.add_blank_page(page_size=size)
    pdf.save(str(path))
    pdf.close()
    return path


def _with_text(path: Path) -> Path:
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(300, 400))
    font = pdf.make_indirect(Dictionary(
        Type=Name.Font, Subtype=Name.Type1,
        BaseFont=Name("/Helvetica"), Encoding=Name("/WinAnsiEncoding"),
    ))
    page.obj["/Resources"] = Dictionary(Font=Dictionary(F1=font))
    page.Contents = pdf.make_stream(b"BT /F1 24 Tf 40 200 Td (CONFIDENTIAL) Tj ET")
    pdf.save(str(path))
    pdf.close()
    return path


def _with_comment(path: Path) -> Path:
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(300, 400))
    note = pdf.make_indirect(Dictionary(
        Type=Name.Annot, Subtype=Name.Text, Rect=Array([10, 10, 30, 30]),
        Contents=String("a note"), T=String("Reviewer"),
    ))
    page.obj["/Annots"] = Array([note])
    pdf.save(str(path))
    pdf.close()
    return path


def _layered(path: Path) -> Path:
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(300, 400))
    ocg = pdf.make_indirect(Dictionary(Type=Name.OCG, Name=String("Layer One")))
    pdf.Root["/OCProperties"] = Dictionary(
        OCGs=Array([ocg]), D=Dictionary(ON=Array([ocg]), OFF=Array([])),
    )
    pdf.save(str(path))
    pdf.close()
    return path


TEXT_FIELD = {
    "name": "Full_name", "type": "text", "page_index": 0,
    "rect": [20, 300, 280, 320],
}


def _with_field(path: Path) -> Path:
    plain = path.parent / "plain.pdf"
    _blank(plain, pages=1)
    form_authoring_mod.add_form_fields(str(plain), str(path), [TEXT_FIELD])
    plain.unlink()
    return path


def _marked(path: Path) -> Path:
    plain = path.parent / "plain.pdf"
    _blank(plain, pages=1, size=(400, 400))
    printer_marks_mod.add_printer_marks(
        str(plain), str(path), marks=["crop"], timestamp=MARK_STAMP)
    plain.unlink()
    return path


#: The XFDF an import case reads. It sits beside the document for the whole
#: case, so it is declared on `Case.leaves` rather than cleaned up.
XFDF_NAME = "import.xfdf"
XFDF_BODY = (
    '<?xml version="1.0"?><xfdf xmlns="http://ns.adobe.com/xfdf/">'
    '<annots><square page="0" rect="5,5,50,50"/></annots></xfdf>'
)


def _with_xfdf(path: Path) -> Path:
    (path.parent / XFDF_NAME).write_text(XFDF_BODY, encoding="utf-8")
    return _blank(path, pages=1)


def _scan_fixture(path: Path) -> Path:
    source = FIXTURES / "scan-text.pdf"
    if not source.is_file():
        pytest.skip("scan-text.pdf not generated (tests/fixtures/make_scans.py)")
    shutil.copy2(source, path)
    return path


# ── the ops ────────────────────────────────────────────────────────────────


OCR_WORDS = [{"text": "INVOICE", "rect": [40, 240, 140, 262]}]

#: Printer marks stamp the moment they are drawn unless told what to write.
#: Pinning it is what makes the two runs comparable byte for byte.
MARK_STAMP = "2026-01-01T00:00:00+0000"

REDACT_REGION = [{"page": 1, "rect": [30, 190, 280, 235]}]


@dataclass(frozen=True)
class Case:
    """One op that accepts `output == file`.

    `module` is the namespace whose `save_pdf` the death test replaces, so it
    has to be the module that performs the write rather than the one that
    defines it. `leaves` names what the BUILD legitimately puts beside the
    document — an op's own input file — so that "nothing staged" stays a claim
    about staging.

    `deterministic` is False for an op whose own output varies run to run, so
    the two runs are compared by `_drawn` instead of by bytes; the reason is
    named on each such case.
    """

    name: str
    module: object
    build: Callable[[Path], Path]
    run: Callable[[str, str], dict]
    effect: Callable[[str], object]
    needs_gs: bool = False
    leaves: tuple = ()
    deterministic: bool = True


def _ocr_effect(path: str) -> object:
    with pikepdf.open(path) as pdf:
        xobjects = pdf.pages[0].obj.get("/Resources", {}).get("/XObject")
        return xobjects is not None and "/SpectraPDFOCR" in xobjects


def _image_names(path: str) -> object:
    return [row["name"] for row in page_images_mod.list_page_images(path, 1)["images"]]


def _tag_types(path: str) -> object:
    tree = struct_tree_mod.get_struct_tree(path)
    return (tree["count"], _types(tree["root"]))


def _types(nodes) -> list:
    return [(node["type"], _types(node.get("children", []))) for node in nodes]


def _promote_header_row(src: str, out: str) -> dict:
    with pikepdf.open(src) as pdf:
        table = struct_audit_mod.tables(struct_audit_mod.audit_tree(pdf)["nodes"])[0]["table"]
        path = [int(v) for v in table.path]
    return struct_fix_mod.set_table_headers(src, out, path)


def _first_row_cells(path: str) -> object:
    with pikepdf.open(path) as pdf:
        found = struct_audit_mod.tables(struct_audit_mod.audit_tree(pdf)["nodes"])
        return [
            [
                (cell.role, str(cell.attrs.get("Scope", "")))
                for cell in struct_audit_mod.row_cells(table["rows"][0])
            ]
            for table in found
        ]


def _link_targets(path: str) -> object:
    return [row["target"] for row in links_mod.list_links(path)["links"]]


def _attachment_names(path: str) -> object:
    return [
        row["name"]
        for row in attachments_mod.list_attachments(path)["attachments"]
    ]


def _mrc_layers(path: str) -> object:
    with pikepdf.open(path) as pdf:
        return sorted(str(k) for k in pdf.pages[0].obj["/Resources"]["/XObject"].keys())


def _box(key: str) -> Callable[[str], object]:
    def read(path: str) -> object:
        with pikepdf.open(path) as pdf:
            value = pdf.pages[0].obj.get(key)
            return None if value is None else [round(float(v), 3) for v in value]
    return read


def _annot_count(path: str) -> object:
    return annotations_mod.list_annotations(path)["count"]


def _page_count(path: str) -> object:
    with pikepdf.open(path) as pdf:
        return len(pdf.pages)


def _rotations(path: str) -> object:
    with pikepdf.open(path) as pdf:
        return [int(page.obj.get("/Rotate", 0)) for page in pdf.pages]


def _xobjects(path: str) -> object:
    with pikepdf.open(path) as pdf:
        xobjects = pdf.pages[0].obj.get("/Resources", {}).get("/XObject")
        return [] if xobjects is None else sorted(str(k) for k in xobjects.keys())


def _text_of(path: str) -> object:
    return " ".join(extract_text(path)["text"].split())


def _layer_visibility(path: str) -> object:
    return [(row["index"], row["visible"]) for row in layers_mod.list_layers(path)["layers"]]


def _field_values(path: str) -> object:
    return {f["name"]: f.get("value") for f in forms_mod.read_form_fields(path)["fields"]}


def _widget_flags(path: str) -> object:
    with pikepdf.open(path) as pdf:
        return [int(a.get("/F", 0)) for a in pdf.pages[0].obj.get("/Annots", [])]


def _field_names(path: str) -> object:
    return sorted(f["name"] for f in forms_mod.read_form_fields(path)["fields"])


def _field_descriptions(path: str) -> object:
    return sorted(
        str(f.get("description") or "") for f in forms_mod.read_form_fields(path)["fields"]
    )


def _mark_count(path: str) -> object:
    return redact_marks_mod.list_redact_annotations(path)["count"]


CASES = (
    Case(
        "ocr_layer",
        ocr_layer_mod,
        _scanlike,
        lambda src, out: ocr_layer_mod.apply_ocr_layer(
            src, out, [{"page": 1, "words": OCR_WORDS}]),
        _ocr_effect,
    ),
    Case(
        "page_images",
        page_images_mod,
        _with_images,
        lambda src, out: page_images_mod.delete_page_image(src, out, page=1, index=0),
        _image_names,
    ),
    Case(
        "struct_tree",
        struct_tree_mod,
        _tagged,
        lambda src, out: struct_tree_mod.delete_struct_node(src, out, [0, 0]),
        _tag_types,
    ),
    Case(
        # `struct_fix` writes through `struct_tree._save`, so the module whose
        # `save_pdf` the death test replaces is `struct_tree`. A case per
        # WRITING module would leave this door uncovered, and a change to
        # `_save` that misses this caller crashes only here.
        "struct_fix",
        struct_tree_mod,
        _tagged_table,
        lambda src, out: _promote_header_row(src, out),
        _first_row_cells,
    ),
    Case(
        "links",
        links_mod,
        _with_links,
        lambda src, out: links_mod.set_link_url(
            src, out, page=1, index=0, url="https://moved.example"),
        _link_targets,
    ),
    Case(
        "attachments",
        attachments_mod,
        _with_attachment,
        lambda src, out: attachments_mod.remove_attachment(src, out, "payload.txt"),
        _attachment_names,
    ),
    Case(
        "mrc",
        mrc_mod,
        _scan_fixture,
        None,  # filled in below; the run needs the Ghostscript path
        _mrc_layers,
        needs_gs=True,
    ),
    Case(
        "annotations",
        annotations_mod,
        _with_comment,
        lambda src, out: annotations_mod.delete_all_annotations(src, out),
        _annot_count,
    ),
    Case(
        "content_crop",
        content_crop_mod,
        _with_text,
        lambda src, out: content_crop_mod.content_crop(src, out, box="crop", margin=6),
        _box("/CropBox"),
    ),
    Case(
        "delete",
        delete_mod,
        _blank,
        lambda src, out: delete_mod.delete(src, [2], out),
        _page_count,
    ),
    Case(
        "forms_visibility",
        forms_mod,
        _with_field,
        lambda src, out: forms_mod.set_widget_visibility(
            src, out, targets=["Full_name"], hide=True),
        _widget_flags,
    ),
    Case(
        "forms_fill",
        forms_mod,
        _with_field,
        lambda src, out: forms_mod.fill_form_fields(src, out, {"Full_name": "Ada"}),
        _field_values,
    ),
    Case(
        "form_authoring_add",
        form_authoring_mod,
        lambda path: _blank(path, pages=1),
        lambda src, out: form_authoring_mod.add_form_fields(src, out, [TEXT_FIELD]),
        _field_names,
    ),
    Case(
        "form_authoring_describe",
        form_authoring_mod,
        _with_field,
        lambda src, out: form_authoring_mod.set_field_description(
            src, out, field="Full_name", description="Legal name"),
        _field_descriptions,
    ),
    Case(
        "headers",
        headers_mod,
        _blank,
        lambda src, out: headers_mod.add_header_footer(
            src, out, [{"position": "bc", "text": "Page {page} of {pages}"}]),
        _text_of,
        # The stamp lands through `add_overlay`, whose resource name is random.
        deterministic=False,
    ),
    Case(
        "layers",
        layers_mod,
        _layered,
        lambda src, out: layers_mod.set_layer_visibility(src, out, index=0, visible=False),
        _layer_visibility,
    ),
    Case(
        "outline",
        outline_mod,
        _blank,
        lambda src, out: outline_mod.set_outline(src, [{"title": "Chapter", "page": 1}], out),
        lambda path: outline_mod.get_outline(path)["count"],
    ),
    Case(
        "page_boxes",
        page_boxes_mod,
        _blank,
        lambda src, out: page_boxes_mod.set_page_boxes(
            src, out, box="crop", top=10, bottom=10, left=10, right=10),
        _box("/CropBox"),
    ),
    Case(
        "page_labels",
        page_labels_mod,
        _blank,
        lambda src, out: page_labels_mod.set_page_labels(src, out, [{"start": 0, "style": "r"}]),
        lambda path: page_labels_mod.get_page_labels(path)["count"],
    ),
    Case(
        "printer_marks_add",
        printer_marks_mod,
        lambda path: _blank(path, pages=1, size=(400, 400)),
        lambda src, out: printer_marks_mod.add_printer_marks(
            src, out, marks=["crop"], timestamp=MARK_STAMP),
        _box("/MediaBox"),
    ),
    Case(
        "printer_marks_remove",
        printer_marks_mod,
        _marked,
        lambda src, out: printer_marks_mod.remove_printer_marks(src, out),
        _box("/MediaBox"),
    ),
    Case(
        "redact",
        redact_mod,
        _with_text,
        lambda src, out: redact_mod.redact(src, out, REDACT_REGION),
        _text_of,
    ),
    Case(
        "redact_marks",
        redact_marks_mod,
        _blank,
        lambda src, out: redact_marks_mod.save_redaction_marks(
            src, out, [{"page": 1, "rect": [20, 30, 120, 90]}]),
        _mark_count,
    ),
    Case(
        "rotate",
        rotate_mod,
        _blank,
        lambda src, out: rotate_mod.rotate(src, [1], 90, out),
        _rotations,
    ),
    Case(
        "watermark",
        watermark_mod,
        _blank,
        lambda src, out: watermark_mod.watermark(src, out, text="DRAFT"),
        # The name is random per run; how many forms the page draws is not.
        lambda path: len(_xobjects(path)),
        # The stamp lands through `add_overlay`, whose resource name is random.
        deterministic=False,
    ),
    Case(
        "xfdf",
        xfdf_mod,
        _with_xfdf,
        lambda src, out: xfdf_mod.import_xfdf(
            src, str(Path(src).parent / XFDF_NAME), out),
        _annot_count,
        leaves=(XFDF_NAME,),
    ),
)


@pytest.fixture(params=CASES, ids=lambda case: case.name)
def case(request, gs_path_or_none):
    subject = request.param
    if subject.needs_gs:
        if gs_path_or_none is None:
            pytest.skip("Ghostscript not available")
        return Case(
            subject.name, subject.module, subject.build,
            lambda src, out: mrc_mod.mrc_compress(src, out, gs_path=gs_path_or_none),
            subject.effect, leaves=subject.leaves,
            deterministic=subject.deterministic,
        )
    return subject


@pytest.fixture
def gs_path_or_none():
    """The bundled Ghostscript, or None — the shared `gs_path` fixture skips
    the whole test, which would skip the five cases that never call it."""
    path = FIXTURES.parent.parent / "resources" / "ghostscript" / "gswin64c.exe"
    return str(path) if path.is_file() else None


def _besides(directory: Path, *expected: str) -> list:
    return sorted(p.name for p in directory.iterdir() if p.name not in expected)


def _drawn(path: Path) -> list:
    """Every page's drawn content and every XObject it draws, with the
    resource NAMES canonicalized.

    `Page.add_overlay` names the form it adds with `Name.random`, so an op
    built on it writes a different name each run and cannot be compared byte
    for byte. Everything the name refers to still can be: the content stream
    that draws it (name substituted out) and the stream it points at.
    """
    pages = []
    with pikepdf.open(str(path)) as pdf:
        for page in pdf.pages:
            page.contents_coalesce()
            content = bytes(page.obj["/Contents"].read_bytes())
            xobjects = page.obj.get("/Resources", {}).get("/XObject")
            streams = []
            for index, (name, stream) in enumerate(sorted(
                (xobjects or {}).items(), key=lambda item: str(item[0])
            )):
                content = content.replace(str(name).encode("ascii"), b"/X%d" % index)
                streams.append(bytes(stream.read_bytes()))
            pages.append((content, streams))
    return pages


def _comparable(result) -> object:
    """A result minus the path it names — every other field is the claim."""
    if isinstance(result, dict):
        return {k: v for k, v in result.items() if k != "output"}
    return result


class TestWritingBackOverTheInput:
    def test_in_place_lands_what_a_distinct_output_lands(self, case, tmp_path):
        source = case.build(tmp_path / "source.pdf")
        control = tmp_path / "control.pdf"
        subject = tmp_path / "subject.pdf"
        shutil.copy2(source, subject)

        expected = case.run(str(source), str(control))
        result = case.run(str(subject), str(subject))

        assert _comparable(result) == _comparable(expected)
        if case.deterministic:
            assert subject.read_bytes() == control.read_bytes()
        else:
            assert _drawn(subject) == _drawn(control)
        assert case.effect(str(subject)) == case.effect(str(control))
        # The op has to have DONE something, or byte-identity is the identity
        # of two documents nothing happened to.
        assert case.effect(str(subject)) != case.effect(str(source))

    def test_the_write_leaves_nothing_staged_beside_the_document(self, case, tmp_path):
        source = case.build(tmp_path / "source.pdf")
        case.run(str(source), str(source))
        assert _besides(tmp_path, "source.pdf", *case.leaves) == []

    def test_a_write_that_dies_leaves_the_input_whole_and_nothing_staged(
        self, case, tmp_path, monkeypatch,
    ):
        source = case.build(tmp_path / "source.pdf")
        before = source.read_bytes()
        targets: list = []

        def die(_pdf, target, **_kwargs):
            targets.append(str(target))
            raise OSError("the volume went away mid-write")

        monkeypatch.setattr(case.module, "save_pdf", die)
        with pytest.raises(OSError):
            case.run(str(source), str(source))

        # The write that died was the STAGED one. Without this the assertions
        # below hold for a write that never began.
        assert targets and targets[0] != str(source)
        # The whole point of staging: the document the user still has open is
        # the document they had.
        assert source.read_bytes() == before
        assert _besides(tmp_path, "source.pdf", *case.leaves) == []

    def test_the_swap_replaces_the_name_and_never_writes_into_the_document(
        self, case, tmp_path,
    ):
        """The staged file lands by swapping a directory entry, so the bytes
        the user's document occupied are never opened for writing.

        A swap that COPIES opens them: for an in-place write the destination
        IS the document, so the copy fills it in chunks and a death inside
        that fill leaves a truncated file. A second name for the same file is
        how the difference is read without racing anything — after a swap it
        still holds the bytes it held, and after a copy it holds whatever the
        copy wrote.
        """
        source = case.build(tmp_path / "source.pdf")
        before = source.read_bytes()
        alias = tmp_path / "alias.pdf"
        try:
            os.link(str(source), str(alias))
        except (AttributeError, NotImplementedError, OSError) as exc:
            pytest.skip(f"this filesystem does not make hard links: {exc}")

        case.run(str(source), str(source))

        assert source.read_bytes() != before
        assert alias.read_bytes() == before


class TestOnePhysicalFileUnderTwoNames:
    """The identity that a string comparison cannot see.

    Windows spells one physical file several unresolvable ways (UNC versus
    mapped letter, hard links), so an output that resolves differently can
    still BE the input. Only a filesystem-identity test reaches the staged
    branch; a direct write there would go through the link and into the file
    pikepdf holds open.
    """

    def test_an_output_hardlinked_to_the_input_is_recognised_as_the_input(
        self, tmp_path,
    ):
        source = _with_images(tmp_path / "source.pdf")
        alias = tmp_path / "alias.pdf"
        try:
            os.link(str(source), str(alias))
        except (AttributeError, NotImplementedError, OSError) as exc:
            pytest.skip(f"this filesystem does not make hard links: {exc}")

        before = _image_names(str(source))
        page_images_mod.delete_page_image(str(source), str(alias), page=1, index=0)

        assert _image_names(str(alias)) != before
        # The staged file replaced the NAME. The other name still reading as
        # it did is what says the write did not go through the link into the
        # bytes pikepdf held open.
        assert _image_names(str(source)) == before
