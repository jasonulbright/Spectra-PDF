"""Recognize music: the five engine doors, the guided step, and the run of
Audiveris they drive.

Three axes:

  * Absent: every door that runs Audiveris refuses by name when none
    resolves. Runs everywhere.
  * Scripted: a stand-in launcher plays the outcomes Audiveris produces (a
    clean export, a sheet with no staff, a failed task, an unreadable score),
    so the doors' handling of each runs everywhere.
  * Present: the installed Audiveris recognizes a score this file draws. It
    is skipped by name when no Audiveris 5.11 or newer is on the machine.
"""

from __future__ import annotations

import ast
import json
import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
import time
import zipfile
from pathlib import Path

import pikepdf
import pytest
from pikepdf import Array, Dictionary, Name
from PIL import Image

from engine import credentials
from engine import recognize_music as omr
from engine.guided_actions import _STEPS, AUDIVERIS_STEPS, run_action, validate_steps
from engine.ipc import JsonRpcServer, RequestCancelled
from engine.recognize_music import (
    MusicRecognitionFailed,
    TargetsExist,
    recognize_music_attach,
    recognize_music_discard,
    recognize_music_prepare,
    recognize_music_publish,
    recognize_music_run,
)

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "tests" / "fixtures"
PROBE_SCORE = FIXTURES / "omr-probe-score.png"

NOT_SET_UP = "Audiveris is not set up. Install it, then point Spectra PDF at it in Preferences ▸ Engine."
PDFA_REFUSAL = (
    "The score cannot be attached to a document that claims PDF/A conformance; "
    "the MusicXML file beside the document is still written"
)
PDFA_PREPARE_REFUSAL = (
    "The score cannot be attached to a document that claims PDF/A conformance. "
    "Turn off Attach to recognize this document."
)
MIME_MXL = "/application/vnd.recordare.musicxml"
DOORS = (
    "recognize_music_prepare",
    "recognize_music_run",
    "recognize_music_publish",
    "recognize_music_attach",
    "recognize_music_discard",
)


# ── Documents ────────────────────────────────────────────────────────────


def _score_page(width: int = 2550, height: int = 3300) -> Image.Image:
    page = Image.new("L", (width, height), 255)
    page.paste(Image.open(PROBE_SCORE).convert("L"), (200, 300))
    return page


def _text_page(width: int = 2550, height: int = 3300) -> Image.Image:
    page = Image.new("L", (width, height), 255)
    for y in range(300, 900, 60):
        page.paste(0, (200, y, 1800, y + 8))
    return page


def _document(path: Path, pages: list[Image.Image]) -> Path:
    pages[0].save(path, save_all=True, append_images=pages[1:], resolution=300)
    return path


@pytest.fixture
def score_pdf(tmp_path) -> Path:
    return _document(tmp_path / "song.pdf", [_score_page()])


@pytest.fixture
def mixed_pdf(tmp_path) -> Path:
    return _document(tmp_path / "book.pdf", [_score_page(), _text_page(), _score_page()])


@pytest.fixture(autouse=True)
def _stages_are_removed():
    """Every test leaves no stage of its own process behind."""
    yield
    root = omr._primary_root()
    for stage in root.glob(f"{os.getpid()}-*"):
        shutil.rmtree(stage, ignore_errors=True)


# ── A stand-in for Audiveris ─────────────────────────────────────────────

_FAKE = textwrap.dedent(
    '''
    import sys, time, zipfile
    from pathlib import Path

    MODE = {mode!r}
    args = sys.argv[1:]
    out = Path(args[args.index("-output") + 1]) if "-output" in args else None
    source = Path(args[args.index("--") + 1])
    Path({record!r}).open("a").write(" ".join(args) + "\\n")

    SCORE = (
        '<?xml version="1.0" encoding="UTF-8"?>\\n'
        '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0.3 Partwise//EN" '
        '"http://www.musicxml.org/dtds/partwise.dtd">\\n'
        '<score-partwise version="4.0.3"><identification>'
        '<source>' + str(source) + '</source><miscellaneous>'
        '<miscellaneous-field name="source-file">' + str(source) + '</miscellaneous-field>'
        '<miscellaneous-field name="source-sheet-{{sheet}}">1</miscellaneous-field>'
        '</miscellaneous></identification><part-list/></score-partwise>'
    )

    def mxl(target, sheet):
        with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr("META-INF/container.xml",
                '<container><rootfiles><rootfile full-path="s.xml" '
                'media-type="application/vnd.recordare.musicxml+xml"/></rootfiles></container>')
            z.writestr("s.xml", SCORE.replace("{{sheet}}", str(sheet)))

    def book(target, sheets, invalid, scores):
        body = "<book>"
        for n in range(1, sheets + 1):
            body += '<sheet number="%d"%s/>' % (n, ' invalid="true"' if n in invalid else "")
        for pages in scores:
            body += "<score>" + "".join('<page sheet-number="%d"/>' % p for p in pages) + "</score>"
        with zipfile.ZipFile(target, "w") as z:
            z.writestr("book.xml", body + "</book>")

    print("INFO fake audiveris", MODE, flush=True)
    if MODE == "hang":
        time.sleep(120)
    if MODE == "fail":
        sys.exit(2)
    if source.suffix == ".pdf":
        import pikepdf
        with pikepdf.open(source) as pdf:
            sheets = len(pdf.pages)
        if MODE == "skip-second":
            book(out / "score.omr", sheets, {{2}}, [])
            sys.exit(1)
        if MODE == "all-invalid":
            book(out / "score.omr", sheets, set(range(1, sheets + 1)), [])
            sys.exit(1)
        book(out / "score.omr", sheets, set(), [list(range(1, sheets + 1))])
        options = Path({record!r}).with_name("user-options.txt")
        persisted = options.read_text().split() if options.is_file() else []
        compressed = "useCompression=false" not in persisted or (
            "org.audiveris.omr.sheet.BookManager.useCompression=true" in args)
        opus = "useOpus=true" in persisted and (
            "org.audiveris.omr.sheet.BookManager.useOpus=false" not in args)
        if not compressed:
            (out / "score.xml").write_text("<score-partwise/>")
            sys.exit(0)
        if opus:
            mxl(out / "score.opus.mxl", 1)
            sys.exit(0)
        if MODE == "garbage":
            (out / "score.mxl").write_bytes(b"not a zip")
        elif MODE == "missing-movement":
            book(out / "score.omr", sheets, set(), [[1], [2]])
            mxl(out / "score.mvt1.mxl", 1)
        else:
            mxl(out / "score.mxl", 1)
        sys.exit(0)
    folder = source.parent
    with zipfile.ZipFile(source) as z:
        sheets = z.read("book.xml").decode().count("<sheet ")
    book(source, sheets, {{2}}, [[1], [3]])
    mxl(folder / "score.mvt1.mxl", 1)
    mxl(folder / "score.mvt2.mxl", 3)
    sys.exit(0)
    '''
)


