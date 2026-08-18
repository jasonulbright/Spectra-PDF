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


def _annotated(path: Path) -> Path:
    """A page carrying an annotation — `/Tabs` on a page with nothing to
    order is refused, so a tab order needs something to order."""
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(200, 200))
    note = pdf.make_indirect(pikepdf.Dictionary(
        Type=pikepdf.Name.Annot, Subtype=pikepdf.Name.Text,
        Rect=pikepdf.Array([10, 10, 30, 30]),
        Contents=pikepdf.String("a note"),
    ))
    page.obj["/Annots"] = pikepdf.Array([note])
    pdf.save(str(path))
    pdf.close()
    return path


def _accessibility_denied(path: Path) -> Path:
    """An encrypted document that refuses assistive technology, with empty
    passwords — the one shape granting the permission back is offered on.

    The `encrypt` door cannot produce it: that door pins accessibility ON, by
    policy. So the document is written directly, which is also how a document
    from elsewhere arrives."""
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(200, 200))
    pdf.save(
        str(path),
        encryption=pikepdf.Encryption(
            owner="", user="", R=3, aes=False, metadata=False,
            allow=pikepdf.Permissions(accessibility=False, extract=False),
        ),
    )
    pdf.close()
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


def _displayed_title(path: str) -> object:
    with pikepdf.open(path) as pdf:
        viewer = pdf.Root.get("/ViewerPreferences") or {}
        return (str(pdf.docinfo.get("/Title", "")), bool(viewer.get("/DisplayDocTitle", False)))


def _initial_view(path: str) -> object:
    """Every field the reader exposes except the path it was read from."""
    return {
        k: v for k, v in doc_properties_mod.get_initial_view(path).items() if k != "file"
    }


def _tab_order(path: str) -> object:
    with pikepdf.open(path) as pdf:
        return [str(page.obj.get("/Tabs", "")) for page in pdf.pages]


