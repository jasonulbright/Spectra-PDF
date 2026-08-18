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
import sys
import zlib
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Callable

import pikepdf
import pytest
from pikepdf import Array, Dictionary, Name, String

from engine import annotations as annotations_mod
from engine import attachments as attachments_mod
from engine import budget as budget_mod
from engine import hairlines as hairlines_mod
from engine import compress as compress_mod
from engine import content_crop as content_crop_mod
from engine import delete as delete_mod
from engine import document_js as document_js_mod
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
from engine import page_vectors as page_vectors_mod
from engine import portfolio as portfolio_mod
from engine import printer_marks as printer_marks_mod
from engine import redact as redact_mod
from engine import redact_marks as redact_marks_mod
from engine import rotate as rotate_mod
from engine import pdfa as pdfa_mod
from engine import search_redact as search_redact_mod
from engine import struct_audit as struct_audit_mod
from engine import tag_content as tag_content_mod
from engine import text_authoring as text_authoring_mod
from engine import text_runs as text_runs_mod
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


def _with_filled_field(path: Path) -> Path:
    """A field carrying a value — what resetting one is offered on."""
    _with_field(path)
    forms_mod.fill_form_fields(str(path), str(path), {"Full_name": "Ada"})
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


#: What a placement op reads its picture from. Like the XFDF above, it sits
#: beside the document for the whole case and is declared on `Case.leaves`.
RAW_NAME = "add.raw"
SVG_NAME = "add.svg"
SVG_BODY = (
    b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50">'
    b'<rect x="0" y="0" width="100" height="50" fill="#3060c0"/></svg>'
)
PAYLOAD_NAME = "payload.txt"


def _raw_source(directory: Path) -> dict:
    (directory / RAW_NAME).write_bytes(bytes([200, 60, 60]) * 4)  # 2x2 RGB
    return {"raw_path": str(directory / RAW_NAME), "width": 2, "height": 2, "channels": 3}


def _blank_with_raw(path: Path) -> Path:
    _raw_source(path.parent)
    return _blank(path, pages=1, size=(612, 792))


def _images_with_raw(path: Path) -> Path:
    _raw_source(path.parent)
    return _with_images(path)


def _blank_with_svg(path: Path) -> Path:
    (path.parent / SVG_NAME).write_bytes(SVG_BODY)
    return _blank(path, pages=1, size=(612, 792))


def _blank_with_payload(path: Path) -> Path:
    (path.parent / PAYLOAD_NAME).write_bytes(b"hello attachment")
    return _blank(path, pages=1)


def _hairline_ladder(path: Path) -> Path:
    """Rules at every ladder width — what raising hairlines is offered on.
    Built by the hairline fixtures so the document the fix runs against here
    is the one it runs against there."""
    import hairline_builders

    hairline_builders.hairline_ladder_pdf(str(path))
    return path


#: The bundled text fonts an authoring op embeds from. Like Ghostscript they
#: are provisioned rather than checked in, so a case that needs them skips
#: rather than failing where they are absent.
FONTS_DIR = FIXTURES.parent.parent / "resources" / "fonts"

FDF_NAME = "data.fdf"


def _with_field_and_fdf(path: Path) -> Path:
    from engine.formdata import write_fdf

    _with_field(path)
    (path.parent / FDF_NAME).write_bytes(write_fdf({"Full_name": "Ada"}))
    return path


SIGNATURE_FIELD = {
    "name": "Approval", "type": "signature", "page_index": 0,
    "rect": [20, 200, 200, 260],
}


def _with_signature_field(path: Path) -> Path:
    plain = path.parent / "plain.pdf"
    _blank(plain, pages=1)
    form_authoring_mod.add_form_fields(str(plain), str(path), [SIGNATURE_FIELD])
    plain.unlink()
    return path


def _untagged_content(path: Path) -> Path:
    """A page whose text is drawn but bound to no structure — what binding
    page content to a tag is offered on."""
    import a11y_builders

    a11y_builders.ROSTER["untagged_content"][0](str(path))
    return path


def _tag_first_untagged_run(src: str, out: str) -> dict:
    """The door takes the RUN, so the run is resolved from the document the
    same way the panel resolves it."""
    runs = [
        row["index"]
        for row in text_runs_mod.list_text_runs(src, 1)["runs"]
        if row.get("mcid") is None
    ]
    return tag_content_mod.tag_page_content(src, out, 1, [{"run": runs[0]}], "P")


MEMBER_NAME = "member.bin"


def _portfolio_with_member(path: Path) -> Path:
    """A portfolio carrying one member, and a disk file to replace it with."""
    (path.parent / MEMBER_NAME).write_bytes(b"replacement bytes")
    _with_attachment(path)
    portfolio_mod.make_portfolio(str(path), str(path))
    return path


def _with_vectors(path: Path) -> Path:
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(612, 792))
    page.Contents = pdf.make_stream(
        b"50 50 100 80 re f\n"
        b"0 0 1 RG 200 200 m 300 250 l 260 300 l S\n"
        b"400 400 30 30 re f\n"
    )
    pdf.save(str(path))
    pdf.close()
    return path