def _fake(tmp_path: Path, mode: str) -> tuple[dict, Path]:
    """A launcher that plays `mode`, and the file it records each call in."""
    record = tmp_path / f"fake-{mode}-calls.txt"
    script = tmp_path / f"fake-{mode}.py"
    script.write_text(_FAKE.format(mode=mode, record=str(record)), encoding="utf-8")
    if os.name == "nt":
        launcher = tmp_path / f"fake-{mode}.bat"
        launcher.write_text(f'@echo off\r\n"{sys.executable}" "{script}" %*\r\n', encoding="utf-8")
    else:
        launcher = tmp_path / f"fake-{mode}"
        launcher.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{script}" "$@"\n', encoding="utf-8")
        launcher.chmod(0o755)
    return {"kind": "ready", "launcher": "exe", "path": str(launcher), "version": "5.11.0"}, record


def _recognize(document: Path, answer: dict, *, pages=None, base=None, folder=None, keep=False,
               fmt="mxl", consent=None, project_id=None, **run) -> tuple[dict, dict, dict]:
    """prepare → run → publish → discard, as the window sequences them."""
    prepared = recognize_music_prepare(str(document), pages=pages)
    token = prepared["token"]
    try:
        ran = recognize_music_run(token, keep_project=keep, audiveris=answer, **run)
        published = recognize_music_publish(
            token,
            str(folder or document.parent),
            base or document.stem,
            format=fmt,
            keep_project=keep,
            overwrite_names=consent,
            project_id=project_id,
        )
    finally:
        recognize_music_discard(token)
    return prepared, ran, published


def _score_of(path: Path) -> str:
    with zipfile.ZipFile(path) as archive:
        container = archive.read("META-INF/container.xml").decode("utf-8")
        name = container.split('full-path="', 1)[1].split('"', 1)[0]
        return archive.read(name).decode("utf-8")


# ── The roster ───────────────────────────────────────────────────────────


def test_the_engine_registers_exactly_the_five_doors():
    main = ast.parse((ROOT / "src" / "engine" / "__main__.py").read_text(encoding="utf-8"))
    registered = {
        node.args[0].value
        for node in ast.walk(main)
        if isinstance(node, ast.Call)
        and getattr(node.func, "attr", "") == "register"
        and isinstance(node.args[0], ast.Constant)
        and str(node.args[0].value).startswith("recognize_music")
    }
    assert registered == set(DOORS)
    assert sorted(op for op, spec in _STEPS.items() if spec.fn is recognize_music_prepare) == ["omr"]
    assert AUDIVERIS_STEPS == ("omr",)


# ── Absent axis ──────────────────────────────────────────────────────────


def _doors(tmp_path: Path, score: Path, audiveris) -> dict:
    """Every way the engine runs Audiveris: the run door, and a guided action
    with the `omr` step."""
    source = tmp_path / "in"
    source.mkdir(exist_ok=True)
    shutil.copy2(score, source / "a.pdf")
    dest = tmp_path / "out"

    def run():
        token = recognize_music_prepare(str(score))["token"]
        try:
            return recognize_music_run(token, audiveris=audiveris)
        finally:
            recognize_music_discard(token)

    return {
        "recognize_music_run": run,
        "run_action": lambda: run_action(
            str(source), str(dest), [{"op": "omr", "params": {}}], audiveris=audiveris
        ),
    }


def test_every_door_refuses_by_name_when_nothing_is_set_up(tmp_path, score_pdf, monkeypatch):
    monkeypatch.delenv(omr.PATH_ENV_VAR, raising=False)
    for name, door in _doors(tmp_path, score_pdf, None).items():
        with pytest.raises(RuntimeError) as refused:
            door()
        assert str(refused.value) == NOT_SET_UP, name
    assert not (tmp_path / "out").exists()


def test_every_door_refuses_by_name_for_a_path_that_runs_nothing(tmp_path, score_pdf, monkeypatch):
    missing = tmp_path / "nowhere" / "Audiveris.exe"
    monkeypatch.setenv(omr.PATH_ENV_VAR, str(missing))
    for name, door in _doors(tmp_path, score_pdf, None).items():
        with pytest.raises(RuntimeError) as refused:
            door()
        assert str(refused.value) == f"Audiveris at {missing} could not be run: no program is at that path", name


@pytest.mark.parametrize(
    "answer, expected",
    [
        ({"kind": "not-configured", "path": None}, NOT_SET_UP),
        (
            {"kind": "version-below-minimum", "path": "C:/A/Audiveris.exe", "version": "5.10.2"},
            "Audiveris at C:/A/Audiveris.exe could not be run: it is 5.10.2, older than the 5.11 this feature needs",
        ),
        (
            {"kind": "probe-failed", "path": "C:/A/Audiveris.exe", "detail": "the probe recognition wrote no score"},
            "Audiveris at C:/A/Audiveris.exe could not be run: the probe recognition wrote no score",
        ),
        (
            {"kind": "not-executable", "path": "C:/A/Audiveris.exe"},
            "Audiveris at C:/A/Audiveris.exe could not be run: no program is at that path",
        ),
        (
            {"kind": "not-executable", "path": "C:/A/Audiveris.exe", "detail": "not a valid application"},
            "Audiveris at C:/A/Audiveris.exe could not be run: not a valid application",
        ),
    ],
)
def test_the_host_answer_names_the_refusal(tmp_path, score_pdf, answer, expected):
    for name, door in _doors(tmp_path, score_pdf, answer).items():
        with pytest.raises(RuntimeError) as refused:
            door()
        assert str(refused.value) == expected, name


def test_a_launcher_that_cannot_start_is_named(tmp_path, score_pdf):
    directory = tmp_path / "a-folder"
    directory.mkdir()
    answer = {"kind": "ready", "launcher": "exe", "path": str(directory)}
    token = recognize_music_prepare(str(score_pdf))["token"]
    with pytest.raises(RuntimeError, match=r"^Audiveris at .* could not be run: "):
        recognize_music_run(token, audiveris=answer)


# ── Prepare ──────────────────────────────────────────────────────────────


def test_prepare_stages_the_selection_in_document_order(tmp_path, mixed_pdf):
    prepared = recognize_music_prepare(str(mixed_pdf), pages=[3, 1, 3])
    assert prepared["pageCount"] == 3
    assert prepared["pages"] == [1, 3]
    stage = omr._stage(prepared["token"])
    with pikepdf.open(stage / "in" / "score.pdf") as staged:
        assert len(staged.pages) == 2
        assert not staged.is_encrypted
    recognize_music_discard(prepared["token"])
    assert not stage.exists()


@pytest.mark.parametrize(
    "pages, message",
    [
        ([4], "Page 4 is outside the document, which has 3 pages"),
        ("1", "pages must be a list of page numbers, or 'all'"),
    ],
)
def test_prepare_refuses_a_bad_selection_and_leaves_no_stage(mixed_pdf, pages, message):
    before = set(omr._primary_root().iterdir())
    with pytest.raises(ValueError) as refused:
        recognize_music_prepare(str(mixed_pdf), pages=pages)
    assert str(refused.value) == message
    assert set(omr._primary_root().iterdir()) <= before


