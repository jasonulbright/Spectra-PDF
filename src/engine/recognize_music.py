"""Recognize printed music: selected pages to MusicXML through a user-installed Audiveris.

Audiveris is never bundled. The host (the window's Rust side, or the command
line) resolves and probes it and hands the run its answer as `audiveris`, the
same object `audiveris_status` reports. Without that answer the run reads
`SPECTRAPDF_AUDIVERIS_PATH`, and without either it refuses by name.

Five doors, so that no step holds the document longer than it reads it:

1. `recognize_music_prepare` (window process) reads the document once: the
   selected pages as an unencrypted PDF without annotations or hidden optional
   content, in a private stage named by a token. The stage outlives the call.
2. `recognize_music_run` (its own process) runs Audiveris on the stage only.
   A sheet with no staff is flagged invalid and fails the export with status 1
   while the project is still written; the run then exports the project once
   more, which skips the invalid sheets, and reports their pages as skipped.
   Every movement is parsed: exit status 0 is necessary, not sufficient.
3. `recognize_music_publish` lands the scores (and the project) beside the
   document, all of them or none. An existing target is replaced only when the
   caller names it in `overwrite_names`.
4. `recognize_music_attach` embeds one published score in the document as an
   associated file: an ordinary document edit.
5. `recognize_music_discard` removes the stage.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import shutil
import stat
import subprocess
import time
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import pikepdf
from lxml import etree
from pikepdf import Name
from pikepdf.models.metadata import encode_pdf_date

from engine import budget, pdf_save, platform_support
from engine.credentials import (
    PERMISSIONS_HELD,
    _gs_process_is_running,
    open_pdf,
    require_permission,
)
from engine.inplace import _discard, finish_staged, landing_path, refuse_hard_linked, staged_write, staging_target
from engine.ipc import RequestCancelled, cancelled
from engine.pdf_save import ABSENT, pdfa_claim, save_pdf
from engine.sanitize_content import off_ocg_set, remove_hidden_layer_content

PATH_ENV_VAR = "SPECTRAPDF_AUDIVERIS_PATH"

FLATPAK_APP_ID = "org.audiveris.audiveris"

#: Output formats, by the `format` value the doors take. A list, so another
#: notation format is one more row.
FORMATS = {"mxl": ".mxl", "musicxml": ".musicxml"}

#: IANA media types; ISO 32000-2 § 14.13.2 requires one on an associated file.
MEDIA_TYPES = {
    ".mxl": "application/vnd.recordare.musicxml",
    ".musicxml": "application/vnd.recordare.musicxml+xml",
}

#: The PDF render resolution range Audiveris documents as useful.
MIN_DPI = 200
MAX_DPI = 500

SCORE_ROOTS = frozenset({"score-partwise", "score-timewise", "opus"})

#: Constants every run passes. The output-shaping ones override whatever the
#: user's own Audiveris options persisted, so the stage always holds
#: `score.mxl` or `score.mvtN.mxl`.
FIXED_CONSTANTS = (
    "org.audiveris.omr.Main.persistBatchCliConstants=false",
    "org.audiveris.omr.sheet.BookManager.useCompression=true",
    "org.audiveris.omr.sheet.BookManager.useOpus=false",
)

#: The radix Audiveris names every output after.
_RADIX = "score"
_MOVEMENT = re.compile(r"^score(?:\.mvt(\d+))?\.mxl$")
_OCR_SPEC = re.compile(r"^[A-Za-z][A-Za-z0-9_]*(?:\+[A-Za-z][A-Za-z0-9_]*)*$")
_FORBIDDEN_NAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_TOKEN = re.compile(r"^(\d+)-[0-9a-f]{32}$")
#: Beside the primary root, names the stage a token keeps in the ASCII root.
_POINTER = ".stage"

_MAX_ENTRY_BYTES = 256 * 1024 * 1024
_MAX_ENTRIES = 64
_KEPT_LOGS = 20
_POLL_SECONDS = 0.2

_CREATE_SUSPENDED = 0x00000004
_CREATE_NO_WINDOW = 0x08000000

#: Variables Spectra sets for its own runtimes. Audiveris must read its own
#: OCR data and Java settings, never the engine's.
_SCRUBBED = frozenset({"TESSDATA_PREFIX", "OPENBLAS_NUM_THREADS", "GS_LIB", "WEBVIEW2_USER_DATA_FOLDER"})
_SCRUBBED_PREFIXES = ("SPECTRAPDF_", "PYTHON")

_META = "meta.json"
_RESULT = "result.json"


def _no_program() -> str:
    return "no program is at that path"


class TargetsExist(ValueError):
    """Targets a publication would replace without consent. `existing` is
    the list of their names, which the caller offers for consent."""

    def __init__(self, message: str, *, existing: list[str]) -> None:
        super().__init__(message)
        self.existing = list(existing)

    @property
    def rpc_data(self) -> dict:
        return {"names": self.existing}


def _refuse_existing(existing: list[str]) -> None:
    """The one refusal for every target a publication would replace."""
    if existing:
        names = ", ".join(existing)
        raise TargetsExist(
            f"These files already exist: {names}. Choose another name or confirm the overwrite",
            existing=existing,
        )


class _Unreadable(Exception):
    """An output Audiveris wrote that is not a MusicXML score."""


class MusicRecognitionFailed(RuntimeError):
    """A run that ended without a usable score. `log` names the run's log,
    which the caller offers as the details."""

    def __init__(self, message: str, *, log: str | None = None) -> None:
        super().__init__(message)
        self.log = log

    @property
    def rpc_data(self) -> dict:
        return {"log": self.log}


# ── The launcher ─────────────────────────────────────────────────────────


def require_launcher(audiveris) -> list[str]:
    """The argv prefix that starts Audiveris, or a refusal by name."""
    if isinstance(audiveris, dict):
        kind = audiveris.get("kind")
        path = audiveris.get("path") or ""
        launcher = audiveris.get("launcher")
        if kind == "ready" and launcher == "flatpak":
            return ["flatpak", "run"]
        if kind == "ready" and launcher == "exe" and path:
            return [path]
        if kind in (None, "not-configured") or not path:
            raise RuntimeError(
                "Audiveris is not set up. Install it, then point Spectra PDF at it in Preferences ▸ Engine."
            )
        reason = _reason_text(kind, audiveris)
        raise RuntimeError(f"Audiveris at {path} could not be run: {reason}")
    path = os.environ.get(PATH_ENV_VAR, "").strip()
    if not path:
        raise RuntimeError(
            "Audiveris is not set up. Install it, then point Spectra PDF at it in Preferences ▸ Engine."
        )
    if not os.path.isfile(path):
        reason = _no_program()
        raise RuntimeError(f"Audiveris at {path} could not be run: {reason}")
    return [path]


def _reason_text(kind: str, answer: dict) -> str:
    detail = str(answer.get("detail") or "").strip()
    if kind == "version-below-minimum":
        version = answer.get("version") or "an unknown version"
        return f"it is {version}, older than the 5.11 this feature needs"
    if kind == "not-executable":
        return detail or _no_program()
    return detail or "it did not pass its check"


def _is_flatpak(launcher: list[str]) -> bool:
    return launcher[:2] == ["flatpak", "run"]


def child_environment() -> dict[str, str]:
    """The engine's environment without the variables Spectra sets for itself."""
    return {
        name: value
        for name, value in os.environ.items()
        if name.upper() not in _SCRUBBED and not name.upper().startswith(_SCRUBBED_PREFIXES)
    }


