"""Writing back over the input, for the ops that staged imperatively.

`test_inplace_staged_write` pins the same three properties for the ops that
already wrote through `staged_write`. These are the ops that instead held the
staged path in a local, wrote it, and landed it with a separate
`finish_staged` call — a shape with two failure modes the context manager does
not have:

  * `finish_staged` swapped with `shutil.move`, which on Windows degrades to a
    COPY when the destination exists. For an output that names its own input
    that copy runs INTO the document, so a death part-way through leaves the
    user's file truncated. The hard-link alias below is what reads the
    difference: after a directory-entry swap the second name still holds the
    bytes it held, after a copy it holds whatever the copy wrote.
  * Nothing owned the span between the staging and the swap, so a producer
    that died left the temp file sitting beside the document.

The ops are grouped by the shape their staging takes rather than covered one
by one:

  * `save` — one `save_pdf` into the staged path, the swap inside the block
    that holds the Pdf open. The close is load-bearing: `os.replace` onto a
    destination pikepdf still holds is `PermissionError` on Windows.
  * `nested` — the producer is another engine op, not a save.
  * `producer` — Ghostscript writes the staged path over seconds, and the
    staging is conditional: one variable is either the staged file or the
    output itself.
"""

import os
import shutil
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace
from typing import Callable

import pikepdf
import pytest

from engine import autotag as autotag_mod
from engine import derived_nav as derived_nav_mod
from engine import doc_properties as doc_properties_mod
from engine import encrypt as encrypt_mod
from engine import grayscale as grayscale_mod
from engine import metadata as metadata_mod
from engine import optimize as optimize_mod
from engine import sanitize as sanitize_mod
from engine import threads as threads_mod

FIXTURES = Path(__file__).resolve().parent / "fixtures"


# ── the documents ──────────────────────────────────────────────────────────


def _plain(path: Path) -> Path:
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(200, 200))
    pdf.save(str(path))
    pdf.close()
    return path


def _titled(path: Path) -> Path:
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(200, 200))
    with pdf.open_metadata() as meta:
        meta["dc:title"] = "before the write"
    pdf.save(str(path))
    pdf.close()
    return path


def _encrypted(path: Path) -> Path:
    plain = path.parent / "plain-source.pdf"
    _plain(plain)
    encrypt_mod.encrypt(str(plain), str(path), user_password="pw", owner_password="pw")
    plain.unlink()
    return path


def _text_and_figure(path: Path) -> Path:
    """A heading, two body lines and an image — enough for autotag to find
    both a heading role and a figure, which is what the ops built on it need
    to have DONE something."""
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(300, 400))
    page.Contents = pdf.make_stream(
        b"BT /F1 24 Tf 40 350 Td (StagedHeading) Tj ET\n"
        b"BT /F1 11 Tf 40 320 Td (Staged body one) Tj ET\n"
        b"BT /F1 11 Tf 40 300 Td (Staged body two) Tj ET\n"
        b"q 100 0 0 50 40 200 cm /Im0 Do Q\n"
    )
    font = pdf.make_indirect(
        pikepdf.Dictionary(
            Type=pikepdf.Name.Font,
            Subtype=pikepdf.Name.Type1,
            BaseFont=pikepdf.Name.Helvetica,
        )
    )
    image = pdf.make_stream(
        b"\x00",
        Type=pikepdf.Name.XObject,
        Subtype=pikepdf.Name.Image,
        Width=1,
        Height=1,
        BitsPerComponent=8,
        ColorSpace=pikepdf.Name.DeviceGray,
    )
    page.Resources = pikepdf.Dictionary(
        Font=pikepdf.Dictionary(F1=font),
        XObject=pikepdf.Dictionary(Im0=pdf.make_indirect(image)),
    )
    pdf.save(str(path))
    pdf.close()
    return path


# ── what each op is asked to have done ─────────────────────────────────────


def _lang(path: str) -> object:
    with pikepdf.open(path) as pdf:
        return str(pdf.Root.get("/Lang", ""))


def _trapped(path: str) -> object:
    return doc_properties_mod.get_advanced_properties(path)["trapped"]


def _encryption(path: str) -> object:
    """"encrypted" without reading the document — opening it needs the
    password, and the point is only whether one is still needed."""
    try:
        with pikepdf.open(path):
            return "plain"
    except pikepdf.PasswordError:
        return "encrypted"


def _title(path: str) -> object:
    return metadata_mod.get_metadata(path)["title"]


def _metadata_record(path: str) -> object:
    """Every field the reader exposes except the path it was read from — the
    whole claim, for the one op whose bytes cannot be compared."""
    return {k: v for k, v in metadata_mod.get_metadata(path).items() if k != "file"}


def _linearized(path: str) -> object:
    return b"/Linearized" in Path(path).read_bytes()[:2048]


def _struct_count(path: str) -> object:
    with pikepdf.open(path) as pdf:
        return pdf.Root.get("/StructTreeRoot") is not None


def _thread_count(path: str) -> object:
    return threads_mod.list_threads(path)["count"]