def test_prepare_keeps_inherited_page_attributes(tmp_path, score_pdf):
    inherited = tmp_path / "inherited.pdf"
    with pikepdf.open(score_pdf) as pdf:
        page = pdf.pages[0].obj
        box = page.MediaBox
        del page["/MediaBox"]
        pdf.Root.Pages.MediaBox = box
        pdf.Root.Pages.Rotate = 90
        pdf.save(inherited)
    token = recognize_music_prepare(str(inherited))["token"]
    with pikepdf.open(omr._stage(token) / "in" / "score.pdf") as staged:
        assert list(staged.pages[0].obj.MediaBox) == list(box)
        assert int(staged.pages[0].obj.Rotate) == 90
    recognize_music_discard(token)


def test_prepare_drops_hidden_optional_content(tmp_path):
    raw = _document(tmp_path / "raw.pdf", [_score_page()])
    hidden = tmp_path / "hidden.pdf"
    with pikepdf.open(raw) as pdf:
        ocg = pdf.make_indirect(Dictionary(Type=Name.OCG, Name=pikepdf.String("Hidden score")))
        pdf.Root.OCProperties = Dictionary(OCGs=Array([ocg]), D=Dictionary(OFF=Array([ocg]), Order=Array([ocg])))
        page = pdf.pages[0]
        page.obj.Resources.Properties = Dictionary(L0=ocg)
        page.obj.Contents = pdf.make_stream(b"/OC /L0 BDC\n" + page.obj.Contents.read_bytes() + b"\nEMC\n")
        pdf.save(hidden)
    token = recognize_music_prepare(str(hidden))["token"]
    with pikepdf.open(omr._stage(token) / "in" / "score.pdf") as staged:
        drawn = staged.pages[0].obj.Contents.read_bytes()
        assert b"Do" not in drawn
    recognize_music_discard(token)


def test_prepare_refuses_attach_to_a_pdfa_document_before_any_run(tmp_path, score_pdf):
    claimed = tmp_path / "archive.pdf"
    with pikepdf.open(score_pdf) as pdf:
        with pdf.open_metadata(set_pikepdf_as_editor=False) as meta:
            meta["pdfaid:part"] = "2"
            meta["pdfaid:conformance"] = "B"
        pdf.save(claimed)
    before = set(omr._primary_root().iterdir())
    with pytest.raises(ValueError) as refused:
        recognize_music_prepare(str(claimed), attach=True)
    assert str(refused.value) == PDFA_PREPARE_REFUSAL
    assert set(omr._primary_root().iterdir()) <= before
    recognize_music_discard(recognize_music_prepare(str(claimed))["token"])


def test_a_document_that_withholds_copying_is_refused(tmp_path, score_pdf):
    locked = tmp_path / "locked.pdf"
    with pikepdf.open(score_pdf) as pdf:
        pdf.save(
            locked,
            encryption=pikepdf.Encryption(owner="owner", user="", allow=pikepdf.Permissions(extract=False)),
        )
    with pytest.raises(PermissionError) as refused:
        recognize_music_prepare(str(locked))
    assert str(refused.value) == "Recognize music needs the copy permission of this document"


def test_attach_needs_the_modify_permission_before_any_run(tmp_path, score_pdf):
    locked = tmp_path / "locked.pdf"
    with pikepdf.open(score_pdf) as pdf:
        pdf.save(
            locked,
            encryption=pikepdf.Encryption(owner="owner", user="", allow=pikepdf.Permissions(modify_other=False)),
        )
    with pytest.raises(PermissionError) as refused:
        recognize_music_prepare(str(locked), attach=True)
    assert str(refused.value) == credentials.PERMISSIONS_HELD
    recognize_music_discard(recognize_music_prepare(str(locked))["token"])


@pytest.mark.parametrize(
    "refusal",
    [
        PermissionError(credentials.PERMISSIONS_HELD_BY_RECIPIENTS),
        PermissionError(13, "The process cannot access the file because another process has locked it"),
    ],
    ids=["recipient-held", "locked-file"],
)
def test_other_permission_refusals_keep_their_own_text(score_pdf, monkeypatch, refusal):
    def refuse(*_args):
        raise refusal

    monkeypatch.setattr(omr, "require_permission", refuse)
    with pytest.raises(PermissionError) as raised:
        recognize_music_prepare(str(score_pdf))
    assert raised.value is refusal


def test_a_stage_beyond_the_code_page_moves_to_a_readable_spelling(tmp_path, score_pdf, monkeypatch):
    greek = tmp_path / "\u03a8\u03b7\u03c6\u03af\u03bf"
    greek.mkdir()
    monkeypatch.setattr(tempfile, "tempdir", str(greek))
    token = recognize_music_prepare(str(score_pdf))["token"]
    stage = omr._stage(token)
    assert omr.audiveris_argument(stage) is not None
    assert omr.audiveris_argument(stage / "in" / "score.pdf") is not None
    recognize_music_discard(token)


def test_reclaim_removes_the_stages_of_ended_processes_only(tmp_path):
    ended = subprocess.Popen([sys.executable, "-c", "pass"])
    ended.wait()
    live = os.getppid()
    hexes = "0" * 32
    for pid in (ended.pid, live):
        (tmp_path / f"{pid}-{hexes}").mkdir()
        (tmp_path / f"{pid}-{hexes}.stage").write_text("x")
    (tmp_path / "unrelated").mkdir()
    omr._reclaim_stages(tmp_path)
    assert sorted(p.name for p in tmp_path.iterdir()) == sorted(
        [f"{live}-{hexes}", f"{live}-{hexes}.stage", "unrelated"]
    )


def test_a_failed_prepare_leaves_no_stage_and_no_pointer(tmp_path, score_pdf, monkeypatch):
    fallback = tmp_path / "ascii-root"
    fallback.mkdir()
    primary = omr._primary_root()
    monkeypatch.setattr(omr, "audiveris_argument", lambda path: None)
    monkeypatch.setattr(omr, "_ascii_root", lambda base=None: fallback)

    def broken(*_args):
        raise OSError("the volume went away")

    monkeypatch.setattr(omr, "_write_selection", broken)
    before = set(primary.iterdir())
    with pytest.raises(OSError, match="volume went away"):
        recognize_music_prepare(str(score_pdf))
    assert set(primary.iterdir()) <= before
    assert list(fallback.iterdir()) == []


def test_without_any_readable_folder_prepare_refuses_by_name(score_pdf, monkeypatch):
    monkeypatch.setattr(omr, "audiveris_argument", lambda path: None)
    monkeypatch.setattr(omr, "_ascii_root", lambda base=None: None)
    with pytest.raises(RuntimeError, match=r"^Audiveris cannot read the folder .*: its path uses characters"):
        recognize_music_prepare(str(score_pdf))


