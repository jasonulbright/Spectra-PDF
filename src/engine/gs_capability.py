"""Is a usable Ghostscript configured? — the one place that answers.

Ghostscript is a USER-SUPPLIED prerequisite: nothing in the distribution
provides it, so every gs-backed op has to answer "is one there, and does it
work?" before it spawns anything. Answering that by file existence is what
this module exists to stop. A path can name a file that is not a program, a
program that cannot initialise (a copied `gswin64c.exe` without its
`Resource/` tree exits non-zero on the first render while `--version` still
answers), or a build too old for the flags the engine passes. Each of those
reaches the user as a different broken thing when the answer is `os.path
.isfile`, and as one named refusal when the answer is a probe.

The answer is structured — `available`, `path`, `version`, `reason` — because
callers need the REASON, not a boolean: "no Ghostscript is configured" and
"the configured Ghostscript is too old" lead to different actions, and a
refusal that cannot tell them apart sends the user to the wrong control.

Probing costs two subprocess runs, so it is cached per path + mtime + size:
a rebuilt or replaced binary at the same path re-probes, an unchanged one
answers from the cache for the life of the process.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

#: The oldest Ghostscript this engine will drive, as (major, minor).
#:
#: The FUNCTIONAL floor is 9.50: `prepress` passes `--permit-file-read=` and
#: `--permit-file-write=` (the destination-profile embed and the ROM-profile
#: extraction cannot work without them), and those options arrived with the
#: 9.50 rework that also made `-dSAFER` the default. An older build rejects
#: them as unknown options, so PDF/X and the CMYK profile paths cannot run at
#: all there.
#:
#: The floor is set at 10.0 rather than 9.50 because 9.5x still shipped the
#: PostScript-based PDF interpreter alongside the C one, and `compare` reads
#: the interpreter's own page-tree behaviour — a short render at rc 0 is how a
#: document end is discovered — to decide what to report. Driving an
#: interpreter generation that behaviour was never measured against risks a
#: WRONG comparison rather than a refusal, and a wrong result is the outcome
#: this whole capability layer exists to avoid. 10.x is also the only
#: generation the suites exercise. This is a minimum, never a pin.
MINIMUM_VERSION = (10, 0)

#: Reasons a capability answer can carry. Named so a caller branches on the
#: reason instead of matching the message text.
NOT_CONFIGURED = "not-configured"
NOT_EXECUTABLE = "not-executable"
PROBE_FAILED = "probe-failed"
VERSION_BELOW_MINIMUM = "version-below-minimum"

#: Environment override for the explicit path, for the CLI and for tests. The
#: GUI's explicit path arrives as the `gs_path` parameter instead.
PATH_ENV_VAR = "SPECTRAPDF_GS_PATH"

#: Console executable names, most specific first.
_CANDIDATE_NAMES = ("gswin64c", "gswin32c", "gs")


@dataclass(frozen=True)
class GsCapability:
    """One validated answer about one Ghostscript path."""

    available: bool
    path: str
    version: str
    reason: str
    #: Probe output kept for the settings surface; never matched on.
    detail: str = ""

    def as_dict(self) -> dict:
        return {
            "available": self.available,
            "path": self.path,
            "version": self.version,
            "reason": self.reason,
            "detail": self.detail,
        }


class GsUnavailable(RuntimeError):
    """No usable Ghostscript for an operation that needs one.

    Its own type, not a bare RuntimeError: a door that wants to report
    "unavailable" differently from "this document defeated the conversion"
    must be able to tell them apart without matching message text, which this
    repo bans in control flow. It stays a RuntimeError subclass so the
    existing per-file and per-folder handlers keep turning it into a reported
    row rather than a crash.
    """

    def __init__(self, message: str, *, reason: str, path: str = "") -> None:
        super().__init__(message)
        self.reason = reason
        self.path = path


# --------------------------------------------------------------------------
# Probing
# --------------------------------------------------------------------------

_CACHE: dict[tuple[str, int, int], GsCapability] = {}


def clear_cache() -> None:
    """Forget every probed answer (tests, and a settings change)."""
    _CACHE.clear()


def parse_version(text: str) -> tuple[int, ...]:
    """The leading dotted integers of a `gs --version` line.

    Ghostscript prints `10.07.1`; the zero-padded minor is a spelling, not a
    value, so `10.07` compares as (10, 7) and sorts after 9.50's (9, 50).
    """
    match = re.search(r"(\d+(?:\.\d+)*)", text or "")
    if not match:
        return ()
    return tuple(int(part) for part in match.group(1).split("."))


def _run(cmd: list[str], timeout: float) -> subprocess.CompletedProcess:
    kwargs: dict = {}
    if os.name == "nt":
        # A probe must never flash a console window in the GUI process.
        kwargs["creationflags"] = 0x08000000  # CREATE_NO_WINDOW
    return subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=timeout,
        stdin=subprocess.DEVNULL,
        **kwargs,
    )


def _smoke(path: str) -> tuple[bool, str]:
    """Render one tiny page. True when a raster actually came out.

    `--version` proves a file answers; it does not prove the interpreter can
    initialise, find its `Resource/` tree, or write through `-dSAFER`. Every
    consumer in this engine needs all three, so the probe asks for all three.
    """
    with tempfile.TemporaryDirectory(prefix="spectra_gs_probe_") as work:
        png = Path(work) / "probe.png"
        try:
            result = _run(
                [
                    path, "-q", "-dNOPAUSE", "-dBATCH", "-dSAFER",
                    "-sDEVICE=png16m", "-g16x16", "-r72",
                    f"-sOutputFile={png}",
                    "-c", "0 0 moveto 16 16 lineto 0.5 setlinewidth stroke showpage",
                ],
                timeout=60.0,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            return False, str(exc)
        if result.returncode != 0:
            return False, (result.stderr or result.stdout or "").strip()
        if not png.is_file() or png.stat().st_size == 0:
            return False, "the probe render produced no output"
        return True, ""


def probe(path: str | Path) -> GsCapability:
    """Validate ONE candidate path. Cached per path + mtime + size."""
    text = str(path or "")
    if not text:
        return GsCapability(False, "", "", NOT_CONFIGURED)
    try:
        stat = os.stat(text)
    except OSError:
        return GsCapability(False, text, "", NOT_EXECUTABLE)
    if not os.path.isfile(text):
        return GsCapability(False, text, "", NOT_EXECUTABLE)

    key = (os.path.abspath(text), stat.st_mtime_ns, stat.st_size)
    cached = _CACHE.get(key)
    if cached is not None:
        return cached

    try:
        version_run = _run([text, "--version"], timeout=30.0)
    except (OSError, subprocess.SubprocessError) as exc:
        answer = GsCapability(False, text, "", PROBE_FAILED, str(exc))
        _CACHE[key] = answer
        return answer

    version = (version_run.stdout or "").strip().splitlines()
    version_text = version[0].strip() if version else ""
    if version_run.returncode != 0 or not version_text:
        answer = GsCapability(
            False, text, "", PROBE_FAILED,
            (version_run.stderr or "").strip() or "no version was reported",
        )
        _CACHE[key] = answer
        return answer

    parsed = parse_version(version_text)
    if not parsed or parsed[:2] < MINIMUM_VERSION:
        answer = GsCapability(False, text, version_text, VERSION_BELOW_MINIMUM)
        _CACHE[key] = answer
        return answer

    ok, detail = _smoke(text)
    answer = (
        GsCapability(True, text, version_text, "")
        if ok
        else GsCapability(False, text, version_text, PROBE_FAILED, detail)
    )
    _CACHE[key] = answer
    return answer


# --------------------------------------------------------------------------
# Discovery
# --------------------------------------------------------------------------


def _looks_like_a_path(text: str) -> bool:
    return bool(text) and (os.sep in text or (os.altsep or "") in text)


def discover() -> list[str]:
    """Candidate paths when nothing explicit was configured, best first.

    The environment override, then PATH. A bare command name is never spawned
    blind: `shutil.which` turns it into a real path first, and that path is
    then probed like any other. Registry-installed copies that are not on PATH
    are found on the Rust side and arrive here as an explicit path.
    """
    found: list[str] = []
    override = os.environ.get(PATH_ENV_VAR, "").strip()
    if override:
        found.append(override)
    for name in _CANDIDATE_NAMES:
        resolved = shutil.which(name)
        if resolved and resolved not in found:
            found.append(resolved)
    return found


def resolve(path: str | Path | None = None) -> GsCapability:
    """The capability answer for `path`, or for what discovery turns up.

    An EXPLICIT path that fails is the answer — discovery does not paper over
    it, because silently running a different Ghostscript than the one the user
    named is how a settings screen starts lying. Only an empty value, or a
    bare command name (the old `or "gs"` shape), falls through to discovery.
    """
    text = str(path or "").strip()
    if text:
        if _looks_like_a_path(text):
            return probe(text)
        # A bare name is still explicit. It resolves through PATH before
        # anything is spawned — and a name PATH cannot resolve is the answer,
        # not a reason to go looking for some other install.
        resolved = shutil.which(text)
        return probe(resolved) if resolved else GsCapability(
            False, text, "", NOT_EXECUTABLE
        )

    candidates = discover()
    first_failure: GsCapability | None = None
    for candidate in candidates:
        answer = probe(candidate)
        if answer.available:
            return answer
        if first_failure is None:
            first_failure = answer
    return first_failure or GsCapability(False, "", "", NOT_CONFIGURED)


def _refuse(answer: GsCapability) -> None:
    """Raise the named refusal for one unavailable answer.

    The four messages are authored HERE, as literals, and nowhere else: the
    refusal table (`scripts/engine_message_sweep.py`) enumerates raise sites,
    so a message assembled somewhere else would reach the UI unlocalized.
    `message()` reads them back rather than restating them.
    """
    if answer.reason == NOT_EXECUTABLE:
        raise GsUnavailable(
            f"Ghostscript is required for this operation and there is no program "
            f"at {answer.path}. Install Ghostscript from ghostscript.com, then "
            f"set its path in Preferences > Engine.",
            reason=answer.reason,
            path=answer.path,
        )
    if answer.reason == PROBE_FAILED:
        raise GsUnavailable(
            f"Ghostscript at {answer.path} did not pass its capability check "
            f"({answer.detail or 'the probe render produced nothing'}). Install "
            f"Ghostscript from ghostscript.com, then set its path in "
            f"Preferences > Engine.",
            reason=answer.reason,
            path=answer.path,
        )
    if answer.reason == VERSION_BELOW_MINIMUM:
        raise GsUnavailable(
            f"Ghostscript {answer.version or '(unknown version)'} at {answer.path} "
            f"is older than the {_minimum_text()} this build requires. Install a "
            f"newer Ghostscript from ghostscript.com, then set its path in "
            f"Preferences > Engine.",
            reason=answer.reason,
            path=answer.path,
        )
    raise GsUnavailable(
        "Ghostscript is required for this operation and none is configured. "
        "Install Ghostscript from ghostscript.com, then set its path in "
        "Preferences > Engine.",
        reason=NOT_CONFIGURED,
        path=answer.path,
    )


def _minimum_text() -> str:
    return ".".join(str(n) for n in MINIMUM_VERSION)


def message(answer: GsCapability) -> str:
    """The English refusal for one unavailable answer ("" when it is usable)."""
    if answer.available:
        return ""
    try:
        _refuse(answer)
    except GsUnavailable as exc:
        return str(exc)
    return ""


def require(path: str | Path | None = None) -> GsCapability:
    """`resolve`, but an unusable answer is raised as the one named refusal."""
    answer = resolve(path)
    if not answer.available:
        _refuse(answer)
    return answer


def describe(path: str | Path | None = None) -> dict:
    """The structured answer plus its English reason, for a settings surface."""
    answer = resolve(path)
    payload = answer.as_dict()
    payload["message"] = "" if answer.available else message(answer)
    payload["minimum_version"] = _minimum_text()
    return payload
