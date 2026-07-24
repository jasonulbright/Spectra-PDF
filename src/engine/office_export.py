"""Export a PDF to an editable Office / web format via LibreOffice headless (O1).

LibreOffice is bundled and invoked as an isolated subprocess (the Ghostscript
model — unmodified upstream, redistributed under MPL-2.0; see
THIRD-PARTY-LICENSES.md § LibreOffice). It is never linked into this app's code.

Import quirk that shapes this module: LibreOffice imports EVERY PDF as a **Draw**
document. Draw exports cleanly to web/vector/image targets (HTML, XHTML), but the
Writer word-processing filters (.docx/.rtf/.odt) cannot write a Draw document —
`soffice --convert-to docx` on a PDF fails at the write step ("SfxBaseModel::
impl_store … 0xc10"). So Writer targets go through a two-step bridge: PDF → HTML
(Draw's own export, which carries the real text) → the Writer format (Writer opens
the HTML and saves it out). The bridge preserves editable text — verified: a
born-digital PDF's sentences come back as real ``<w:t>`` runs, not a page image.

Each call uses a FRESH, throwaway user-profile directory: a headless soffice
refuses to start a second instance against a profile another soffice (e.g. the
user's open GUI copy) already holds, and would silently hang. The profile and any
bridge temp are cleaned up in a finally.
"""

import os
import shutil
import subprocess
import tempfile
from pathlib import Path

# format key -> (extension, soffice --convert-to filter, needs the HTML bridge)
# The filter strings are LibreOffice's registered filter names; the Writer ones
# are only reachable through the bridge (see the module docstring).
_FORMATS = {
    "docx": (".docx", "docx:MS Word 2007 XML", True),
    "rtf": (".rtf", "rtf:Rich Text Format", True),
    "odt": (".odt", "odt:writer8", True),
    "html": (".html", "html", False),
    "xhtml": (".xhtml", "xhtml:XHTML Writer File", False),
}

# LibreOffice's own first-run + import can be slow on a cold profile; a large PDF
# plus the bridge's second launch stays well under this.
_TIMEOUT = 240


def _kill_tree(pid: int) -> None:
    """Kill a process and its children. soffice.exe launches soffice.bin as a
    child, so a bare kill of the tracked pid leaves the worker running and its
    profile dir locked — taskkill /T terminates the whole tree (Windows-only,
    which this app is). Best-effort: a race where it already exited is fine."""
    try:
        subprocess.run(
            ["taskkill", "/F", "/T", "/PID", str(pid)],
            capture_output=True,
            stdin=subprocess.DEVNULL,
            timeout=15,
        )
    except (OSError, subprocess.SubprocessError):
        pass


def supported_formats() -> dict:
    """The export targets this build offers (for the UI + CLI help)."""
    return {"formats": sorted(_FORMATS.keys())}