windows_only = pytest.mark.skipif(os.name != "nt", reason="the ProgramData stage root is Windows only")


def _icacls_calls(monkeypatch, fail=()):
    calls = []
    real = omr.platform_support.run

    def record(argv, **kwargs):
        calls.append(list(argv))
        if argv[0] == "icacls" and any(flag in argv for flag in fail):
            return subprocess.CompletedProcess(argv, 5, "", "denied")
        return real(argv, **kwargs)

    monkeypatch.setattr(omr.platform_support, "run", record)
    return calls


@windows_only
def test_the_ascii_root_lets_only_this_account_in(tmp_path, monkeypatch):
    calls = _icacls_calls(monkeypatch)
    sid = omr.platform_support.windows_user_sid()
    first = omr._ascii_root(tmp_path)
    assert first == tmp_path / f"omr-{sid}"
    assert omr.platform_support.dacl_grants_only(first, sid)
    calls.clear()
    assert omr._ascii_root(tmp_path) == first
    assert [call for call in calls if call[0] == "icacls"] == []


@windows_only
def test_an_ascii_root_with_a_foreign_entry_is_made_private(tmp_path, monkeypatch):
    sid = omr.platform_support.windows_user_sid()
    folder = tmp_path / f"omr-{sid}"
    folder.mkdir()
    subprocess.run(["icacls", str(folder), "/grant", "*S-1-1-0:(OI)(CI)F"], capture_output=True, check=True)
    assert not omr.platform_support.dacl_grants_only(folder, sid)
    assert omr._ascii_root(tmp_path) == folder
    assert omr.platform_support.dacl_grants_only(folder, sid)


@windows_only
def test_an_inherit_only_grant_makes_an_ascii_root_public_until_reset(tmp_path):
    sid = omr.platform_support.windows_user_sid()
    folder = tmp_path / f"omr-{sid}"
    folder.mkdir()
    assert omr._ascii_root(tmp_path) == folder
    subprocess.run(["icacls", str(folder), "/grant", "*S-1-1-0:(OI)(CI)(IO)R"], capture_output=True, check=True)
    assert not omr.platform_support.dacl_grants_only(folder, sid)
    assert omr._ascii_root(tmp_path) == folder
    assert omr.platform_support.dacl_grants_only(folder, sid)
    child = folder / "stage"
    child.mkdir()
    acl = subprocess.run(["icacls", str(child)], capture_output=True, text=True).stdout
    assert "Everyone" not in acl and "S-1-1-0" not in acl, acl


@windows_only
def test_an_ascii_root_this_process_does_not_own_is_taken_over(tmp_path, monkeypatch):
    calls = _icacls_calls(monkeypatch)
    asked = []
    real = omr.platform_support.owned_entry

    def first_not_owned(path, directory):
        asked.append(path)
        return False if len(asked) == 1 else real(path, directory=directory)

    monkeypatch.setattr(omr.platform_support, "owned_entry", first_not_owned)
    sid = omr.platform_support.windows_user_sid()
    assert omr._ascii_root(tmp_path) == tmp_path / f"omr-{sid}"
    assert ["icacls", str(tmp_path / f"omr-{sid}"), "/setowner", f"*{sid}"] in calls


@windows_only
def test_an_ascii_root_that_cannot_be_taken_over_is_refused(tmp_path, monkeypatch):
    _icacls_calls(monkeypatch, fail=("/setowner",))
    monkeypatch.setattr(omr.platform_support, "owned_entry", lambda path, directory: False)
    assert omr._ascii_root(tmp_path) is None


@windows_only
def test_a_link_is_never_an_ascii_root(tmp_path):
    sid = omr.platform_support.windows_user_sid()
    target = tmp_path / "elsewhere"
    target.mkdir()
    base = tmp_path / "base"
    base.mkdir()
    made = subprocess.run(
        ["cmd", "/c", "mklink", "/J", str(base / f"omr-{sid}"), str(target)], capture_output=True
    )
    if made.returncode != 0:
        pytest.skip("this volume makes no junctions")
    assert omr._ascii_root(base) is None


@pytest.mark.parametrize(
    "token",
    ["", "../x", "1-ABC", "1-" + "0" * 31, None, 7],
)
def test_a_token_that_names_no_stage_is_refused(token):
    with pytest.raises(ValueError) as refused:
        recognize_music_run(token, audiveris={"kind": "ready", "launcher": "exe", "path": "x"})
    assert str(refused.value) == "This recognition has ended; start Recognize music again"
    assert recognize_music_discard(token) == {"discarded": False}


# ── Run ──────────────────────────────────────────────────────────────────


def test_a_clean_run_reports_one_movement_and_its_log(tmp_path, score_pdf):
    answer, record = _fake(tmp_path, "ok")
    token = recognize_music_prepare(str(score_pdf))["token"]
    ran = recognize_music_run(token, dpi=400, ocr_lang="eng+deu", audiveris=answer)
    assert ran["token"] == token
    assert ran["movements"] == [{"index": 1, "pages": [1], "name": ""}]
    assert ran["project"] is True
    assert ran["skippedPages"] == []
    assert "fake audiveris ok" in Path(ran["log"]).read_text(encoding="utf-8")
    call = record.read_text().splitlines()[0]
    assert call.startswith("-batch -export -output ")
    for constant in (
        "org.audiveris.omr.image.ImageLoading.pdfResolution=400",
        "org.audiveris.omr.text.Language.defaultSpecification=eng+deu",
        "org.audiveris.omr.Main.persistBatchCliConstants=false",
        "org.audiveris.omr.sheet.BookManager.useCompression=true",
        "org.audiveris.omr.sheet.BookManager.useOpus=false",
    ):
        assert f"-constant {constant}" in call
    assert "-run" not in call.split() and "-print" not in call.split()
    assert list(score_pdf.parent.glob("song*.mxl")) == []
    recognize_music_discard(token)


@pytest.mark.parametrize(
    "ocr_lang, passed",
    [
        (None, None),
        ("", None),
        ("  ", None),
        ([], None),
        (["eng", "deu"], "eng+deu"),
        ("eng+deu", "eng+deu"),
        (" eng ", "eng"),
    ],
)
def test_the_ocr_language_shapes(tmp_path, score_pdf, ocr_lang, passed):
    answer, record = _fake(tmp_path, "ok")
    token = recognize_music_prepare(str(score_pdf))["token"]
    recognize_music_run(token, ocr_lang=ocr_lang, audiveris=answer)
    call = record.read_text().splitlines()[0]
    constant = "org.audiveris.omr.text.Language.defaultSpecification"
    if passed is None:
        assert constant not in call
    else:
        assert f"-constant {constant}={passed} " in call
    recognize_music_discard(token)