# ── Paths Audiveris can read ─────────────────────────────────────────────


def short_path(path) -> str:
    """The 8.3 spelling of an existing Windows path, or the path itself where
    there is none. The Java launcher converts its arguments through the ANSI
    code page, so a name outside it reaches Audiveris as question marks."""
    text = str(path)
    if os.name != "nt":
        return text
    import ctypes
    from ctypes import wintypes

    get = ctypes.WinDLL("kernel32", use_last_error=True).GetShortPathNameW
    get.argtypes = (wintypes.LPCWSTR, wintypes.LPWSTR, wintypes.DWORD)
    get.restype = wintypes.DWORD
    size = get(text, None, 0)
    if size == 0:
        return text
    buffer = ctypes.create_unicode_buffer(size)
    written = get(text, buffer, size)
    return buffer.value if 0 < written < size else text


def audiveris_argument(path) -> str | None:
    """`path` as Audiveris can read it, or None when no spelling of it can
    pass the Windows code page."""
    spelled = short_path(path)
    if os.name == "nt" and not spelled.isascii():
        return None
    return spelled


def _ascii_base() -> Path:
    drive = os.environ.get("SystemDrive") or "C:"
    return Path(drive + "\\") / "ProgramData" / "spectrapdf" / "scratch"


def _ascii_root(base: Path | None = None) -> Path | None:
    """A per-user stage root whose path is ASCII: a folder under the machine's
    ProgramData whose DACL lets only this account in. A folder this process
    does not own (an elevated run left it to Administrators, or another
    account made it) is taken over, and any other entry in its DACL is
    removed. None where that path is not ASCII, is a link, or cannot be taken
    over and made private."""
    if os.name != "nt":
        return None
    base = base if base is not None else _ascii_base()
    if not str(base).isascii():
        return None
    try:
        out = platform_support.run(
            ["whoami", "/user", "/fo", "csv", "/nh"],
            capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=30,
        )
        sid = out.stdout.strip().rsplit(",", 1)[-1].strip().strip('"')
        if not re.fullmatch(r"S-1-[0-9-]+", sid):
            return None
        folder = base / f"omr-{sid}"
        folder.mkdir(parents=True, exist_ok=True)
        meta = os.lstat(folder)
        if not stat.S_ISDIR(meta.st_mode) or getattr(meta, "st_file_attributes", 0) & 0x400:
            return None

        def icacls(*arguments: str) -> bool:
            done = platform_support.run(
                ["icacls", str(folder), *arguments],
                capture_output=True, stdin=subprocess.DEVNULL, timeout=30,
            )
            return done.returncode == 0

        restrict = ("/inheritance:r", "/grant:r", f"*{sid}:(OI)(CI)F")
        if not platform_support.owned_entry(folder, directory=True) and not icacls("/setowner", f"*{sid}"):
            return None
        if not platform_support.dacl_grants_only(folder, sid):
            icacls(*restrict)
        if not platform_support.dacl_grants_only(folder, sid):
            if not (icacls("/reset") and icacls(*restrict)):
                return None
        if platform_support.owned_entry(folder, directory=True) and platform_support.dacl_grants_only(folder, sid):
            return folder
        return None
    except (OSError, subprocess.SubprocessError):
        return None


# ── The stage ────────────────────────────────────────────────────────────