def _gray(path: str) -> object:
    with pikepdf.open(path) as pdf:
        return str(pdf.pages[0].obj["/Resources"])


THREAD_SPEC = [
    {"beads": [{"page": 1, "rect": [10, 10, 100, 100]}], "info": {"title": "one"}}
]


@dataclass(frozen=True)
class Case:
    """One op that staged imperatively.

    `module` is the namespace whose producer the death test replaces, so it
    has to be the module that performs the write rather than the one that
    defines it. `dies` names that producer: a save for most, the nested engine
    op for the ops whose staged bytes are written by another door.

    `deterministic` is False only where the op stamps the CLOCK into what it
    writes, so one input has more than one correct output and no byte
    comparison can be made. Such a case pins the whole readable record as its
    effect instead; it is never excluded quietly.
    """

    name: str
    module: object
    build: Callable[[Path], Path]
    run: Callable[[str, str], dict]
    effect: Callable[[str], object]
    dies: str = "save_pdf"
    deterministic: bool = True


CASES = (
    # `save` — the swap sits inside the block holding the destination open.
    Case(
        "doc_properties",
        doc_properties_mod,
        _plain,
        lambda src, out: doc_properties_mod.set_document_language(src, out, "en-GB"),
        _lang,
    ),
    Case(
        "doc_properties_advanced",
        doc_properties_mod,
        _plain,
        lambda src, out: doc_properties_mod.set_advanced_properties(
            src, out, trapped="true"),
        _trapped,
    ),
    Case(
        "encrypt",
        encrypt_mod,
        _encrypted,
        lambda src, out: encrypt_mod.decrypt(src, out, password="pw"),
        _encryption,
    ),
    Case(
        # The XMP writer stamps a modify date, so two runs of one input differ
        # in the second they ran.
        "metadata",
        metadata_mod,
        _plain,
        lambda src, out: metadata_mod.set_metadata(src, out, title="after the write"),
        _metadata_record,
        deterministic=False,
    ),
    Case(
        "optimize",
        optimize_mod,
        _plain,
        lambda src, out: optimize_mod.optimize(src, out, linearize=True),
        _linearized,
    ),
    # `save` — the swap sat after the block instead, which left the same span
    # unowned.
    Case(
        "metadata_strip",
        metadata_mod,
        _titled,
        lambda src, out: metadata_mod.strip_metadata(src, out),
        _title,
    ),
    Case(
        "autotag",
        autotag_mod,
        _text_and_figure,
        lambda src, out: autotag_mod.autotag(src, out),
        _struct_count,
    ),
    Case(
        "sanitize",
        sanitize_mod,
        _titled,
        lambda src, out: sanitize_mod.sanitize_pdf(src, out, categories=["metadata"]),
        _title,
    ),
    Case(
        "threads",
        threads_mod,
        _plain,
        lambda src, out: threads_mod.set_threads(src, out, THREAD_SPEC),
        _thread_count,
    ),
    # `nested` — the staged bytes come from another engine op.
    Case(
        "derived_nav",
        derived_nav_mod,
        _text_and_figure,
        lambda src, out: derived_nav_mod.outline_from_structure(
            src, out, tag_if_untagged=True),
        _struct_count,
        dies="autotag",
    ),
)


@pytest.fixture(params=CASES, ids=lambda case: case.name)
def case(request):
    return request.param


def _besides(directory: Path, *expected: str) -> list:
    return sorted(p.name for p in directory.iterdir() if p.name not in expected)