@pytest.mark.parametrize(
    "ocr_lang", ["eng;rm", "eng,deu", ["eng", ""], [""], [" "], ["eng", " "], ["eng;rm"], [3], 7, {"eng": 1}]
)
def test_a_malformed_ocr_language_is_refused(tmp_path, score_pdf, ocr_lang):
    answer, record = _fake(tmp_path, "ok")
    token = recognize_music_prepare(str(score_pdf))["token"]
    with pytest.raises(ValueError) as refused:
        recognize_music_run(token, ocr_lang=ocr_lang, audiveris=answer)
    assert str(refused.value) == "The OCR language must be language codes joined by +, for example eng+deu"
    assert not record.exists()
    recognize_music_discard(token)


def test_a_folder_run_accepts_an_empty_ocr_language(tmp_path, score_pdf):
    source = tmp_path / "in"
    source.mkdir()
    shutil.copy2(score_pdf, source / "a.pdf")
    answer, record = _fake(tmp_path, "ok")
    report = run_action(str(source), str(tmp_path / "out"), [{"op": "omr", "params": {"ocr_lang": []}}], audiveris=answer)
    assert report["ok"] == 1, report
    assert "defaultSpecification" not in record.read_text()


def test_a_sheet_without_music_is_skipped_and_reported(tmp_path, mixed_pdf):
    answer, record = _fake(tmp_path, "skip-second")
    token = recognize_music_prepare(str(mixed_pdf))["token"]
    ran = recognize_music_run(token, keep_project=True, audiveris=answer)
    assert ran["skippedPages"] == [2]
    assert ran["movements"] == [
        {"index": 1, "pages": [1], "name": ".mvt1"},
        {"index": 2, "pages": [3], "name": ".mvt2"},
    ]
    assert ran["project"] is True
    calls = record.read_text().splitlines()
    assert len(calls) == 2 and calls[1].endswith("score.omr")
    recognize_music_discard(token)


def test_pages_that_all_lack_music_are_no_score(tmp_path, mixed_pdf):
    answer, _ = _fake(tmp_path, "all-invalid")
    token = recognize_music_prepare(str(mixed_pdf))["token"]
    with pytest.raises(MusicRecognitionFailed) as failed:
        recognize_music_run(token, audiveris=answer)
    assert str(failed.value) == "Audiveris produced no readable score for the selected pages"
    assert Path(failed.value.log).is_file()
    recognize_music_discard(token)


@pytest.mark.parametrize(
    "mode, message",
    [
        ("fail", "Music recognition failed: Audiveris exited with status 2"),
        ("garbage", "Audiveris produced no readable score for the selected pages"),
        ("missing-movement", "Audiveris produced no readable score for the selected pages"),
    ],
)
def test_a_failed_run_is_a_failure_with_its_log_in_the_stage(tmp_path, score_pdf, mode, message):
    answer, _ = _fake(tmp_path, mode)
    token = recognize_music_prepare(str(score_pdf))["token"]
    with pytest.raises(MusicRecognitionFailed) as failed:
        recognize_music_run(token, audiveris=answer)
    assert str(failed.value) == message
    assert failed.value.rpc_data == {"log": failed.value.log}
    assert Path(failed.value.log).is_file()
    assert (omr._stage(token) / "run.log").is_file()
    with pytest.raises(ValueError, match="nothing to publish"):
        recognize_music_publish(token, str(tmp_path), "song")
    recognize_music_discard(token)


def test_the_failure_log_rides_the_error_reply(tmp_path, score_pdf):
    answer, _ = _fake(tmp_path, "fail")
    token = recognize_music_prepare(str(score_pdf))["token"]
    server = JsonRpcServer()
    server.register("recognize_music_run", recognize_music_run)
    reply = server._handle(
        {"jsonrpc": "2.0", "id": 7, "method": "recognize_music_run",
         "params": {"token": token, "audiveris": answer}}
    )
    assert reply["error"]["message"] == "Music recognition failed: Audiveris exited with status 2"
    assert Path(reply["error"]["data"]["log"]).is_file()
    json.dumps(reply)
    recognize_music_discard(token)


def test_a_cancel_ends_the_run_and_keeps_its_log(tmp_path, score_pdf, monkeypatch):
    answer, _ = _fake(tmp_path, "hang")
    token = recognize_music_prepare(str(score_pdf))["token"]
    asked = time.monotonic()
    monkeypatch.setattr(omr, "cancelled", lambda: time.monotonic() - asked > 1.0)
    with pytest.raises(RequestCancelled) as cancelled:
        recognize_music_run(token, audiveris=answer)
    assert time.monotonic() - asked < 60
    assert "fake audiveris hang" in Path(cancelled.value.rpc_data["log"]).read_text(encoding="utf-8")
    assert (omr._stage(token) / "run.log").is_file()
    recognize_music_discard(token)


@pytest.mark.parametrize("persisted", ["useCompression=false", "useOpus=true"])
def test_the_users_own_output_options_do_not_change_the_run(tmp_path, score_pdf, monkeypatch, persisted):
    answer, record = _fake(tmp_path, "ok")
    record.with_name("user-options.txt").write_text(persisted)
    token = recognize_music_prepare(str(score_pdf))["token"]
    ran = recognize_music_run(token, audiveris=answer)
    assert [m["index"] for m in ran["movements"]] == [1]
    recognize_music_discard(token)
    monkeypatch.setattr(omr, "FIXED_CONSTANTS", ("org.audiveris.omr.Main.persistBatchCliConstants=false",))
    token = recognize_music_prepare(str(score_pdf))["token"]
    with pytest.raises(MusicRecognitionFailed, match="no readable score"):
        recognize_music_run(token, audiveris=answer)
    recognize_music_discard(token)


def test_a_run_past_its_budget_is_stopped(tmp_path):
    log = tmp_path / "run.log"
    with pytest.raises(omr.budget.TimeBudgetExceeded):
        omr._run([sys.executable, "-c", "import time; time.sleep(60)"], log, 0.5, 1)


def test_the_runner_reports_the_exit_status(tmp_path):
    log = tmp_path / "run.log"
    status = omr._run([sys.executable, "-c", "print('hello'); raise SystemExit(3)"], log, 30, 1)
    assert status == 3
    assert "hello" in log.read_text()


def test_a_failed_containment_ends_the_child(tmp_path, monkeypatch):
    started = []

    def contain(process):
        started.append(process)
        raise OSError("no job")

    monkeypatch.setattr(omr.budget, "contain_windows_child", contain)
    with pytest.raises(OSError, match="no job"):
        omr._run([sys.executable, "-c", "import time; time.sleep(60)"], tmp_path / "run.log", 30, 1)
    assert started and started[0].poll() is not None


def test_the_child_environment_drops_what_spectra_sets(monkeypatch):
    monkeypatch.setenv("TESSDATA_PREFIX", "/spectra/tessdata")
    monkeypatch.setenv("SPECTRAPDF_ICC_ASSENT", "1")
    monkeypatch.setenv("PYTHONUTF8", "1")
    monkeypatch.setenv("OPENBLAS_NUM_THREADS", "1")
    monkeypatch.setenv("JAVA_HOME_USER_CHOICE", "kept")
    env = omr.child_environment()
    for name in ("TESSDATA_PREFIX", "SPECTRAPDF_ICC_ASSENT", "PYTHONUTF8", "OPENBLAS_NUM_THREADS"):
        assert name not in env
    assert env["JAVA_HOME_USER_CHOICE"] == "kept"