def _primary_root() -> Path:
    """The private stage root. A flatpak sandbox cannot be given a folder
    under the host's /tmp, so Linux stages in the user's cache folder."""
    if os.name == "nt":
        return platform_support.private_cache_dir("omr")
    cache = os.environ.get("XDG_CACHE_HOME") or os.path.join(os.path.expanduser("~"), ".cache")
    root = Path(cache) / "spectrapdf"
    root.mkdir(parents=True, exist_ok=True)
    platform_support.ensure_private_dir(root)
    folder = root / "omr"
    platform_support.ensure_private_dir(folder)
    return folder


def _reclaim_stages(root: Path) -> None:
    """Remove stage folders whose preparing process no longer runs."""
    try:
        names = os.listdir(root)
    except OSError:
        return
    for name in names:
        match = _TOKEN.match(name.removesuffix(_POINTER))
        if match is None:
            continue
        pid = int(match.group(1))
        if pid == os.getpid() or _gs_process_is_running(pid):
            continue
        path = root / name
        if platform_support.owned_entry(path, directory=True):
            shutil.rmtree(path, ignore_errors=True)
        elif platform_support.owned_entry(path, directory=False) and name.endswith(_POINTER):
            path.unlink(missing_ok=True)


def _remove_stage(stage: Path) -> None:
    """Remove a stage folder. A process a cancel ended can still hold its log
    open for a moment after the kill, so a failed removal is retried."""
    for _attempt in range(25):
        shutil.rmtree(stage, ignore_errors=True)
        if not stage.exists():
            return
        time.sleep(0.2)


def _new_stage() -> tuple[str, Path]:
    token = f"{os.getpid()}-{secrets.token_hex(16)}"
    primary = _primary_root()
    _reclaim_stages(primary)
    stage = primary / token
    stage.mkdir()
    if audiveris_argument(stage) is not None:
        return token, stage
    _remove_stage(stage)
    fallback = _ascii_root()
    if fallback is not None:
        _reclaim_stages(fallback)
        stage = fallback / token
        stage.mkdir()
        (primary / f"{token}{_POINTER}").write_text(str(stage), encoding="utf-8")
        return token, stage
    folder = str(primary)
    raise RuntimeError(
        f"Audiveris cannot read the folder {folder}: its path uses characters outside the "
        "system code page and has no short name"
    )


def _stage(token) -> Path:
    """The stage a token names, in whichever root holds it."""
    if not isinstance(token, str) or _TOKEN.match(token) is None:
        raise ValueError("This recognition has ended; start Recognize music again")
    primary = _primary_root()
    candidates = [primary / token]
    pointer = primary / f"{token}{_POINTER}"
    if platform_support.owned_entry(pointer, directory=False):
        named = Path(pointer.read_text(encoding="utf-8").strip())
        if named.name == token and named.parent.name.startswith("omr-S-"):
            candidates.append(named)
    for stage in candidates:
        if platform_support.owned_entry(stage, directory=True) and (stage / _META).is_file():
            return stage
    raise ValueError("This recognition has ended; start Recognize music again")


def _read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _write_json(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value), encoding="utf-8")


# ── Arguments ────────────────────────────────────────────────────────────


def _selected_pages(pages, count: int) -> list[int]:
    if pages is None or pages == "all" or pages == []:
        return list(range(1, count + 1))
    if not isinstance(pages, list) or not all(
        isinstance(p, int) and not isinstance(p, bool) for p in pages
    ):
        raise ValueError("pages must be a list of page numbers, or 'all'")
    for page in pages:
        if page < 1 or page > count:
            raise ValueError(f"Page {page} is outside the document, which has {count} pages")
    return sorted(set(pages))


def _check_name(base_name: str) -> str:
    name = base_name.strip()
    if not name or name in (".", "..") or _FORBIDDEN_NAME.search(name) or name.endswith((".", " ")):
        raise ValueError(
            'The score name cannot be empty, end with a dot or a space, or contain < > : " / \\ | ? *'
        )
    return name


def _check_format(fmt) -> str:
    key = str(fmt).lower()
    if key not in FORMATS:
        raise ValueError(f"unsupported music format {fmt!r} (have mxl, musicxml)")
    return key


def _ocr_spec(ocr_lang) -> str | None:
    """The Tesseract specification `ocr_lang` names, or None for no OCR
    language constant. None, a blank string and an empty list name none; a
    list of codes is joined with `+`, and a blank item in it is refused."""
    if ocr_lang is None:
        return None
    if isinstance(ocr_lang, str):
        spec = ocr_lang.strip()
        if spec == "":
            return None
    elif isinstance(ocr_lang, (list, tuple)) and all(isinstance(code, str) for code in ocr_lang):
        if not ocr_lang:
            return None
        codes = [code.strip() for code in ocr_lang]
        spec = "+".join(codes) if all(codes) else None
    else:
        spec = None
    if spec is None or not _OCR_SPEC.match(spec):
        raise ValueError(
            "The OCR language must be language codes joined by +, for example eng+deu"
        )
    return spec


def _check_run_options(dpi, ocr_lang) -> str | None:
    """The OCR specification the run passes, after refusing a bad option."""
    if dpi is not None and (
        isinstance(dpi, bool) or not isinstance(dpi, int) or not MIN_DPI <= dpi <= MAX_DPI
    ):
        raise ValueError("The recognition resolution must be a whole number from 200 to 500 DPI")
    return _ocr_spec(ocr_lang)


def _refuse_pdfa(pdf) -> None:
    if pdfa_claim(pdf) != ABSENT:
        raise ValueError(
            "The score cannot be attached to a document that claims PDF/A conformance; "
            "the MusicXML file beside the document is still written"
        )


