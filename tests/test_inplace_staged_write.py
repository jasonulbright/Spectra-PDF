"""Writing back over the input, for every op that accepts `output == file`.

The panel hands the open document's path twice and the fixup chain feeds each
door the file the door before it wrote, so in place is the shape the real
callers use — not an edge case. Three properties are pinned for each op, as one
family rather than six coincidences:

  * in place lands what a distinct output lands, byte for byte;
  * a write that dies leaves the input whole and nothing staged beside it;
  * one physical file under two names is recognised as one file.

`save_pdf` derives the trailer `/ID` from the written bytes, so one input has
exactly one output — which makes "in place did the same thing" a byte
comparison rather than an assertion. The per-case `run` therefore has to be
deterministic; a case whose op is not would fail the first test here rather
than be quietly excluded.
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

from engine import attachments as attachments_mod
from engine import links as links_mod
from engine import mrc as mrc_mod
from engine import ocr_layer as ocr_layer_mod
from engine import page_images as page_images_mod
from engine import struct_tree as struct_tree_mod

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


def _scan_fixture(path: Path) -> Path:
    source = FIXTURES / "scan-text.pdf"
    if not source.is_file():
        pytest.skip("scan-text.pdf not generated (tests/fixtures/make_scans.py)")
    shutil.copy2(source, path)
    return path


# ── the ops ────────────────────────────────────────────────────────────────


OCR_WORDS = [{"text": "INVOICE", "rect": [40, 240, 140, 262]}]


@dataclass(frozen=True)
class Case:
    """One op that accepts `output == file`.

    `module` is the namespace whose `save_pdf` the death test replaces, so it
    has to be the module that performs the write rather than the one that
    defines it.
    """

    name: str
    module: object
    build: Callable[[Path], Path]
    run: Callable[[str, str], dict]
    effect: Callable[[str], object]
    needs_gs: bool = False


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
            subject.effect,
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
        assert subject.read_bytes() == control.read_bytes()
        assert case.effect(str(subject)) == case.effect(str(control))
        # The op has to have DONE something, or byte-identity is the identity
        # of two documents nothing happened to.
        assert case.effect(str(subject)) != case.effect(str(source))

    def test_the_write_leaves_nothing_staged_beside_the_document(self, case, tmp_path):
        source = case.build(tmp_path / "source.pdf")
        case.run(str(source), str(source))
        assert _besides(tmp_path, "source.pdf") == []

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
        assert _besides(tmp_path, "source.pdf") == []

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