# ── Publish ──────────────────────────────────────────────────────────────


def test_publish_lands_the_scores_beside_the_document(tmp_path, mixed_pdf):
    answer, _ = _fake(tmp_path, "skip-second")
    _prepared, ran, published = _recognize(mixed_pdf, answer, keep=True, project_id="id-1")
    assert published["files"] == [
        {"path": str(tmp_path / "book.mvt1.mxl"), "movement": 1},
        {"path": str(tmp_path / "book.mvt2.mxl"), "movement": 2},
    ]
    assert published["project"] == str(tmp_path / "book.omr")
    assert published["projectId"] == "id-1"
    score = _score_of(tmp_path / "book.mvt2.mxl")
    assert "<source>" not in score and "source-file" not in score
    assert 'name="source-sheet-3"' in score


def test_publish_without_a_kept_project_returns_no_project_id(tmp_path, score_pdf):
    answer, _ = _fake(tmp_path, "ok")
    _p, _r, published = _recognize(score_pdf, answer, fmt="musicxml", project_id="id-2")
    assert published == {
        "files": [{"path": str(tmp_path / "song.musicxml"), "movement": 1}],
        "project": None,
        "projectId": None,
    }
    text = (tmp_path / "song.musicxml").read_text(encoding="utf-8")
    assert text.startswith("<?xml") and "<!DOCTYPE score-partwise" in text


def test_consent_is_a_set_of_names_and_the_stage_waits_for_it(tmp_path, mixed_pdf):
    answer, _ = _fake(tmp_path, "skip-second")
    for name in ("book.mxl", "book.mvt1.mxl", "book.mvt2.mxl", "book.omr"):
        (tmp_path / name).write_bytes(b"mine")
    token = recognize_music_prepare(str(mixed_pdf))["token"]
    recognize_music_run(token, keep_project=True, audiveris=answer)
    with pytest.raises(TargetsExist) as refused:
        recognize_music_publish(token, str(tmp_path), "book", keep_project=True, overwrite_names=["book.mxl"])
    assert str(refused.value) == (
        "These files already exist: book.mvt1.mxl, book.mvt2.mxl, book.omr. "
        "Choose another name or confirm the overwrite"
    )
    assert refused.value.rpc_data == {"names": ["book.mvt1.mxl", "book.mvt2.mxl", "book.omr"]}
    with pytest.raises(TargetsExist) as again:
        recognize_music_publish(
            token, str(tmp_path), "book", keep_project=True, overwrite_names=["book.mvt1.mxl", "book.mvt2.mxl"]
        )
    assert again.value.rpc_data == {"names": ["book.omr"]}
    for name in ("book.mvt1.mxl", "book.mvt2.mxl", "book.omr"):
        assert (tmp_path / name).read_bytes() == b"mine"
    published = recognize_music_publish(
        token, str(tmp_path), "book", keep_project=True,
        overwrite_names=["book.mvt1.mxl", "book.mvt2.mxl", "book.omr"],
    )
    assert len(published["files"]) == 2
    assert (tmp_path / "book.mxl").read_bytes() == b"mine"
    assert (tmp_path / "book.mvt1.mxl").read_bytes() != b"mine"
    recognize_music_discard(token)
    assert recognize_music_discard(token) == {"discarded": False}


def test_the_names_ride_the_error_reply_as_a_list(tmp_path, score_pdf):
    answer, _ = _fake(tmp_path, "ok")
    (tmp_path / "a, b.mxl").write_bytes(b"mine")
    token = recognize_music_prepare(str(score_pdf))["token"]
    recognize_music_run(token, audiveris=answer)
    server = JsonRpcServer()
    server.register("recognize_music_publish", recognize_music_publish)
    reply = server._handle(
        {"jsonrpc": "2.0", "id": 8, "method": "recognize_music_publish",
         "params": {"token": token, "output_dir": str(tmp_path), "base_name": "a, b"}}
    )
    assert reply["error"]["data"] == {"names": ["a, b.mxl"]}
    recognize_music_discard(token)


def test_publish_is_all_or_nothing(tmp_path, mixed_pdf, monkeypatch):
    answer, _ = _fake(tmp_path, "skip-second")
    (tmp_path / "book.mvt1.mxl").write_bytes(b"mine")
    token = recognize_music_prepare(str(mixed_pdf))["token"]
    recognize_music_run(token, keep_project=True, audiveris=answer)
    landed = []
    real = omr.finish_staged

    def second_fails(staged, target):
        if landed:
            raise PermissionError(f"{target} is held open")
        real(staged, target)
        landed.append(target)

    monkeypatch.setattr(omr, "finish_staged", second_fails)
    with pytest.raises(PermissionError):
        recognize_music_publish(
            token, str(tmp_path), "book", keep_project=True, overwrite_names=["book.mvt1.mxl"]
        )
    assert landed
    assert (tmp_path / "book.mvt1.mxl").read_bytes() == b"mine"
    assert not (tmp_path / "book.mvt2.mxl").exists()
    assert not (tmp_path / "book.omr").exists()
    assert sorted(p.name for p in tmp_path.iterdir() if p.name.startswith(".spectra-stage")) == []
    monkeypatch.setattr(omr, "finish_staged", real)
    published = recognize_music_publish(token, str(tmp_path), "book", overwrite_names=["book.mvt1.mxl"])
    assert len(published["files"]) == 2
    recognize_music_discard(token)


def test_a_restore_that_fails_is_reported_and_its_backup_kept(tmp_path, mixed_pdf, monkeypatch):
    answer, _ = _fake(tmp_path, "skip-second")
    (tmp_path / "book.mvt1.mxl").write_bytes(b"mine")
    token = recognize_music_prepare(str(mixed_pdf))["token"]
    recognize_music_run(token, audiveris=answer)
    landed = []
    real = omr.finish_staged

    def second_fails(staged, target):
        if landed:
            raise PermissionError(f"{target} is held open")
        real(staged, target)
        landed.append(target)

    def restore_fails(backup, target):
        raise OSError("the original cannot be put back")

    monkeypatch.setattr(omr, "finish_staged", second_fails)
    monkeypatch.setattr(omr, "_restore", restore_fails)
    with pytest.raises(PermissionError) as failed:
        recognize_music_publish(token, str(tmp_path), "book", overwrite_names=["book.mvt1.mxl"])
    data = failed.value.rpc_data
    target = str(tmp_path / "book.mvt1.mxl")
    assert data["landed"] == [target]
    backup = Path(data["unrestored"][target])
    assert backup.read_bytes() == b"mine"
    backup.unlink()
    recognize_music_discard(token)