def _with_url_text(path: Path) -> Path:
    """Text a URL can be recognised in — what the derive-links door reads."""
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(300, 400))
    font = pdf.make_indirect(Dictionary(
        Type=Name.Font, Subtype=Name.Type1,
        BaseFont=Name("/Helvetica"), Encoding=Name("/WinAnsiEncoding"),
    ))
    page.obj["/Resources"] = Dictionary(Font=Dictionary(F1=font))
    page.Contents = pdf.make_stream(
        b"BT /F1 12 Tf 20 300 Td (Visit https://example.com today) Tj ET")
    pdf.save(str(path))
    pdf.close()
    return path


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

    `doors` names the registered engine doors this case drives, which is what
    the coverage guard counts. It is a tuple because one case can only claim
    the doors it actually calls: a case that reaches its writer some other way
    claims none, and the door it does not drive stays uncovered.

    `run_gs` replaces `run` for a case whose op needs the bundled Ghostscript;
    it takes the interpreter's path as a third argument.

    `varies` names result fields that are a function of the RUN rather than of
    the input — a byte count an external producer's own timestamp moves. Every
    other field of the result is still compared.

    `dies` names the producer the death test replaces and `staged_of` reads the
    path that producer was told to write. Both default to a `save_pdf` whose
    second argument is that path — the shape every pikepdf-backed op has. An op
    whose producer is Ghostscript names `budget.gs` instead, and reads the
    staged path out of the command line it was handed.
    """

    name: str
    module: object
    build: Callable[[Path], Path]
    run: Callable[[str, str], dict]
    effect: Callable[[str], object]
    doors: tuple = ()
    needs_gs: bool = False
    needs_fonts: bool = False
    leaves: tuple = ()
    deterministic: bool = True
    run_gs: Callable[[str, str, str], dict] | None = None
    dies_on: object = None
    dies: str = "save_pdf"
    staged_of: Callable[[tuple], str] = None
    varies: tuple = ()


def _second_argument(args: tuple) -> str:
    """`save_pdf(pdf, target)` — the target is what it was told to write."""
    return str(args[1])


def _gs_output_file(args: tuple) -> str:
    """Ghostscript is handed one command line; the file it will write is the
    `-sOutputFile=` operand in it."""
    for token in args[0]:
        if str(token).startswith("-sOutputFile="):
            return str(token).split("=", 1)[1]
    return ""


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


def _link_rects(path: str) -> object:
    return [row["rect"] for row in links_mod.list_links(path)["links"]]


def _link_appearances(path: str) -> object:
    return [row["appearance"] for row in links_mod.list_links(path)["links"]]


def _placements(path: str) -> object:
    """Every picture the page draws, with everything the lister reads about
    it — one reader for the whole placement family, so a case never pins a
    narrower claim than the op makes."""
    return page_images_mod.list_page_images(path, 1)["images"]


def _vectors(path: str) -> object:
    return page_vectors_mod.list_page_vectors(path, 1)["vectors"]


def _member_sizes(path: str) -> object:
    return sorted(
        (row["name"], row["size"])
        for row in attachments_mod.list_attachments(path)["attachments"]
    )


def _document_scripts(path: str) -> object:
    return [
        (row["name"], row["js"])
        for row in document_js_mod.list_document_js(path)["scripts"]
    ]


def _field_actions(path: str) -> object:
    with pikepdf.open(path) as pdf:
        return [
            sorted(str(k) for k in (annot.get("/AA") or {}).keys())
            for annot in pdf.pages[0].obj.get("/Annots", [])
        ]


def _field_locks(path: str) -> object:
    with pikepdf.open(path) as pdf:
        return [
            str(annot.get("/Lock")) for annot in pdf.pages[0].obj.get("/Annots", [])
        ]


def _text_run_rows(path: str) -> object:
    return text_runs_mod.list_text_runs(path, 1)["runs"]


def _hairline_count(path: str) -> object:
    return hairlines_mod.list_hairlines(path)["count"]


def _producer(path: str) -> object:
    """Who wrote the document — what a rewrite through an external producer
    changes and a document nothing happened to does not."""
    with pikepdf.open(path) as pdf:
        return str(pdf.docinfo.get("/Producer", ""))


def _portfolio_shape(path: str) -> object:
    portfolio = portfolio_mod.get_portfolio(path)
    return (portfolio["is_portfolio"], sorted(m["name"] for m in portfolio["members"]))


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
        doors=("apply_ocr_layer",),
    ),
    Case(
        "page_images",
        page_images_mod,
        _with_images,
        lambda src, out: page_images_mod.delete_page_image(src, out, page=1, index=0),
        _image_names,
        doors=("delete_page_image",),
    ),
    Case(
        "page_images_delete_many",
        page_images_mod,
        _with_images,
        lambda src, out: page_images_mod.delete_page_images(src, out, 1, [0, 1]),
        _placements,
        doors=("delete_page_images",),
    ),
    Case(
        "page_images_transform",
        page_images_mod,
        _with_images,
        lambda src, out: page_images_mod.transform_page_image(
            src, out, 1, 0, [100, 0, 0, 80, 150, 650]),
        _placements,
        doors=("transform_page_image",),
    ),
    Case(
        "page_images_transform_many",
        page_images_mod,
        _with_images,
        lambda src, out: page_images_mod.transform_page_images(
            src, out, 1, [{"index": 0, "matrix": [100, 0, 0, 80, 150, 650]}]),
        _placements,
        doors=("transform_page_images",),
    ),
    Case(
        "page_images_crop",
        page_images_mod,
        _with_images,
        lambda src, out: page_images_mod.crop_page_image(
            src, out, 1, 0, [0.25, 0.25, 0.75, 0.75]),
        _placements,
        doors=("crop_page_image",),
    ),
    Case(
        "page_images_opacity",
        page_images_mod,
        _with_images,
        lambda src, out: page_images_mod.set_image_opacity(src, out, 1, 0, opacity=0.4),
        _placements,
        doors=("set_image_opacity",),
    ),
    Case(
        "page_images_add",
        page_images_mod,
        _blank_with_raw,
        lambda src, out: page_images_mod.add_page_image(
            src, out, 1, [100, 500, 300, 650],
            {"raw_path": str(Path(src).parent / RAW_NAME),
             "width": 2, "height": 2, "channels": 3}),
        _placements,
        doors=("add_page_image",),
        leaves=(RAW_NAME,),
    ),
    Case(
        "page_images_replace",
        page_images_mod,
        _images_with_raw,
        lambda src, out: page_images_mod.replace_page_image(
            src, out, 1, 0,
            {"raw_path": str(Path(src).parent / RAW_NAME),
             "width": 2, "height": 2, "channels": 3}),
        _placements,
        doors=("replace_page_image",),
        leaves=(RAW_NAME,),
    ),
    Case(
        "page_images_add_vector",
        page_images_mod,
        _blank_with_svg,
        lambda src, out: page_images_mod.add_page_vector_graphic(
            src, out, 1, rect=[100, 100, 300, 300],
            svg_path=str(Path(src).parent / SVG_NAME)),
        _placements,
        doors=("add_page_vector_graphic",),
        leaves=(SVG_NAME,),
    ),
    Case(
        # The vector editors write through `page_images._save`, so the module
        # whose `save_pdf` the death test replaces is `page_images`.
        "page_vectors_delete",
        page_images_mod,
        _with_vectors,
        lambda src, out: page_vectors_mod.delete_page_vector(src, out, 1, 1),
        _vectors,
        doors=("delete_page_vector",),
    ),
    Case(
        "page_vectors_transform",
        page_images_mod,
        _with_vectors,
        lambda src, out: page_vectors_mod.transform_page_vector(
            src, out, 1, 0, [100.0, 0.0, 0.0, 60.0, 150.0, 80.0]),
        _vectors,
        doors=("transform_page_vector",),
    ),
    Case(
        "page_vectors_restyle",
        page_images_mod,
        _with_vectors,
        lambda src, out: page_vectors_mod.restyle_page_vector(
            src, out, 1, 0, fill=[0, 1, 0]),
        _vectors,
        doors=("restyle_page_vector",),
    ),
    Case(
        "struct_tree",
        struct_tree_mod,
        _tagged,
        lambda src, out: struct_tree_mod.delete_struct_node(src, out, [0, 0]),
        _tag_types,
        doors=("delete_struct_node",),
    ),
    Case(
        "struct_tree_props",
        struct_tree_mod,
        _tagged,
        lambda src, out: struct_tree_mod.set_struct_props(src, out, [0, 0], {"type": "H2"}),
        _tag_types,
        doors=("set_struct_props",),
    ),
    Case(
        "struct_tree_add",
        struct_tree_mod,
        _tagged,
        lambda src, out: struct_tree_mod.add_struct_node(src, out, [0], "P"),
        _tag_types,
        doors=("add_struct_node",),
    ),
    Case(
        "struct_tree_move",
        struct_tree_mod,
        _tagged,
        lambda src, out: struct_tree_mod.move_struct_node(src, out, [0, 0], "down"),
        _tag_types,
        doors=("move_struct_node",),
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
        doors=("set_table_headers",),
    ),
    Case(
        "links",
        links_mod,
        _with_links,
        lambda src, out: links_mod.set_link_url(
            src, out, page=1, index=0, url="https://moved.example"),
        _link_targets,
        doors=("set_link_url",),
    ),
    Case(
        "links_target",
        links_mod,
        _with_links,
        lambda src, out: links_mod.set_link_target(
            src, out, page=1, index=0,
            target={"kind": "uri", "url": "https://retargeted.example"}),
        _link_targets,
        doors=("set_link_target",),
    ),
    Case(
        "links_appearance",
        links_mod,
        _with_links,
        lambda src, out: links_mod.set_link_appearance(
            src, out, page=1, index=0,
            appearance={"width": 3, "style": "dashed", "color": [0, 0, 1]}),
        _link_appearances,
        doors=("set_link_appearance",),
    ),
    Case(
        "links_rect",
        links_mod,
        _with_links,
        lambda src, out: links_mod.set_link_rect(
            src, out, page=1, index=0, rect=[200, 300, 120, 250]),
        _link_rects,
        doors=("set_link_rect",),
    ),
    Case(
        "links_delete",
        links_mod,
        _with_links,
        lambda src, out: links_mod.delete_link(src, out, page=1, index=0),
        _link_targets,
        doors=("delete_link",),
    ),
    Case(
        "links_add",
        links_mod,
        _with_links,
        lambda src, out: links_mod.add_links(src, out, links=[
            {"page": 1, "rect": [20, 200, 120, 216], "url": "https://added.example"}]),
        _link_targets,
        doors=("add_links",),
    ),
    Case(
        "links_from_urls",
        links_mod,
        _with_url_text,
        lambda src, out: links_mod.create_links_from_urls(src, out),
        _link_targets,
        doors=("create_links_from_urls",),
    ),
    Case(
        "attachments",
        attachments_mod,
        _with_attachment,
        lambda src, out: attachments_mod.remove_attachment(src, out, "payload.txt"),
        _attachment_names,
        doors=("remove_attachment",),
    ),
    Case(
        "attachments_add",
        attachments_mod,
        _blank_with_payload,
        lambda src, out: attachments_mod.add_attachment(
            src, out, str(Path(src).parent / PAYLOAD_NAME)),
        _attachment_names,
        doors=("add_attachment",),
        leaves=(PAYLOAD_NAME,),
    ),
    Case(
        # A portfolio is written through `attachments._save`, so the module
        # whose `save_pdf` the death test replaces is `attachments`.
        "portfolio_make",
        attachments_mod,
        lambda path: _blank(path, pages=1),
        lambda src, out: portfolio_mod.make_portfolio(src, out),
        _portfolio_shape,
        doors=("make_portfolio",),
    ),
    Case(
        # The case drives `mrc_compress` itself rather than the `compress`
        # door that reaches it, so it claims no door; `compress` carries its
        # own case below.
        "mrc",
        mrc_mod,
        _scan_fixture,
        None,  # filled in below; the run needs the Ghostscript path
        _mrc_layers,
        needs_gs=True,
        run_gs=lambda src, out, gs: mrc_mod.mrc_compress(src, out, gs_path=gs),
    ),
    Case(
        "annotations",
        annotations_mod,
        _with_comment,
        lambda src, out: annotations_mod.delete_all_annotations(src, out),
        _annot_count,
        doors=("delete_all_annotations",),
    ),
    Case(
        "content_crop",
        content_crop_mod,
        _with_text,
        lambda src, out: content_crop_mod.content_crop(src, out, box="crop", margin=6),
        _box("/CropBox"),
        doors=("content_crop",),
    ),
    Case(
        "delete",
        delete_mod,
        _blank,
        lambda src, out: delete_mod.delete(src, [2], out),
        _page_count,
        doors=("delete",),
    ),
    Case(
        "forms_visibility",
        forms_mod,
        _with_field,
        lambda src, out: forms_mod.set_widget_visibility(
            src, out, targets=["Full_name"], hide=True),
        _widget_flags,
        doors=("set_widget_visibility",),
    ),
    Case(
        "forms_fill",
        forms_mod,
        _with_field,
        lambda src, out: forms_mod.fill_form_fields(src, out, {"Full_name": "Ada"}),
        _field_values,
        doors=("fill_form_fields",),
    ),
    Case(
        "forms_reset",
        forms_mod,
        _with_filled_field,
        lambda src, out: forms_mod.reset_form_fields(src, out),
        _field_values,
        doors=("reset_form_fields",),
    ),
    Case(
        # `add_form_fields` is an authoring primitive the `create_detected_fields`
        # door writes through, not a door itself, so this case claims none —
        # that door hands it a different argument shape and needs its own case.
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
        doors=("set_field_description",),
    ),
    Case(
        "headers",
        headers_mod,
        _blank,
        lambda src, out: headers_mod.add_header_footer(
            src, out, [{"position": "bc", "text": "Page {page} of {pages}"}]),
        _text_of,
        doors=("add_header_footer",),
        # The stamp lands through `add_overlay`, whose resource name is random.
        deterministic=False,
    ),
    Case(
        "layers",
        layers_mod,
        _layered,
        lambda src, out: layers_mod.set_layer_visibility(src, out, index=0, visible=False),
        _layer_visibility,
        doors=("set_layer_visibility",),
    ),
    Case(
        "outline",
        outline_mod,
        _blank,
        lambda src, out: outline_mod.set_outline(src, [{"title": "Chapter", "page": 1}], out),
        lambda path: outline_mod.get_outline(path)["count"],
        doors=("set_outline",),
    ),
    Case(
        "page_boxes",
        page_boxes_mod,
        _blank,
        lambda src, out: page_boxes_mod.set_page_boxes(
            src, out, box="crop", top=10, bottom=10, left=10, right=10),
        _box("/CropBox"),
        doors=("set_page_boxes",),
    ),
    Case(
        "page_labels",
        page_labels_mod,
        _blank,
        lambda src, out: page_labels_mod.set_page_labels(src, out, [{"start": 0, "style": "r"}]),
        lambda path: page_labels_mod.get_page_labels(path)["count"],
        doors=("set_page_labels",),
    ),
    Case(
        "printer_marks_add",
        printer_marks_mod,
        lambda path: _blank(path, pages=1, size=(400, 400)),
        lambda src, out: printer_marks_mod.add_printer_marks(
            src, out, marks=["crop"], timestamp=MARK_STAMP),
        _box("/MediaBox"),
        doors=("add_printer_marks",),
    ),
    Case(
        "printer_marks_remove",
        printer_marks_mod,
        _marked,
        lambda src, out: printer_marks_mod.remove_printer_marks(src, out),
        _box("/MediaBox"),
        doors=("remove_printer_marks",),
    ),
    Case(
        "redact",
        redact_mod,
        _with_text,
        lambda src, out: redact_mod.redact(src, out, REDACT_REGION),
        _text_of,
        doors=("redact",),
    ),
    Case(
        # Searching produces the regions; the WRITE is the redact door it
        # then calls, so that is the module the death test replaces.
        "search_redact",
        redact_mod,
        _with_text,
        lambda src, out: search_redact_mod.search_and_redact(
            src, out, query="CONFIDENTIAL"),
        _text_of,
        doors=("search_and_redact",),
    ),
    Case(
        "redact_marks",
        redact_marks_mod,
        _blank,
        lambda src, out: redact_marks_mod.save_redaction_marks(
            src, out, [{"page": 1, "rect": [20, 30, 120, 90]}]),
        _mark_count,
        doors=("save_redaction_marks",),
    ),
    Case(
        "rotate",
        rotate_mod,
        _blank,
        lambda src, out: rotate_mod.rotate(src, [1], 90, out),
        _rotations,
        doors=("rotate",),
    ),
    Case(
        "watermark",
        watermark_mod,
        _blank,
        lambda src, out: watermark_mod.watermark(src, out, text="DRAFT"),
        # The name is random per run; how many forms the page draws is not.
        lambda path: len(_xobjects(path)),
        doors=("watermark",),
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
        doors=("import_xfdf",),
        leaves=(XFDF_NAME,),
    ),
    Case(
        # `text_runs` writes through `page_images._save`, so the module whose
        # `save_pdf` the death test replaces is `page_images`.
        "text_runs_replace",
        page_images_mod,
        _with_text,
        lambda src, out: text_runs_mod.replace_text_run(src, out, 1, 0, "REDACTED"),
        _text_of,
        doors=("replace_text_run",),
    ),
    Case(
        "text_runs_restyle",
        page_images_mod,
        _with_text,
        lambda src, out: text_runs_mod.restyle_text_run(src, out, 1, 0, size=18),
        _text_run_rows,
        doors=("restyle_text_run",),
    ),
    Case(
        # `hairlines` writes through `page_images._save` as well.
        "hairlines",
        page_images_mod,
        _hairline_ladder,
        lambda src, out: hairlines_mod.fix_hairlines(src, out),
        _hairline_count,
        doors=("fix_hairlines",),
    ),
    Case(
        "portfolio_update_member",
        attachments_mod,
        _portfolio_with_member,
        lambda src, out: portfolio_mod.update_portfolio_member(
            src, out, "payload.txt", str(Path(src).parent / MEMBER_NAME)),
        _member_sizes,
        doors=("update_portfolio_member",),
        leaves=(MEMBER_NAME,),
    ),
    Case(
        "forms_import_data",
        forms_mod,
        _with_field_and_fdf,
        lambda src, out: forms_mod.import_form_data(
            src, out, data=str(Path(src).parent / FDF_NAME)),
        _field_values,
        doors=("import_form_data",),
        leaves=(FDF_NAME,),
    ),
    Case(
        "form_authoring_actions",
        form_authoring_mod,
        _with_field,
        lambda src, out: form_authoring_mod.set_field_actions(
            src, out, field="Full_name",
            format={"kind": "number", "decimals": 2, "sep_style": 0,
                    "neg_style": 0, "currency": "", "currency_prepend": True}),
        _field_actions,
        doors=("set_field_actions",),
    ),
    Case(
        "form_authoring_lock",
        form_authoring_mod,
        _with_signature_field,
        lambda src, out: form_authoring_mod.set_field_lock(src, out, "Approval", "all"),
        _field_locks,
        doors=("set_field_lock",),
    ),
    Case(
        "tag_content",
        tag_content_mod,
        _untagged_content,
        _tag_first_untagged_run,
        _tag_types,
        doors=("tag_page_content",),
    ),
    Case(
        # `text_authoring` writes through `page_images._save` too.
        "text_authoring",
        page_images_mod,
        lambda path: _blank(path, pages=1, size=(612, 792)),
        lambda src, out: text_authoring_mod.add_text_box(
            src, out, 1, [72, 680, 400, 720], "Authored line",
            font_path=str(FONTS_DIR)),
        _text_of,
        doors=("add_text_box",),
        needs_fonts=True,
    ),
    Case(
        "document_js",
        document_js_mod,
        _blank,
        lambda src, out: document_js_mod.set_document_js(
            src, out, [{"name": "Greet", "js": "app.alert('hi');"}]),
        _document_scripts,
        doors=("set_document_js",),
    ),
    Case(
        "convert_pdfa",
        pdfa_mod,
        _with_text,
        None,  # filled in below; the run needs the Ghostscript path
        _producer,
        doors=("convert_pdfa",),
        needs_gs=True,
        run_gs=lambda src, out, gs: pdfa_mod.convert_pdfa(src, out, gs_path=gs),
        dies_on=budget_mod,
        dies="gs",
        staged_of=_gs_output_file,
        # The stamped clock moves the byte count; nothing else about the
        # result is a function of the run.
        varies=("output_size",),
        # Ghostscript stamps the run's own clock into the document info.
        deterministic=False,
    ),
    Case(
        "compress",
        compress_mod,
        _with_images,
        None,  # filled in below; the run needs the Ghostscript path
        _placements,
        doors=("compress",),
        needs_gs=True,
        run_gs=lambda src, out, gs: compress_mod.compress(
            src, out, quality="ebook", gs_path=gs),
        # The stamped clock moves the byte count; nothing else about the
        # result is a function of the run.
        varies=("compressed_size",),
        dies_on=budget_mod,
        dies="gs",
        staged_of=_gs_output_file,
        # Ghostscript stamps the run's own clock into the document info, so
        # two runs of one input differ in the second they ran.
        deterministic=False,
    ),
)


@pytest.fixture(params=CASES, ids=lambda case: case.name)
def case(request, gs_path_or_none):
    subject = request.param
    if subject.needs_fonts and not (FONTS_DIR / "LiberationSans-Regular.ttf").is_file():
        pytest.skip("bundled fonts not provisioned")
    if subject.needs_gs:
        if gs_path_or_none is None:
            pytest.skip("Ghostscript not available")
        runner = subject.run_gs
        return replace(
            subject,
            run=lambda src, out: runner(src, out, gs_path_or_none),
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


def _hardlink(source: Path, alias: Path) -> Path:
    """A second name for one physical file, or a skip where the filesystem
    has no such thing."""
    try:
        os.link(str(source), str(alias))
    except (AttributeError, NotImplementedError, OSError) as exc:
        pytest.skip(f"this filesystem does not make hard links: {exc}")
    return alias


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


def _comparable(result, varies: tuple = ()) -> object:
    """A result minus the path it names and minus what the RUN decides —
    every other field is the claim."""
    if isinstance(result, dict):
        skip = {"output", *varies}
        return {k: v for k, v in result.items() if k not in skip}
    return result


class TestWritingBackOverTheInput:
    def test_in_place_lands_what_a_distinct_output_lands(self, case, tmp_path):
        source = case.build(tmp_path / "source.pdf")
        control = tmp_path / "control.pdf"
        subject = tmp_path / "subject.pdf"
        shutil.copy2(source, subject)

        expected = case.run(str(source), str(control))
        result = case.run(str(subject), str(subject))

        assert _comparable(result, case.varies) == _comparable(expected, case.varies)
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

        def die(*args, **_kwargs):
            targets.append((case.staged_of or _second_argument)(args))
            raise OSError("the volume went away mid-write")

        monkeypatch.setattr(case.dies_on or case.module, case.dies, die)
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
        alias = _hardlink(source, tmp_path / "alias.pdf")

        case.run(str(source), str(source))

        assert source.read_bytes() != before
        assert alias.read_bytes() == before

    def test_a_write_cancelled_mid_flight_leaves_nothing_staged(
        self, case, tmp_path, monkeypatch,
    ):
        """Cancellation is not an `Exception`. A scope that cleans up on
        `except Exception` lets `KeyboardInterrupt` past with the completed
        temp file still sitting beside the user's document — and the interrupt
        itself must still arrive, so the caller stops."""
        source = case.build(tmp_path / "source.pdf")
        before = source.read_bytes()

        def cancel(*args, **_kwargs):
            target = (case.staged_of or _second_argument)(args)
            if target:
                Path(target).write_bytes(b"%PDF-1.7\n% staged and then cancelled\n")
            raise KeyboardInterrupt

        monkeypatch.setattr(case.dies_on or case.module, case.dies, cancel)
        with pytest.raises(KeyboardInterrupt):
            case.run(str(source), str(source))

        assert source.read_bytes() == before
        assert _besides(tmp_path, "source.pdf", *case.leaves) == []


class TestOnePhysicalFileUnderTwoNames:
    """The identity that a string comparison cannot see — and the BRANCH it
    decides.

    Windows spells one physical file several unresolvable ways (UNC versus
    mapped letter, hard links), so an output that resolves differently can
    still BE the input. Only a filesystem-identity test reaches the staged
    branch; a direct write there would go through the link and into the file
    pikepdf holds open.

    The other alias tests hand an op one path twice, so the same-file test
    answers yes on the spelling alone and the alias only READS — they pin the
    SWAP and never the routing. Handing the op the alias as its output is the
    routing question, and it is asked of every case rather than of one, because
    the same-file test is one shared predicate and a regression in it is a
    regression in all of them at once.
    """

    def test_an_output_hardlinked_to_the_input_routes_through_staging(
        self, case, tmp_path,
    ):
        source = case.build(tmp_path / "source.pdf")
        before_bytes = source.read_bytes()
        before = case.effect(str(source))
        alias = _hardlink(source, tmp_path / "alias.pdf")

        case.run(str(source), str(alias))

        # The op landed at the name it was given.
        assert case.effect(str(alias)) != before
        # The staged file replaced the NAME. The other name still reading as
        # it did is what says the write did not go through the link into the
        # bytes pikepdf held open.
        assert source.read_bytes() == before_bytes
        assert _besides(tmp_path, "source.pdf", "alias.pdf", *case.leaves) == []


# ── the coverage guard ─────────────────────────────────────────────────────
#
# The two families above enumerate their cases BY HAND, and a hand-written
# enumeration cannot notice a door nobody thought of.
#
# The failure mode is concrete. A door in one module can write through a
# private `_save` defined in another: `set_table_headers` through
# `struct_tree`, `make_portfolio` and `update_portfolio_member` through
# `attachments`. A change to that helper's signature is checked against the
# defining module's own suite, which passes, and the cross-module caller
# raises `TypeError` on every call — reachable only through a door nothing
# exercises.
#
# So the roster below is checked against the engine's own registrations rather
# than against itself: every door that accepts writing over its own input is
# cased here, cased in the `finish_staged` family, or named in one of the two
# tables — never absent.


import test_inplace_finish_staged as finish_staged  # noqa: E402
from inplace_doors import registered_doors, same_path_capable  # noqa: E402

#: Doors whose output is genuinely never the document they were handed. Each
#: says why in its own terms; "no case yet" is never one of these.
EXCLUDED_DOORS = {
    "create_pdf": (
        "builds a NEW document out of non-PDF sources, so no argument of it "
        "names a document the output could overwrite"
    ),
    "create_pdf_folders": (
        "the same build, walked over a folder: it reads images and office "
        "files and writes PDFs beside them, never over an input"
    ),
    "distill": (
        "its input is a PostScript file and its output a PDF; the door "
        "refuses an output resolving to the input outright"
    ),
    "export_document": (
        "writes a Word, Excel or PowerPoint file — the output is a different "
        "format from the document it was handed and can never be it"
    ),
    "unlock": (
        "has no `output` at all: it always rewrites the file it was given, so "
        "there is no distinct-output run to compare an in-place run against. "
        "Its rewrite is pinned by tests/test_engine.py"
    ),
}

#: Doors that DO accept writing over their input and have no case here yet —
#: a recorded gap, not a disposition. Each says what a case for it needs, so
#: the next lane can pick one up; the guard fails if one is added or if one is
#: cased and left behind.
UNCASED_DOORS = {
    "alias_ink": "needs a document carrying spot-colour separations",
    "spot_to_process": "needs a document carrying spot-colour separations",
    "assign_trap_presets": "needs an authored trapping setup to assign",
    "author_choice_appearance": "needs a list or combo field to redraw",
    "author_vertical_field_font": (
        "needs a vertical-script field and the bundled text fonts"
    ),
    "convert_text_run": "needs a font file to convert the run into",
    "create_detected_fields": "needs the field detector's candidate rows",
    "encrypt_pubkey": "needs a recipient certificate",
    "decrypt_pubkey": "needs a certificate and the PFX holding its key",
    "enhance_scan": "needs Ghostscript and a scanned page to enhance",
    "flatten_transparency": "needs Ghostscript and an authored transparency group",
    "merge_paragraph_with_previous": (
        "needs the paragraph lister's expected-runs and expected-text arguments"
    ),
    "replace_paragraph_text": (
        "needs the paragraph lister's expected-runs and expected-text arguments"
    ),
    "ocr_file": "needs Tesseract",
    "prepare_form_fields": "needs Tesseract",
    "batch_ocr": (
        "a folder walk rather than a (file, output) door; its in-place mode "
        "is pinned by tests/test_batch_ocr_tails.py"
    ),
    "run_action": (
        "a folder walk rather than a (file, output) door; its in-place mode "
        "is pinned by tests/test_guided_actions.py"
    ),
    "run_preflight_sweep": (
        "a folder walk rather than a (file, output) door"
    ),
    "sign_pdf": (
        "stages by hand and gates in-place behind `allow_in_place`; that mode "
        "is pinned by tests/test_engine.py"
    ),
    "transplant_incremental": (
        "takes an original AND a modified document, so 'the input' is two "
        "files; its writes are pinned by tests/test_certification.py"
    ),
}

#: Grayscale's op is driven by `TestTheProducerShapedStaging` in the
#: `finish_staged` family rather than by a `Case`, because its staging is
#: conditional on the target rather than on a save call.
DOORS_CASED_OUTSIDE_THE_TABLES = {"grayscale"}


def _cased_doors() -> set:
    return (
        {door for case in CASES for door in case.doors}
        | {door for case in finish_staged.CASES for door in case.doors}
        | DOORS_CASED_OUTSIDE_THE_TABLES
    )


class TestEveryInPlaceDoorIsAccountedFor:
    """The inventory is the engine's, not this file's."""

    def test_the_inventory_is_read_and_is_not_empty(self):
        """A guard over an empty inventory passes for the wrong reason — it
        would pass just as well if the walk stopped resolving names."""
        capable = same_path_capable()
        assert len(capable) > 50, capable
        # The door the lesson came from, and the two that repeated it.
        for door in ("set_table_headers", "make_portfolio", "update_portfolio_member"):
            assert door in capable

    def test_every_same_path_door_is_cased_or_named(self):
        uncovered = sorted(
            set(same_path_capable())
            - _cased_doors()
            - set(EXCLUDED_DOORS)
            - set(UNCASED_DOORS)
        )
        assert uncovered == [], (
            "these engine doors accept writing over their own input and no "
            "in-place case exercises them: "
            + ", ".join(uncovered)
            + " — add a Case to tests/test_inplace_staged_write.py or "
            "tests/test_inplace_finish_staged.py, or name the door in "
            "EXCLUDED_DOORS with the reason its output can never be its input."
        )

    def test_a_door_that_gained_a_case_leaves_the_roster(self):
        """A stale roster entry is how a covered door goes on reading as a
        gap, and how an excluded one keeps an exclusion it no longer earns."""
        cased = _cased_doors()
        assert sorted(cased & set(UNCASED_DOORS)) == []
        assert sorted(cased & set(EXCLUDED_DOORS)) == []

    def test_every_name_in_the_tables_is_a_door_the_engine_registers(self):
        """A typo, or a door that was renamed or removed, would otherwise sit
        in a table forever excusing nothing."""
        registered = set(registered_doors())
        named = set(EXCLUDED_DOORS) | set(UNCASED_DOORS) | _cased_doors()
        assert sorted(named - registered) == []

    def test_every_door_a_case_claims_accepts_writing_over_its_input(self):
        """A case that claims a door the engine does not stage for is either
        naming the wrong door or covering nothing."""
        capable = set(same_path_capable())
        assert sorted(_cased_doors() - capable) == []

    def test_no_uncased_door_is_also_excluded(self):
        assert sorted(set(UNCASED_DOORS) & set(EXCLUDED_DOORS)) == []


class TestTheGuardWouldHaveCaughtIt:
    """The guard is only worth its run if removing a case turns it red, and
    if what it says then is the name of the door to write.

    Both are checked against the doors the failure actually reached:
    `set_table_headers`, `make_portfolio` and `update_portfolio_member` each
    write through another module's `_save`, and each raised on every call for
    exactly as long as nothing exercised it.
    """

    def _uncovered_with(self, cases: tuple, monkeypatch) -> list:
        monkeypatch.setattr(sys.modules[__name__], "CASES", cases)
        return sorted(
            set(same_path_capable())
            - _cased_doors()
            - set(EXCLUDED_DOORS)
            - set(UNCASED_DOORS)
        )

    @pytest.mark.parametrize(
        "case_name, door",
        [
            ("struct_fix", "set_table_headers"),
            ("portfolio_make", "make_portfolio"),
            ("portfolio_update_member", "update_portfolio_member"),
        ],
    )
    def test_dropping_a_case_names_the_door_it_covered(
        self, case_name, door, monkeypatch,
    ):
        without = tuple(case for case in CASES if case.name != case_name)
        assert len(without) == len(CASES) - 1, f"no case named {case_name}"

        assert self._uncovered_with(without, monkeypatch) == [door]

        with pytest.raises(AssertionError) as raised:
            TestEveryInPlaceDoorIsAccountedFor().test_every_same_path_door_is_cased_or_named()
        assert door in str(raised.value)

    def test_the_inventory_is_what_makes_it_fail(self, monkeypatch):
        """The same subtraction with the inventory taken out passes on the
        very roster the real guard rejects — so the guard's verdict comes
        from the engine's registrations and not from the shape of the
        assertion."""
        without = tuple(case for case in CASES if case.name != "struct_fix")
        assert self._uncovered_with(without, monkeypatch) != []

        blind = sorted(set() - _cased_doors() - set(EXCLUDED_DOORS) - set(UNCASED_DOORS))
        assert blind == []