def _permissions(path: str) -> object:
    """Whether the document is encrypted and every permission it declares —
    the whole readable claim, for the op whose bytes cannot be compared."""
    with pikepdf.open(path) as pdf:
        allow = pdf.allow
        return (
            bool(pdf.is_encrypted),
            {name: bool(getattr(allow, name)) for name in sorted((
                "accessibility", "extract", "modify_annotation", "modify_assembly",
                "modify_form", "modify_other", "print_lowres", "print_highres",
            ))},
        )


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

    `doors` names the registered engine doors this case drives, which is what
    the coverage guard in `test_inplace_staged_write` counts.
    """

    name: str
    module: object
    build: Callable[[Path], Path]
    run: Callable[[str, str], dict]
    effect: Callable[[str], object]
    dies: str = "save_pdf"
    deterministic: bool = True
    doors: tuple = ()


CASES = (
    # `save` — the swap sits inside the block holding the destination open.
    Case(
        "doc_properties",
        doc_properties_mod,
        _plain,
        lambda src, out: doc_properties_mod.set_document_language(src, out, "en-GB"),
        _lang,
        doors=("set_document_language",),
    ),
    Case(
        "doc_properties_title",
        doc_properties_mod,
        _plain,
        lambda src, out: doc_properties_mod.set_document_title(
            src, out, title="After the write", display=True),
        _displayed_title,
        # The title lands in XMP too, and the XMP writer stamps a modify date.
        deterministic=False,
        doors=("set_document_title",),
    ),
    Case(
        "doc_properties_initial_view",
        doc_properties_mod,
        _plain,
        lambda src, out: doc_properties_mod.set_initial_view(
            src, out, page_layout="two-page-right", page_mode="outlines"),
        _initial_view,
        doors=("set_initial_view",),
    ),
    Case(
        "doc_properties_tab_order",
        doc_properties_mod,
        _annotated,
        lambda src, out: doc_properties_mod.set_page_tab_order(src, out, order="S"),
        _tab_order,
        doors=("set_page_tab_order",),
    ),
    Case(
        "doc_properties_advanced",
        doc_properties_mod,
        _plain,
        lambda src, out: doc_properties_mod.set_advanced_properties(
            src, out, trapped="true"),
        _trapped,
        doors=("set_advanced_properties",),
    ),
    Case(
        "decrypt",
        encrypt_mod,
        _encrypted,
        lambda src, out: encrypt_mod.decrypt(src, out, password="pw"),
        _encryption,
        doors=("decrypt",),
    ),
    Case(
        "encrypt",
        encrypt_mod,
        _plain,
        lambda src, out: encrypt_mod.encrypt(
            src, out, owner_password="pw", permissions={"print": False}),
        _permissions,
        # Encryption draws a fresh file key per run, so one input has more
        # than one correct output.
        deterministic=False,
        doors=("encrypt",),
    ),
    Case(
        "grant_accessibility_permission",
        encrypt_mod,
        _accessibility_denied,
        lambda src, out: encrypt_mod.grant_accessibility_permission(src, out),
        _permissions,
        # Rewriting the encryption draws a fresh file key.
        deterministic=False,
        doors=("grant_accessibility_permission",),
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
        doors=("set_metadata",),
    ),
    Case(
        "optimize",
        optimize_mod,
        _plain,
        lambda src, out: optimize_mod.optimize(src, out, linearize=True),
        _linearized,
        doors=("optimize",),
    ),
    # `save` — the swap sat after the block instead, which left the same span
    # unowned.
    Case(
        "metadata_strip",
        metadata_mod,
        _titled,
        lambda src, out: metadata_mod.strip_metadata(src, out),
        _title,
        doors=("strip_metadata",),
    ),
    Case(
        "autotag",
        autotag_mod,
        _text_and_figure,
        lambda src, out: autotag_mod.autotag(src, out),
        _struct_count,
        doors=("autotag",),
    ),
    Case(
        "sanitize",
        sanitize_mod,
        _titled,
        lambda src, out: sanitize_mod.sanitize_pdf(src, out, categories=["metadata"]),
        _title,
        doors=("sanitize_pdf",),
    ),
    Case(
        "threads",
        threads_mod,
        _plain,
        lambda src, out: threads_mod.set_threads(src, out, THREAD_SPEC),
        _thread_count,
        doors=("set_threads",),
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
        doors=("outline_from_structure",),
    ),
)


@pytest.fixture(params=CASES, ids=lambda case: case.name)
def case(request):
    return request.param


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

        def cancel(_first, target, *_args, **_kwargs):
            Path(target).write_bytes(b"%PDF-1.7\n% staged and then cancelled\n")
            raise KeyboardInterrupt

        monkeypatch.setattr(case.module, case.dies, cancel)
        with pytest.raises(KeyboardInterrupt):
            case.run(str(source), str(source))

        assert source.read_bytes() == before
        assert _besides(tmp_path, "source.pdf") == []


class TestOnePhysicalFileUnderTwoNames:
    """Which BRANCH an op takes when its output is its input under another
    name — the half the alias tests above do not reach.

    Those hand the op one path twice, so the same-file test answers yes on the
    spelling alone and the alias only READS. Handing the op the alias as its
    output is the routing question: the op is given two different strings for
    one physical file, and a same-file test made of resolved strings answers
    no. The direct-write branch it then takes writes through the link into the
    bytes the reader still holds open, which is where
    `set_document_language` raised `Cannot overwrite input file`.
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
        # The staged file replaced that NAME. The other name still reading as
        # it did is what says the write did not go through the link and into
        # the bytes the op held open.
        assert source.read_bytes() == before_bytes
        assert _besides(tmp_path, "source.pdf", "alias.pdf") == []


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
        alias = _hardlink(source, tmp_path / "alias.pdf")

        grayscale_mod.grayscale(str(source), str(source), gs_path=gs_path)

        assert source.read_bytes() != before
        assert alias.read_bytes() == before

    def test_an_output_hardlinked_to_the_input_routes_through_staging(
        self, tmp_path, gs_path,
    ):
        """The conditional staging branches on the same-file test, so an
        output that is the input under another name must reach the staged
        branch — Ghostscript reads its input for the whole run, and a direct
        write through the link truncates what it is still reading."""
        source = _text_and_figure(tmp_path / "source.pdf")
        before_bytes = source.read_bytes()
        before = _gray(str(source))
        alias = _hardlink(source, tmp_path / "alias.pdf")

        grayscale_mod.grayscale(str(source), str(alias), gs_path=gs_path)

        assert _gray(str(alias)) != before
        assert source.read_bytes() == before_bytes
        assert _besides(tmp_path, "source.pdf", "alias.pdf") == []

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

    def test_a_swap_cancelled_mid_flight_leaves_nothing_staged(
        self, tmp_path, monkeypatch,
    ):
        """`KeyboardInterrupt` is not an `Exception`, so cleanup written as an
        `except Exception` never runs for it."""
        import engine.inplace as inplace_mod
        from engine.inplace import finish_staged

        destination = tmp_path / "destination.bin"
        destination.write_bytes(b"old")
        staged = tmp_path / "staged.bin"
        staged.write_bytes(b"new")

        def cancel(*_args, **_kwargs):
            raise KeyboardInterrupt

        monkeypatch.setattr(inplace_mod.os, "replace", cancel)
        with pytest.raises(KeyboardInterrupt):
            finish_staged(staged, destination)

        assert not staged.exists()
        assert destination.read_bytes() == b"old"