@pytest.mark.parametrize(
    "options, message",
    [
        ({"format": "mei"}, "unsupported music format 'mei' (have mxl, musicxml)"),
        ({"base_name": "a/b"}, 'The score name cannot be empty, end with a dot or a space, or contain < > : " / \\ | ? *'),
        ({"base_name": "trailing."}, 'The score name cannot be empty, end with a dot or a space, or contain < > : " / \\ | ? *'),
    ],
)
def test_publish_arguments_are_refused_by_name(tmp_path, score_pdf, options, message):
    answer, _ = _fake(tmp_path, "ok")
    token = recognize_music_prepare(str(score_pdf))["token"]
    recognize_music_run(token, audiveris=answer)
    arguments = {"base_name": "song", **options}
    with pytest.raises(ValueError) as refused:
        recognize_music_publish(token, str(tmp_path), **arguments)
    assert str(refused.value) == message
    recognize_music_discard(token)


@pytest.mark.parametrize(
    "options, message",
    [
        ({"dpi": 150}, "The recognition resolution must be a whole number from 200 to 500 DPI"),
        ({"dpi": True}, "The recognition resolution must be a whole number from 200 to 500 DPI"),
        ({"ocr_lang": "eng;rm"}, "The OCR language must be language codes joined by +, for example eng+deu"),
    ],
)
def test_run_arguments_are_refused_by_name(tmp_path, score_pdf, options, message):
    answer, record = _fake(tmp_path, "ok")
    token = recognize_music_prepare(str(score_pdf))["token"]
    with pytest.raises(ValueError) as refused:
        recognize_music_run(token, audiveris=answer, **options)
    assert str(refused.value) == message
    assert not record.exists()
    recognize_music_discard(token)


# ── Attach ───────────────────────────────────────────────────────────────


def test_attach_embeds_the_score_as_a_supplement(tmp_path, mixed_pdf):
    answer, _ = _fake(tmp_path, "skip-second")
    _p, _r, published = _recognize(mixed_pdf, answer)
    for file in published["files"]:
        result = recognize_music_attach(str(mixed_pdf), str(mixed_pdf), file["path"])
        assert result["output"] == str(mixed_pdf)
        assert result["structureTies"] == {"tied": [], "untied": [], "tagged": False}
    with pikepdf.open(mixed_pdf) as pdf:
        assert sorted(pdf.attachments.keys()) == ["book.mvt1.mxl", "book.mvt2.mxl"]
        assert len(pdf.Root.AF) == 2
        for spec in pdf.Root.AF:
            assert spec.AFRelationship == Name.Supplement
            assert str(spec.EF.F.Subtype) == MIME_MXL
            assert "/ModDate" in spec.EF.F.Params
        assert str(pdf.attachments["book.mvt2.mxl"].obj.Desc) == "MusicXML score recognized from page 3"
        embedded = pdf.attachments["book.mvt2.mxl"].get_file().read_bytes()
    assert embedded == (tmp_path / "book.mvt2.mxl").read_bytes()
    again = recognize_music_attach(str(mixed_pdf), str(mixed_pdf), published["files"][0]["path"])
    assert again["output"] == str(mixed_pdf)
    with pikepdf.open(mixed_pdf) as pdf:
        assert len(pdf.Root.AF) == 2


def test_attach_writes_the_output_it_is_given(tmp_path, score_pdf):
    answer, _ = _fake(tmp_path, "ok")
    _recognize(score_pdf, answer)
    before = score_pdf.read_bytes()
    staged = tmp_path / "stage.pdf"
    result = recognize_music_attach(str(score_pdf), str(staged), str(tmp_path / "song.mxl"))
    assert result["output"] == str(staged)
    assert score_pdf.read_bytes() == before
    with pikepdf.open(staged) as pdf:
        assert list(pdf.attachments.keys()) == ["song.mxl"]


def test_attach_ties_the_score_to_the_one_figure_of_each_page(tmp_path, mixed_pdf):
    tagged = tmp_path / "tagged.pdf"
    with pikepdf.open(mixed_pdf) as pdf:
        pages = list(pdf.pages)
        root = pdf.make_indirect(Dictionary(Type=Name.StructTreeRoot))
        document = pdf.make_indirect(Dictionary(Type=Name.StructElem, S=Name.Document, P=root))
        kids = []
        for index, figures in ((0, 1), (2, 2)):
            for _ in range(figures):
                kids.append(pdf.make_indirect(Dictionary(
                    Type=Name.StructElem, S=Name.Figure, P=document, Pg=pages[index].obj, K=0)))
        document.K = Array(kids)
        root.K = document
        pdf.Root.StructTreeRoot = root
        pdf.save(tagged)
    answer, _ = _fake(tmp_path, "skip-second")
    _p, _r, published = _recognize(tagged, answer)
    first = recognize_music_attach(str(tagged), str(tagged), published["files"][0]["path"])
    second = recognize_music_attach(str(tagged), str(tagged), published["files"][1]["path"])
    assert first["structureTies"] == {"tied": [1], "untied": [], "tagged": True}
    assert second["structureTies"] == {"tied": [], "untied": [3], "tagged": True}
    with pikepdf.open(tagged) as pdf:
        figures = list(pdf.Root.StructTreeRoot.K.K)
        assert len(figures[0].AF) == 1
        assert figures[0].AF[0].UF == "tagged.mvt1.mxl"
        assert all("/AF" not in figure for figure in figures[1:])


def test_attach_refuses_a_pdfa_document(tmp_path, score_pdf):
    answer, _ = _fake(tmp_path, "ok")
    _recognize(score_pdf, answer)
    claimed = tmp_path / "archive.pdf"
    with pikepdf.open(score_pdf) as pdf:
        with pdf.open_metadata(set_pikepdf_as_editor=False) as meta:
            meta["pdfaid:part"] = "2"
            meta["pdfaid:conformance"] = "B"
        pdf.save(claimed)
    with pytest.raises(ValueError) as refused:
        recognize_music_attach(str(claimed), str(claimed), str(tmp_path / "song.mxl"))
    assert str(refused.value) == PDFA_REFUSAL


@pytest.mark.parametrize("name, body", [("notes.txt", b"x"), ("fake.mxl", b"not a zip"), ("page.musicxml", b"<html/>")])
def test_attach_refuses_a_file_that_is_not_a_score(tmp_path, score_pdf, name, body):
    path = tmp_path / name
    path.write_bytes(body)
    with pytest.raises(ValueError) as refused:
        recognize_music_attach(str(score_pdf), str(score_pdf), str(path))
    assert str(refused.value) == "The score to attach must be a .mxl or .musicxml file"


# ── The guided step ──────────────────────────────────────────────────────


def test_the_step_takes_the_door_parameters():
    clean = validate_steps([{"op": "omr", "params": {"format": "musicxml", "dpi": 400, "keep_project": True}}])
    assert clean == [{"op": "omr", "params": {"format": "musicxml", "dpi": 400, "keep_project": True}}]
    with pytest.raises(ValueError, match="parameters not recognized"):
        validate_steps([{"op": "omr", "params": {"output_dir": "x"}}])