def _run_soffice(soffice_path: str, convert_to: str, src: Path, out_dir: Path, want_ext: str) -> Path:
    """One `soffice --headless --convert-to` pass. Returns the produced file.

    LibreOffice names the output after the INPUT's stem with the filter's
    extension, into ``out_dir`` — it ignores any name we might want, so the
    caller renames the result to the user's chosen path.

    ``want_ext`` (".rtf", ".docx", …) disambiguates the bridge case: the HTML
    intermediate ``s.html`` and the new ``s.rtf`` share a stem in the same
    directory, so a stem-only match could grab the intermediate. Match on the
    expected extension and exclude the source file.
    """
    profile = Path(tempfile.mkdtemp(prefix="lo-profile-"))
    try:
        cmd = [
            soffice_path,
            # Isolate the user profile so a running GUI instance can't block us.
            f"-env:UserInstallation={profile.as_uri()}",
            "--headless",
            "--norestore",
            "--convert-to",
            convert_to,
            "--outdir",
            str(out_dir),
            str(src),
        ]
        # NOT subprocess.run(timeout=): on Windows soffice.exe is a launcher
        # stub that spawns the real soffice.bin as a CHILD, and run()'s timeout
        # kills only the parent handle — a hung Draw import (a pathological or
        # crafted PDF) would orphan soffice.bin holding the profile dir open, so
        # the finally's rmtree silently fails and both leak. Track the pid and
        # kill the whole TREE on timeout (taskkill /T), so the profile frees.
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            # soffice must never inherit the engine's JSON-RPC stdin (the
            # distill review's lesson — a subprocess reading the RPC pipe).
            stdin=subprocess.DEVNULL,
            text=True,
        )
        try:
            stdout, stderr = proc.communicate(timeout=_TIMEOUT)
        except subprocess.TimeoutExpired:
            _kill_tree(proc.pid)
            proc.communicate()  # reap, and release the pipes
            raise RuntimeError(f"LibreOffice conversion timed out after {_TIMEOUT}s")
        if proc.returncode != 0:
            raise RuntimeError(
                f"LibreOffice conversion failed (exit {proc.returncode}): "
                f"{(stderr or '').strip() or (stdout or '').strip()}"
            )
        # The output is <src stem><want_ext> in out_dir. Match stem AND
        # extension, excluding the source itself (the bridge's HTML intermediate
        # lives here too and shares the stem).
        stem = src.stem
        src_resolved = src.resolve()
        produced = [
            p for p in out_dir.iterdir()
            if p.is_file()
            and p.stem == stem
            and p.suffix.lower() == want_ext.lower()
            and p.resolve() != src_resolved
        ]
        if not produced:
            raise RuntimeError(
                "LibreOffice reported success but wrote no output "
                f"(stderr: {result.stderr.strip()})"
            )
        return produced[0]
    finally:
        shutil.rmtree(profile, ignore_errors=True)


def export_document(file: str, output: str, fmt: str, soffice_path: str) -> dict:
    """Export ``file`` to ``output`` in ``fmt`` via bundled LibreOffice.

    Args:
        file: input PDF path.
        output: destination path (the caller's chosen name + extension).
        fmt: one of ``supported_formats()``.
        soffice_path: path to the LibreOffice ``soffice`` executable.
    """
    key = str(fmt).lower()
    if key not in _FORMATS:
        raise ValueError(f"unsupported export format {fmt!r} (have {sorted(_FORMATS)})")
    want_ext, convert_to, bridged = _FORMATS[key]

    input_path = Path(file)
    output_path = Path(output)
    if not input_path.is_file():
        raise ValueError(f"input file not found: {file}")
    # A directory destination would make shutil.move drop the file INSIDE it
    # under the intermediate's stem (e.g. a bridge's HTML-stem name) while we
    # report `output` + a directory's stat size — a silent misplace + a
    # false-success signal (the CLI passes any PathBuf straight through). Refuse.
    if output_path.is_dir():
        raise ValueError(f"output path is a directory, not a file: {output}")
    # Never let the export overwrite its own source through a path alias — the
    # same identity guard the distill/redact family uses.
    if input_path.exists() and output_path.exists() and os.path.samefile(input_path, output_path):
        raise ValueError("output path is the same file as the input")
    if not str(soffice_path).strip():
        raise RuntimeError("LibreOffice is not available (no soffice path)")

    work = Path(tempfile.mkdtemp(prefix="lo-export-"))
    try:
        if bridged:
            # PDF -> HTML (carries the real text) -> the Writer format.
            html = _run_soffice(soffice_path, "html", input_path, work, ".html")
            produced = _run_soffice(soffice_path, convert_to, html, work, want_ext)
        else:
            produced = _run_soffice(soffice_path, convert_to, input_path, work, want_ext)

        output_path.parent.mkdir(parents=True, exist_ok=True)
        # A read-only existing target (a re-export over a prior output) must not
        # break the move — clear the attribute first (the mirror-output lesson).
        if output_path.exists():
            try:
                os.chmod(output_path, 0o666)
            except OSError:
                pass
        shutil.move(str(produced), str(output_path))
        return {"output": str(output_path), "format": key, "size": output_path.stat().st_size}
    finally:
        shutil.rmtree(work, ignore_errors=True)