# ── 1. Prepare ───────────────────────────────────────────────────────────

_INHERITED = ("/MediaBox", "/CropBox", "/Rotate", "/Resources")


def _push_inherited(page) -> None:
    """Copy the page attributes the page tree supplies onto the page itself,
    so a page copied out of its tree keeps its size, rotation and resources."""
    for key in _INHERITED:
        if key in page.obj:
            continue
        node = page.obj.get("/Parent")
        depth = 0
        while isinstance(node, pikepdf.Dictionary) and depth < 64:
            if key in node:
                page.obj[key] = node[key]
                break
            node = node.get("/Parent")
            depth += 1


def _write_selection(file: str, pages, target: Path) -> tuple[list[int], int]:
    """The selected pages as an unencrypted PDF without annotations and
    without the content of optional-content groups the default configuration
    hides. Returns (selected 1-based pages, the document's page count)."""
    with open_pdf(file) as source:
        count = len(source.pages)
        if count == 0:
            raise ValueError("The document has no pages")
        selected = _selected_pages(pages, count)
        out = pikepdf.new()
        for number in selected:
            page = source.pages[number - 1]
            _push_inherited(page)
            out.pages.append(page)
        properties = source.Root.get("/OCProperties")
        if isinstance(properties, pikepdf.Dictionary):
            if not properties.is_indirect:
                properties = source.make_indirect(properties)
            out.Root.OCProperties = out.copy_foreign(properties)
            hidden = off_ocg_set(out)
            if hidden:
                remove_hidden_layer_content(out, hidden)
        for page in out.pages:
            if "/Annots" in page.obj:
                del page.obj["/Annots"]
        pdf_save.save_pdf(out, str(target))
    return selected, count


def recognize_music_prepare(file: str, pages=None, attach: bool = False) -> dict:
    """Read the pages to recognize out of `file` into a private stage.

    Args:
        file: the document.
        pages: 1-based page numbers, or None / 'all'.
        attach: the scores are to be attached to the document afterwards; a
            document that claims PDF/A is refused here, before any run.

    Returns `token` (names the stage for the other doors), `pageCount` and
    `pages` (the selection, deduplicated and in document order).
    """
    source = Path(file)
    if not source.is_file():
        raise ValueError(f"input file not found: {file}")
    try:
        require_permission(file, "copy")
    except PermissionError as exc:
        if exc.errno is not None or exc.args != (PERMISSIONS_HELD,):
            raise
        raise PermissionError("Recognize music needs the copy permission of this document") from exc
    if attach:
        require_permission(file, "modify")
        with open_pdf(file) as pdf:
            if pdfa_claim(pdf) != ABSENT:
                raise ValueError(
                    "The score cannot be attached to a document that claims PDF/A conformance. "
                    "Turn off Attach to recognize this document."
                )
    token, stage = _new_stage()
    try:
        (stage / "in").mkdir()
        selected, count = _write_selection(file, pages, stage / "in" / f"{_RADIX}.pdf")
        _write_json(stage / _META, {"pages": selected, "pageCount": count})
    except BaseException:
        _remove_stage(stage)
        (_primary_root() / f"{token}{_POINTER}").unlink(missing_ok=True)
        raise
    return {"token": token, "pageCount": count, "pages": selected}


# ── 2. Run ───────────────────────────────────────────────────────────────