def test_a_mirror_run_lands_scores_beside_each_copy(tmp_path, score_pdf):
    source = tmp_path / "in"
    (source / "sub").mkdir(parents=True)
    shutil.copy2(score_pdf, source / "a.pdf")
    shutil.copy2(score_pdf, source / "sub" / "b.pdf")
    dest = tmp_path / "out"
    answer, _ = _fake(tmp_path, "ok")
    report = run_action(str(source), str(dest), [{"op": "omr", "params": {}}], audiveris=answer)
    assert report["ok"] == 2, report
    assert (dest / "a.mxl").is_file() and (dest / "sub" / "b.mxl").is_file()
    again = run_action(str(source), str(dest), [{"op": "omr", "params": {"overwrite": True}}], audiveris=answer)
    assert again["ok"] == 2, again
    refused = run_action(str(source), str(dest), [{"op": "omr", "params": {}}], audiveris=answer)
    assert refused["failed"] == 2
    assert "These files already exist: a.mxl" in refused["results"][0]["error"]


def test_an_in_place_run_names_scores_after_the_originals(tmp_path, score_pdf):
    source = tmp_path / "in"
    source.mkdir()
    shutil.copy2(score_pdf, source / "a.pdf")
    answer, _ = _fake(tmp_path, "ok")
    report = run_action(str(source), "", [{"op": "omr", "params": {}}], in_place=True, audiveris=answer)
    assert report["ok"] == 1, report
    assert sorted(p.name for p in source.iterdir()) == ["a.mxl", "a.pdf"]


def _folder_run(tmp_path, score_pdf, existing, params=None):
    source = tmp_path / "in"
    source.mkdir()
    shutil.copy2(score_pdf, source / "a.pdf")
    dest = tmp_path / "out"
    dest.mkdir()
    for name in existing:
        (dest / name).write_bytes(b"mine")
    answer, record = _fake(tmp_path, "ok")
    report = run_action(str(source), str(dest), [{"op": "omr", "params": params or {}}], audiveris=answer)
    return report, record, dest


@pytest.mark.parametrize(
    "existing, params, refused",
    [
        (["a.mxl", "a.mvt1.mxl"], {}, "a.mxl, a.mvt1.mxl"),
        (["a.omr"], {"keep_project": True}, "a.omr"),
    ],
)
def test_a_folder_run_refuses_a_certain_conflict_before_audiveris_runs(tmp_path, score_pdf, existing, params, refused):
    report, record, dest = _folder_run(tmp_path, score_pdf, existing, params)
    assert report["failed"] == 1
    assert f"These files already exist: {refused}." in report["results"][0]["error"]
    assert not record.exists()
    assert all((dest / name).read_bytes() == b"mine" for name in existing)


def test_a_folder_run_leaves_an_uncertain_name_to_the_exact_check(tmp_path, score_pdf):
    report, record, dest = _folder_run(tmp_path, score_pdf, ["a.mvt1.mxl", "a.omr"])
    assert report["ok"] == 1, report
    assert record.exists()
    assert (dest / "a.mxl").is_file()
    assert (dest / "a.mvt1.mxl").read_bytes() == b"mine"
    assert (dest / "a.omr").read_bytes() == b"mine"


def test_a_folder_run_refuses_after_the_run_on_the_exact_name(tmp_path, score_pdf):
    report, record, dest = _folder_run(tmp_path, score_pdf, ["a.mxl"])
    assert report["failed"] == 1
    assert "These files already exist: a.mxl." in report["results"][0]["error"]
    assert record.exists()
    assert (dest / "a.mxl").read_bytes() == b"mine"


def test_a_run_refuses_before_its_first_row(tmp_path, score_pdf):
    source = tmp_path / "in"
    source.mkdir()
    shutil.copy2(score_pdf, source / "a.pdf")
    dest = tmp_path / "out"
    with pytest.raises(RuntimeError, match="^Audiveris is not set up"):
        run_action(str(source), str(dest), [{"op": "optimize"}, {"op": "omr"}], audiveris={"kind": "not-configured"})
    assert not dest.exists()


# ── Present axis ─────────────────────────────────────────────────────────

AUDIVERIS_MISSING = "Audiveris 5.11 or newer not installed: set SPECTRAPDF_AUDIVERIS_PATH to its program"


def _installed_audiveris() -> str | None:
    named = os.environ.get(omr.PATH_ENV_VAR, "").strip()
    candidates = [named] if named else []
    if os.name == "nt":
        root = os.environ.get("ProgramW6432") or os.environ.get("ProgramFiles") or r"C:\Program Files"
        candidates.append(os.path.join(root, "Audiveris", "Audiveris.exe"))
    else:
        candidates.append("/opt/audiveris/bin/Audiveris")
    candidates += [shutil.which("audiveris") or "", shutil.which("Audiveris") or ""]
    for candidate in filter(None, candidates):
        if not os.path.isfile(candidate):
            continue
        try:
            out = subprocess.run(
                [candidate, "-version"], capture_output=True, text=True, timeout=120,
                stdin=subprocess.DEVNULL, env=omr.child_environment(),
            )
        except (OSError, subprocess.SubprocessError):
            continue
        for line in out.stdout.splitlines():
            if line.strip().startswith("- Version:"):
                version = tuple(int(p) for p in line.split(":", 1)[1].strip().split(".")[:2])
                if version >= (5, 11):
                    return candidate
    return None


@pytest.fixture(scope="module")
def audiveris() -> dict:
    found = _installed_audiveris()
    if found is None:
        pytest.skip(AUDIVERIS_MISSING)
    return {"kind": "ready", "launcher": "exe", "path": found}


def test_audiveris_recognizes_the_drawn_score(tmp_path, score_pdf, audiveris):
    _p, ran, published = _recognize(score_pdf, audiveris, keep=True, project_id="p")
    assert ran["skippedPages"] == []
    [landed] = published["files"]
    score = _score_of(Path(landed["path"]))
    assert score.count("<note") >= 10
    assert str(tmp_path) not in score
    assert Path(published["project"]).is_file()


def test_audiveris_skips_a_page_without_music(tmp_path, mixed_pdf, audiveris):
    _p, ran, published = _recognize(mixed_pdf, audiveris)
    assert ran["skippedPages"] == [2]
    assert [m["pages"] for m in ran["movements"]] == [[1], [3]]
    assert [Path(f["path"]).name for f in published["files"]] == ["book.mvt1.mxl", "book.mvt2.mxl"]


def test_audiveris_reads_a_stage_beyond_the_code_page(tmp_path, score_pdf, audiveris, monkeypatch):
    greek = tmp_path / "\u03a8\u03b7\u03c6\u03af\u03bf"
    greek.mkdir()
    monkeypatch.setattr(tempfile, "tempdir", str(greek))
    _p, _ran, published = _recognize(score_pdf, audiveris)
    assert [Path(f["path"]).name for f in published["files"]] == ["song.mxl"]