class TestWritingBackOverTheInput:
    def test_in_place_does_what_a_distinct_output_does(self, case, tmp_path):
        """Byte-identity is the pin wherever the op is deterministic; where a
        run carries its own randomness the EFFECT is still the whole claim,
        and that is checked either way."""
        source = case.build(tmp_path / "source.pdf")
        control = tmp_path / "control.pdf"
        subject = tmp_path / "subject.pdf"
        shutil.copy2(source, subject)
        before = case.effect(str(source))

        case.run(str(source), str(control))
        case.run(str(subject), str(subject))

        assert case.effect(str(subject)) == case.effect(str(control))
        # The op has to have DONE something, or the agreement above is the
        # agreement of two documents nothing happened to.
        assert case.effect(str(subject)) != before
        if case.deterministic:
            assert subject.read_bytes() == control.read_bytes()

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

        def die(_first, target, *_args, **_kwargs):
            targets.append(str(target))
            raise OSError("the volume went away mid-write")

        monkeypatch.setattr(case.module, case.dies, die)
        with pytest.raises(OSError):
            case.run(str(source), str(source))

        # The write that died was the STAGED one. Without this the assertions
        # below hold for a write that never began.
        assert targets and targets[0] != str(source)
        assert source.read_bytes() == before
        # The temp file mkstemp already created is the litter the loose
        # staging left behind; the scope is what removes it.
        assert _besides(tmp_path, "source.pdf") == []

    def test_the_swap_replaces_the_name_and_never_writes_into_the_document(
        self, case, tmp_path,
    ):
        """The staged file lands by swapping a directory entry, so the bytes
        the user's document occupied are never opened for writing.

        A swap that COPIES opens them: for an in-place write the destination
        IS the document, so the copy fills it in chunks and a death inside
        that fill leaves a truncated file. A second name for the same file is
        how the difference is read without racing anything.
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


class TestTheDestinationIsClosedBeforeTheSwap:
    """`os.replace` will not replace a file something still holds open, which
    is the difference the migration off `shutil.move` introduced: the copy it
    used to degrade into tolerated an open destination by writing through it.
    """

    def test_replacing_a_destination_that_is_still_open_is_refused(self, tmp_path):
        source = _plain(tmp_path / "source.pdf")
        staged = tmp_path / "staged.pdf"
        with pikepdf.open(str(source)) as pdf:
            pdf.save(str(staged))
            with pytest.raises(OSError):
                os.replace(str(staged), str(source))

    def test_every_in_place_op_lands_with_the_destination_closed(
        self, case, tmp_path,
    ):
        """The refusal above is what each op would hit if it swapped while
        still holding its input. Running every case in place is the proof
        that none of them does."""
        source = case.build(tmp_path / "source.pdf")
        case.run(str(source), str(source))
        assert source.is_file()


class TestTheProducerShapedStaging:
    """Ghostscript writes the staged file itself, over seconds, and the
    staging is conditional — one variable is either the staged file or the
    output. The scope has to cover the whole producer rather than a save
    call, and a refusal inside it must leave nothing beside the document.
    """

    @pytest.fixture
    def gs_path(self):
        path = FIXTURES.parent.parent / "resources" / "ghostscript" / "gswin64c.exe"
        if not path.is_file():
            pytest.skip("Ghostscript not available")
        return str(path)

    def test_in_place_grayscale_leaves_nothing_staged(self, tmp_path, gs_path):
        source = _text_and_figure(tmp_path / "source.pdf")
        before = _gray(str(source))
        grayscale_mod.grayscale(str(source), str(source), gs_path=gs_path)
        assert _besides(tmp_path, "source.pdf") == []
        assert _gray(str(source)) != before

    def test_the_swap_replaces_the_name_and_never_writes_into_the_document(
        self, tmp_path, gs_path,
    ):
        source = _text_and_figure(tmp_path / "source.pdf")
        before = source.read_bytes()
        alias = tmp_path / "alias.pdf"
        try:
            os.link(str(source), str(alias))
        except (AttributeError, NotImplementedError, OSError) as exc:
            pytest.skip(f"this filesystem does not make hard links: {exc}")

        grayscale_mod.grayscale(str(source), str(source), gs_path=gs_path)

        assert source.read_bytes() != before
        assert alias.read_bytes() == before

    def test_a_refused_run_leaves_the_input_whole_and_nothing_staged(
        self, tmp_path, monkeypatch,
    ):
        """The staging creates the temp file before the producer runs, so a
        producer that never writes anything still leaves one behind unless
        the scope removes it."""
        source = _text_and_figure(tmp_path / "source.pdf")
        before = source.read_bytes()

        def refuse(*_args, **_kwargs):
            return SimpleNamespace(returncode=1, stdout="", stderr="it refused")

        monkeypatch.setattr(grayscale_mod.budget, "gs", refuse)
        with pytest.raises(RuntimeError):
            grayscale_mod.grayscale(str(source), str(source), gs_path="gs")

        assert source.read_bytes() == before
        assert _besides(tmp_path, "source.pdf") == []


class TestFinishStaged:
    """The swap primitive both scopes land through."""

    def test_it_replaces_an_existing_destination(self, tmp_path):
        from engine.inplace import finish_staged

        destination = tmp_path / "destination.bin"
        destination.write_bytes(b"old")
        staged = tmp_path / "staged.bin"
        staged.write_bytes(b"new")

        finish_staged(staged, destination)

        assert destination.read_bytes() == b"new"
        assert not staged.exists()

    def test_a_hard_link_to_the_destination_keeps_the_bytes_it_had(self, tmp_path):
        """A copy would write through the link; a directory-entry swap cannot."""
        from engine.inplace import finish_staged

        destination = tmp_path / "destination.bin"
        destination.write_bytes(b"old")
        alias = tmp_path / "alias.bin"
        try:
            os.link(str(destination), str(alias))
        except (AttributeError, NotImplementedError, OSError) as exc:
            pytest.skip(f"this filesystem does not make hard links: {exc}")
        staged = tmp_path / "staged.bin"
        staged.write_bytes(b"new")

        finish_staged(staged, destination)

        assert destination.read_bytes() == b"new"
        assert alias.read_bytes() == b"old"

    def test_a_swap_that_fails_leaves_nothing_staged(self, tmp_path):
        from engine.inplace import finish_staged

        destination = tmp_path / "held-open.bin"
        destination.write_bytes(b"old")
        staged = tmp_path / "staged.bin"
        staged.write_bytes(b"new")

        with open(destination, "rb") as held:
            held.read()
            with pytest.raises(OSError):
                finish_staged(staged, destination)

        assert not staged.exists()
        assert destination.read_bytes() == b"old"