def _terminate(process: subprocess.Popen, job) -> None:
    if os.name == "posix":
        import signal

        try:
            os.killpg(process.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
    elif job is not None:
        job.close()
    try:
        process.kill()
    except OSError:
        pass


def _run(argv: list[str], log_path: Path, allowed: float, pages: int) -> int:
    """Run Audiveris to its exit. Its output goes to `log_path`. A cancel of
    the request ends its whole process tree."""
    options: dict = {}
    if os.name == "nt":
        options["creationflags"] = _CREATE_SUSPENDED | _CREATE_NO_WINDOW
    with open(log_path, "ab") as log:
        try:
            process = platform_support.popen(
                argv,
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=subprocess.STDOUT,
                env=child_environment(),
                start_new_session=(os.name == "posix"),
                **options,
            )
        except OSError as exc:
            path = argv[0]
            reason = exc.strerror or str(exc)
            raise RuntimeError(f"Audiveris at {path} could not be run: {reason}") from exc
        job = None
        try:
            job = budget.contain_windows_child(process)
            deadline = time.monotonic() + allowed
            while True:
                try:
                    return process.wait(timeout=_POLL_SECONDS)
                except subprocess.TimeoutExpired:
                    pass
                if cancelled():
                    raise RequestCancelled()
                if time.monotonic() >= deadline:
                    raise budget.timed_out("Music recognition", allowed, pages=pages)
        finally:
            _terminate(process, job)
            process.wait()


def _command(launcher: list[str], stage: Path, output: Path, inputs: Path, dpi, ocr_lang) -> list[str]:
    argv = list(launcher)
    if _is_flatpak(launcher):
        argv += [f"--filesystem={stage}", FLATPAK_APP_ID]
    argv += ["-batch", "-export", "-output", audiveris_argument(output) or str(output)]
    if dpi is not None:
        argv += ["-constant", f"org.audiveris.omr.image.ImageLoading.pdfResolution={dpi}"]
    if ocr_lang:
        argv += ["-constant", f"org.audiveris.omr.text.Language.defaultSpecification={ocr_lang}"]
    for constant in FIXED_CONSTANTS:
        argv += ["-constant", constant]
    argv += ["--", audiveris_argument(inputs) or str(inputs)]
    return argv


def _parser() -> etree.XMLParser:
    return etree.XMLParser(
        resolve_entities=False, load_dtd=False, no_network=True, huge_tree=False, recover=False
    )


def _local(tag) -> str:
    return etree.QName(tag).localname if isinstance(tag, str) else ""


def _read_entry(archive: zipfile.ZipFile, name: str) -> bytes:
    info = archive.getinfo(name)
    if info.file_size > _MAX_ENTRY_BYTES:
        raise _Unreadable(name)
    return archive.read(info)


def _book(project: Path) -> tuple[list[int], list[list[int]]]:
    """(invalid sheet numbers, the sheet numbers of each score) from the
    project's `book.xml`, the documented book schema."""
    with zipfile.ZipFile(project) as archive:
        root = etree.fromstring(_read_entry(archive, "book.xml"), _parser())
    invalid = [
        int(sheet.get("number"))
        for sheet in root.iter("sheet")
        if sheet.get("invalid") == "true" and str(sheet.get("number", "")).isdigit()
    ]
    scores = [
        [int(page.get("sheet-number")) for page in score.iter("page") if str(page.get("sheet-number", "")).isdigit()]
        for score in root.iter("score")
    ]
    return invalid, scores


def _score_xml(path: Path) -> tuple[str, bytes, etree._ElementTree]:
    """(rootfile name, its bytes, its parsed tree) of one `.mxl` file.
    Raises _Unreadable when the container or its score is not a score."""
    with zipfile.ZipFile(path) as archive:
        if len(archive.infolist()) > _MAX_ENTRIES:
            raise _Unreadable(path.name)
        container = etree.fromstring(_read_entry(archive, "META-INF/container.xml"), _parser())
        names = [
            element.get("full-path")
            for element in container.iter()
            if _local(element.tag) == "rootfile" and element.get("full-path")
        ]
        if not names:
            raise _Unreadable(path.name)
        data = _read_entry(archive, names[0])
    tree = etree.fromstring(data, _parser()).getroottree()
    if _local(tree.getroot().tag) not in SCORE_ROOTS:
        raise _Unreadable(path.name)
    return names[0], data, tree


def _relabel(tree: etree._ElementTree, sheet_pages: list[int]) -> bytes:
    """The score with its source fields naming the document's own pages.

    Audiveris records the path of the file it read, which is the private
    temporary file, and names each sheet field by its number within that
    file."""
    root = tree.getroot()
    for element in list(root.iter()):
        name = _local(element.tag)
        parent = element.getparent()
        if name == "source" and parent is not None and _local(parent.tag) == "identification":
            parent.remove(element)
        elif name == "miscellaneous-field":
            field = element.get("name") or ""
            if field == "source-file" and parent is not None:
                parent.remove(element)
            elif field.startswith("source-sheet-"):
                sheet = field[len("source-sheet-"):]
                if sheet.isdigit() and 1 <= int(sheet) <= len(sheet_pages):
                    element.set("name", f"source-sheet-{sheet_pages[int(sheet) - 1]}")
    return etree.tostring(tree, xml_declaration=True, encoding="UTF-8")


def _rezip(source: Path, rootfile: str, data: bytes, target: Path) -> None:
    """The container with its score replaced. Each entry keeps the name and
    timestamp Audiveris gave it, so one score has one container."""
    with zipfile.ZipFile(source) as archive, zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as out:
        for info in archive.infolist():
            body = data if info.filename == rootfile else _read_entry(archive, info.filename)
            entry = zipfile.ZipInfo(info.filename, date_time=info.date_time)
            entry.compress_type = zipfile.ZIP_DEFLATED
            out.writestr(entry, body)


def _keep_log(parts: list[Path], stage: Path) -> str | None:
    """The run's log, in the stage and in the private log folder (newest
    kept), so the details outlive the stage."""
    try:
        combined = stage / "run.log"
        with open(combined, "wb") as out:
            for part in parts:
                if part.is_file():
                    out.write(part.read_bytes())
        folder = platform_support.private_cache_dir("omr-logs")
        stamp = datetime.now().strftime("%Y%m%dT%H%M%S")
        target = folder / f"run-{stamp}-{os.getpid()}.log"
        shutil.copy2(combined, target)
        logs = sorted(folder.glob("*.log"), key=lambda p: p.stat().st_mtime, reverse=True)
        for old in logs[_KEPT_LOGS:]:
            try:
                old.unlink()
            except OSError:
                pass
        return str(target)
    except OSError:
        return None


def _suffix(index: int, count: int) -> str:
    """What a movement adds after the score's name: nothing for the only
    movement, `.mvtN` for one of several."""
    return "" if count == 1 else f".mvt{index}"


def recognize_music_run(
    token: str,
    dpi=None,
    ocr_lang=None,
    keep_project: bool = False,
    audiveris=None,
) -> dict:
    """Recognize the staged pages. Touches only the stage.

    Args:
        token: the stage `recognize_music_prepare` made.
        dpi: the resolution Audiveris renders each page at (200 to 500).
        ocr_lang: the Tesseract languages for titles and lyrics: codes
            joined by `+` or a list of codes. None, "" or [] passes no OCR
            language.
        keep_project: accepted for symmetry with publish; `project` reports
            whether the run produced a project publish could keep.
        audiveris: the host's capability answer for Audiveris.

    Returns `token`, `movements` ([{index, pages, name}]; `name` is the
    suffix the movement adds after the score's name), `project`,
    `skippedPages` (pages Audiveris found no staff on) and `log`.
    """
    ocr_lang = _check_run_options(dpi, ocr_lang)
    stage = _stage(token)
    launcher = require_launcher(audiveris)
    selected = list(_read_json(stage / _META)["pages"])
    selection = stage / "in" / f"{_RADIX}.pdf"
    exported = stage / "out"
    final = stage / "final"
    logs = stage / "logs"
    for folder in (exported, final, logs):
        _remove_stage(folder)
        folder.mkdir()
    (stage / _RESULT).unlink(missing_ok=True)
    allowed = budget.derive(base=300.0, pages=len(selected), per_page=300.0)
    first_log = logs / "run-1.log"
    parts = [first_log]
    project = exported / f"{_RADIX}.omr"
    try:
        status = _run(_command(launcher, stage, exported, selection, dpi, ocr_lang), first_log, allowed, len(selected))
        invalid: list[int] = []
        scores: list[list[int]] = []
        if project.is_file():
            try:
                invalid, scores = _book(project)
            except (OSError, KeyError, ValueError, _Unreadable, zipfile.BadZipFile, etree.XMLSyntaxError):
                invalid, scores = [], []
        if status == 1 and invalid and len(invalid) < len(selected):
            for stale in exported.glob(f"{_RADIX}*.log"):
                stale.replace(logs / stale.name)
            second_log = logs / "run-2.log"
            parts.append(second_log)
            status = _run(_command(launcher, stage, exported, project, None, ocr_lang), second_log, allowed, len(selected))
            if project.is_file():
                try:
                    invalid, scores = _book(project)
                except (OSError, KeyError, ValueError, _Unreadable, zipfile.BadZipFile, etree.XMLSyntaxError):
                    scores = []
    except (RequestCancelled, budget.TimeBudgetExceeded) as exc:
        exc.rpc_data = {"log": _keep_log(parts, stage)}
        raise
    log = _keep_log(parts, stage)
    if status != 0 and not (status == 1 and invalid and len(invalid) == len(selected)):
        raise MusicRecognitionFailed(f"Music recognition failed: Audiveris exited with status {status}", log=log)
    found = sorted(
        (int(match.group(1) or 0), path)
        for path in exported.iterdir()
        if (match := _MOVEMENT.match(path.name)) is not None
    )
    if not found or (scores and len(found) != len(scores)):
        raise MusicRecognitionFailed("Audiveris produced no readable score for the selected pages", log=log)
    movements = []
    for position, (number, path) in enumerate(found):
        index = number or position + 1
        sheets = scores[position] if position < len(scores) else list(range(1, len(selected) + 1))
        movement_pages = [selected[s - 1] for s in sheets if 1 <= s <= len(selected)] or selected
        try:
            rootfile, _data, tree = _score_xml(path)
        except (OSError, KeyError, ValueError, _Unreadable, zipfile.BadZipFile, etree.XMLSyntaxError) as exc:
            raise MusicRecognitionFailed(
                "Audiveris produced no readable score for the selected pages", log=log
            ) from exc
        _rezip(path, rootfile, _relabel(tree, selected), final / f"{index}.mxl")
        movements.append({"index": index, "pages": movement_pages, "name": _suffix(index, len(found))})
    skipped = sorted(selected[s - 1] for s in invalid if 1 <= s <= len(selected))
    has_project = project.is_file()
    _write_json(stage / _RESULT, {"movements": movements, "project": has_project, "skippedPages": skipped})
    return {
        "token": token,
        "movements": movements,
        "project": has_project,
        "skippedPages": skipped,
        "log": log,
    }


# ── 3. Publish ───────────────────────────────────────────────────────────


def target_names(stem: str, extension: str, movements: list[dict], keep_project: bool) -> list[str]:
    """Every file a publication writes, in order: the movements, then the
    project when it is kept."""
    names = [f"{stem}{movement['name']}{extension}" for movement in movements]
    return names + ([f"{stem}.omr"] if keep_project else [])


def _restore(backup: Path, target: Path) -> None:
    os.replace(backup, target)


def _publish_all(pairs: list[tuple[Path, Path]]) -> None:
    """Land every (source, target) pair or none of them. Each target is
    staged beside itself first; an existing target is copied aside before it
    is replaced, and a failed landing puts every replaced target back and
    removes every new one."""
    staged: list[tuple[Path, Path]] = []
    try:
        for source, target in pairs:
            target = landing_path(target)
            refuse_hard_linked(target)
            stage = staging_target(target)
            staged.append((stage, target))
            shutil.copy2(source, stage)
    except BaseException:
        for stage, _target in staged:
            _discard(stage)
        raise
    backups: dict[Path, Path] = {}
    landed: list[Path] = []
    try:
        for stage, target in staged:
            if target.exists():
                backup = staging_target(target)
                shutil.copy2(target, backup)
                backups[target] = backup
            finish_staged(stage, target)
            landed.append(target)
    except BaseException as exc:
        unrestored: dict[str, str] = {}
        for target in reversed(landed):
            backup = backups.pop(target, None)
            try:
                if backup is not None:
                    _restore(backup, target)
                else:
                    os.unlink(target)
            except OSError:
                unrestored[str(target)] = str(backup) if backup is not None else ""
        for stage, _target in staged:
            _discard(stage)
        for backup in backups.values():
            _discard(backup)
        if unrestored:
            exc.rpc_data = {"landed": [str(target) for target in landed], "unrestored": unrestored}
        raise
    for backup in backups.values():
        _discard(backup)


def recognize_music_publish(
    token: str,
    output_dir: str,
    base_name: str,
    format: str = "mxl",
    keep_project: bool = False,
    overwrite_names=None,
    project_id=None,
) -> dict:
    """Land the recognized scores in `output_dir`, all of them or none.

    Args:
        token: the stage a successful `recognize_music_run` left.
        output_dir: the folder the scores land in.
        base_name: the scores' name without extension. Several movements land
            as `<name>.mvt1.mxl`, ...
        format: 'mxl' (compressed) or 'musicxml' (plain).
        keep_project: also land the Audiveris project as `<name>.omr`.
        overwrite_names: the existing file names the caller agreed to
            replace. Any other existing target refuses the whole publication,
            naming every such file, and the stage stays for another try.
        project_id: the host's identifier for a published project.

    Returns `files` ([{path, movement}]), `project` and `projectId`.
    """
    fmt = _check_format(format)
    extension = FORMATS[fmt]
    stem = _check_name(base_name)
    folder = Path(output_dir)
    if not folder.is_dir():
        raise ValueError(f"output folder not found: {folder}")
    stage = _stage(token)
    if not (stage / _RESULT).is_file():
        raise ValueError("Recognize music has nothing to publish for this request")
    result = _read_json(stage / _RESULT)
    movements = result["movements"]
    project = stage / "out" / f"{_RADIX}.omr"
    kept = bool(keep_project and result.get("project") and project.is_file())
    names = target_names(stem, extension, movements, kept)
    consent = {str(name) for name in overwrite_names} if isinstance(overwrite_names, list) else set()
    _refuse_existing([name for name in names if (folder / name).exists() and name not in consent])
    ready = stage / "publish"
    _remove_stage(ready)
    ready.mkdir()
    pairs: list[tuple[Path, Path]] = []
    for movement, name in zip(movements, names):
        source = stage / "final" / f"{movement['index']}.mxl"
        if fmt == "musicxml":
            _rootfile, data, _tree = _score_xml(source)
            plain = ready / name
            plain.write_bytes(data)
            source = plain
        pairs.append((source, folder / name))
    if kept:
        pairs.append((project, folder / names[-1]))
    _publish_all(pairs)
    files = [
        {"path": str(folder / name), "movement": movement["index"]}
        for movement, name in zip(movements, names)
    ]
    published_project = str(folder / names[-1]) if kept else None
    return {
        "files": files,
        "project": published_project,
        "projectId": project_id if kept and isinstance(project_id, str) and project_id else None,
    }


# ── 4. Attach ────────────────────────────────────────────────────────────


def _role_of(element, role_map) -> str:
    kind = element.get("/S")
    seen = 0
    while isinstance(kind, Name) and role_map is not None and kind in role_map and seen < 8:
        mapped = role_map[kind]
        if not isinstance(mapped, Name) or mapped == kind:
            break
        kind = mapped
        seen += 1
    return str(kind) if isinstance(kind, Name) else ""


def _figures_by_page(pdf) -> dict:
    """page objgen -> the Figure structure elements whose content is on it."""
    root = pdf.Root.get("/StructTreeRoot")
    if not isinstance(root, pikepdf.Dictionary):
        return {}
    role_map = root.get("/RoleMap")
    if not isinstance(role_map, pikepdf.Dictionary):
        role_map = None
    found: dict = {}
    seen: set = set()
    stack = [(root.get("/K"), None)]
    while stack:
        node, page = stack.pop()
        if node is None:
            continue
        if isinstance(node, pikepdf.Array):
            stack.extend((kid, page) for kid in node)
            continue
        if not isinstance(node, pikepdf.Dictionary):
            continue
        if node.is_indirect:
            if node.objgen in seen:
                continue
            seen.add(node.objgen)
        if "/S" not in node:
            continue
        own = node.get("/Pg", page)
        if _role_of(node, role_map) == "/Figure":
            target = own
            if target is None:
                kids = node.get("/K")
                for kid in kids if isinstance(kids, pikepdf.Array) else [kids]:
                    if isinstance(kid, pikepdf.Dictionary) and "/Pg" in kid:
                        target = kid.Pg
                        break
            if isinstance(target, pikepdf.Dictionary) and target.is_indirect:
                found.setdefault(target.objgen, []).append(node)
        stack.append((node.get("/K"), own))
    return found


def _drop_reference(holder, spec) -> None:
    refs = holder.get("/AF")
    if isinstance(refs, pikepdf.Array):
        kept = [ref for ref in refs if not (ref.is_indirect and ref.objgen == spec.objgen)]
        holder.AF = pikepdf.Array(kept)


def _add_reference(holder, spec) -> None:
    refs = holder.get("/AF")
    if isinstance(refs, pikepdf.Dictionary):
        refs = pikepdf.Array([refs])
    if not isinstance(refs, pikepdf.Array):
        refs = pikepdf.Array()
    refs.append(spec)
    holder.AF = refs


def _score_pages(root) -> list[int]:
    """The document pages a relabelled score names in its sheet fields."""
    pages = set()
    for element in root.iter():
        if _local(element.tag) == "miscellaneous-field":
            field = element.get("name") or ""
            number = field[len("source-sheet-"):] if field.startswith("source-sheet-") else ""
            if number.isdigit():
                pages.add(int(number))
    return sorted(pages)


def _read_score(path: Path) -> tuple[bytes, str, list[int]]:
    """(the file's bytes, its media type, the pages it names), or a refusal
    when it is not a MusicXML score."""
    extension = path.suffix.lower()
    if extension not in MEDIA_TYPES or not path.is_file():
        raise ValueError("The score to attach must be a .mxl or .musicxml file")
    try:
        if extension == ".mxl":
            _rootfile, _data, tree = _score_xml(path)
        else:
            tree = etree.fromstring(path.read_bytes(), _parser()).getroottree()
            if _local(tree.getroot().tag) not in SCORE_ROOTS:
                raise _Unreadable(path.name)
    except (OSError, KeyError, ValueError, _Unreadable, zipfile.BadZipFile, etree.XMLSyntaxError) as exc:
        raise ValueError("The score to attach must be a .mxl or .musicxml file") from exc
    return path.read_bytes(), MEDIA_TYPES[extension], _score_pages(tree.getroot())


def recognize_music_attach(file: str, output: str, score_path: str) -> dict:
    """Embed the score at `score_path` in `file` as an associated file
    (ISO 32000-2 § 14.13; WTPDF 1.0 § 8.14.2 for the structure tie) and write
    the document to `output`.

    An attachment of the same name is replaced. Each page the score names that
    carries exactly one Figure structure element is tied to the score.

    Returns `output` and `structureTies` ({tied, untied, tagged}).
    """
    score = Path(score_path)
    data, mime, pages = _read_score(score)
    name = score.name
    require_permission(file, "modify")
    now = encode_pdf_date(datetime.now(timezone.utc))
    with open_pdf(file) as pdf:
        _refuse_pdfa(pdf)
        figures = _figures_by_page(pdf)
        if name in pdf.attachments:
            old = pdf.attachments[name].obj
            _drop_reference(pdf.Root, old)
            for elements in figures.values():
                for element in elements:
                    _drop_reference(element, old)
            del pdf.attachments[name]
        pages = [page for page in pages if 1 <= page <= len(pdf.pages)]
        if not pages:
            description = "MusicXML score"
        elif pages[0] == pages[-1]:
            description = f"MusicXML score recognized from page {pages[0]}"
        else:
            description = f"MusicXML score recognized from pages {pages[0]} to {pages[-1]}"
        spec = pikepdf.AttachedFileSpec(
            pdf,
            data,
            filename=name,
            description=description,
            mime_type=mime,
            creation_date=now,
            mod_date=now,
            relationship=Name.Supplement,
        )
        pdf.attachments[name] = spec
        stored = pdf.attachments[name].obj
        _add_reference(pdf.Root, stored)
        tied: list[int] = []
        untied: list[int] = []
        if figures:
            for number in pages:
                on_page = figures.get(pdf.pages[number - 1].objgen, [])
                if len(on_page) == 1:
                    _add_reference(on_page[0], stored)
                    tied.append(number)
                else:
                    untied.append(number)
        with staged_write(Path(output)) as staged:
            save_pdf(pdf, str(staged))
            pdf.close()
    ties = {"tied": tied, "untied": untied, "tagged": bool(figures)}
    return {"output": str(output), "structureTies": ties}


# ── 5. Discard ───────────────────────────────────────────────────────────


def recognize_music_discard(token: str) -> dict:
    """Remove the stage a token names. A stage already gone is not an error."""
    try:
        stage = _stage(token)
    except ValueError:
        return {"discarded": False}
    _remove_stage(stage)
    (_primary_root() / f"{token}{_POINTER}").unlink(missing_ok=True)
    return {"discarded": True}


# ── The whole sequence, for the guided step ─────────────────────────────


def recognize_document(
    file: str,
    output_dir: str,
    base_name: str,
    pages=None,
    format: str = "mxl",
    keep_project: bool = False,
    dpi=None,
    ocr_lang=None,
    overwrite: bool = False,
    audiveris=None,
) -> dict:
    """Prepare, run, publish and discard in one call, for a guided run that
    already owns the document. `overwrite` agrees to replace every target."""
    fmt = _check_format(format)
    stem = _check_name(base_name)
    _check_run_options(dpi, ocr_lang)
    require_launcher(audiveris)
    if not overwrite:
        # Only names every outcome writes refuse before the run: the score
        # is either `<stem><ext>` or `<stem>.mvt1<ext>`, so one of them alone
        # proves nothing. The exact names are checked after the run.
        extension = FORMATS[fmt]
        folder = Path(output_dir)
        single, first = f"{stem}{extension}", f"{stem}.mvt1{extension}"
        certain = [single, first] if (folder / single).exists() and (folder / first).exists() else []
        if keep_project and (folder / f"{stem}.omr").exists():
            certain.append(f"{stem}.omr")
        _refuse_existing(certain)
    prepared = recognize_music_prepare(file, pages=pages)
    token = prepared["token"]
    try:
        ran = recognize_music_run(token, dpi=dpi, ocr_lang=ocr_lang, keep_project=keep_project, audiveris=audiveris)
        kept = bool(keep_project and ran["project"])
        consent = target_names(stem, FORMATS[fmt], ran["movements"], kept) if overwrite else []
        published = recognize_music_publish(
            token, output_dir, stem, format=fmt, keep_project=keep_project, overwrite_names=consent
        )
    finally:
        recognize_music_discard(token)
    return {**published, "skippedPages": ran["skippedPages"], "log": ran["log"]}