class TestTheStagedScope:
    """The scope that owns the span between the staging and the swap."""

    @pytest.mark.parametrize("cancellation", [KeyboardInterrupt, SystemExit])
    def test_a_producer_cancelled_mid_write_leaves_nothing_staged(
        self, tmp_path, cancellation,
    ):
        """The temp file exists from the moment the scope opens, so a producer
        that is cancelled part-way leaves it beside the user's document unless
        the scope removes it on EVERY way out — and the cancellation has to
        arrive, or the interrupt the user asked for is swallowed."""
        from engine.inplace import staged_write

        destination = tmp_path / "destination.bin"
        destination.write_bytes(b"old")

        with pytest.raises(cancellation):
            with staged_write(destination) as staged:
                staged.write_bytes(b"most of a document")
                raise cancellation

        assert destination.read_bytes() == b"old"
        assert _besides(tmp_path, "destination.bin") == []

    def test_a_clean_run_still_lands(self, tmp_path):
        """The cleanup is scoped to a run that did not land; a run that landed
        must not have its result removed."""
        from engine.inplace import staged_write

        destination = tmp_path / "destination.bin"
        destination.write_bytes(b"old")

        with staged_write(destination) as staged:
            staged.write_bytes(b"new")

        assert destination.read_bytes() == b"new"
        assert _besides(tmp_path, "destination.bin") == []


class TestOneFileUnderTwoNamesIsOneFile:
    """The predicate every conditional staging branches on."""

    def test_a_hard_link_is_the_same_file(self, tmp_path):
        """Two names for one physical file resolve to two different strings —
        only volume serial and file index say they are one file."""
        from engine.inplace import is_same_file

        source = _plain(tmp_path / "source.pdf")
        alias = _hardlink(source, tmp_path / "alias.pdf")

        assert os.path.samefile(str(source), str(alias))
        assert Path(source).resolve() != Path(alias).resolve()
        assert is_same_file(str(source), str(alias))

    def test_the_same_path_is_the_same_file(self, tmp_path):
        from engine.inplace import is_same_file

        source = _plain(tmp_path / "source.pdf")
        assert is_same_file(str(source), str(source))

    def test_a_spelling_of_the_same_path_is_the_same_file(self, tmp_path):
        """The resolved comparison is the branch that answers before any stat,
        and it has to keep answering."""
        from engine.inplace import is_same_file

        source = _plain(tmp_path / "source.pdf")
        spelled = tmp_path / "sub" / ".." / "source.pdf"
        (tmp_path / "sub").mkdir()

        assert is_same_file(str(source), str(spelled))

    def test_a_distinct_output_is_not_the_same_file(self, tmp_path):
        from engine.inplace import is_same_file

        source = _plain(tmp_path / "source.pdf")
        other = _plain(tmp_path / "other.pdf")
        assert not is_same_file(str(source), str(other))

    def test_an_output_that_does_not_exist_yet_is_not_the_same_file(self, tmp_path):
        """It names nothing to be identical to, and `samefile` on it raises."""
        from engine.inplace import is_same_file

        source = _plain(tmp_path / "source.pdf")
        assert not is_same_file(str(source), str(tmp_path / "not-yet.pdf"))
