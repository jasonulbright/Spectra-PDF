"""The two Ghostscript test axes, and the one place each is named.

Ghostscript is a user-supplied prerequisite: the distribution ships none, so
every suite runs on one of two axes and has to say which.

* The CAPABILITY-PRESENT axis needs a usable Ghostscript on the machine. It
  is the axis every existing gs test is on, and it SKIPS where none is
  configured. Which Ghostscript that is, and where it lives, is the
  authority's question (`engine.gs_capability.resolve`) and no longer a
  path this file knows: keying the skip on `resources/ghostscript/…` made
  the suites answer "is the tree vendored?", which stops being the same
  question the moment the tree is not shipped, and would have silently
  skipped the whole axis rather than running against an installed copy.
* The CAPABILITY-ABSENT axis runs EVERYWHERE, including on a machine with a
  perfectly good Ghostscript, because it forces the authority's answer off
  rather than arranging for one to be missing. PATH games cannot do that
  (an explicit path, a registry install and the environment override all
  bypass PATH), so the force is applied to discovery and to the probe —
  the two functions every answer is composed from.

The three skip shapes this replaces (a `gs_path` fixture, four per-file
`needs_gs` markers with four different reason strings, and a `needs_gs`
dataclass field) all asked about the vendored tree in slightly different
words. One reason string is the point: a run's skip list is read as
evidence, and four spellings of one condition read as four conditions.
"""

from __future__ import annotations

import pathlib
import re
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))

from engine import gs_capability as gc  # noqa: E402

ENGINE_DIR = pathlib.Path(__file__).resolve().parents[1] / "src" / "engine"

#: The ONE reason a present-axis test is skipped. Named as an AXIS, not as a
#: missing file: what is absent is the prerequisite, not a vendored tree.
PRESENT_AXIS_SKIP = (
    "capability-present axis: no usable Ghostscript is configured on this machine"
)


def _resolved() -> gc.GsCapability:
    """The authority's answer for this machine, once per session."""
    return gc.resolve()


_ANSWER = _resolved()

#: The Ghostscript the present axis drives, or "" when there is none. Tests
#: that pass an explicit `gs_path` pass THIS, so they drive the same binary
#: the authority validated rather than a second candidate of their own.
GS_PATH: str = _ANSWER.path if _ANSWER.available else ""

#: True when this machine is on the capability-present axis.
GS_AVAILABLE: bool = _ANSWER.available

requires_gs = pytest.mark.skipif(not GS_AVAILABLE, reason=PRESENT_AXIS_SKIP)


# ── The absent axis ───────────────────────────────────────────────────────


def force_absent(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make the authority answer "no usable Ghostscript" for every question.

    Applied to `discover` and `probe` rather than to `resolve`, because
    `resolve` is the function under test at most doors: patching it would
    prove the doors call something that was replaced, not that they refuse
    when a real machine has nothing usable. Discovery returns no candidate,
    `shutil.which` resolves no bare name, and every probed path answers
    unavailable — so an explicit path, a bare name and an empty value each
    reach their own reason with nothing spawned.
    """
    monkeypatch.delenv(gc.PATH_ENV_VAR, raising=False)
    gc.clear_cache()

    def _probe(path) -> gc.GsCapability:
        text = str(path or "")
        reason = gc.NOT_CONFIGURED if not text else gc.NOT_EXECUTABLE
        return gc.GsCapability(False, text, "", reason)

    def _never_runs(*_args, **_kwargs):
        raise AssertionError("the absent axis must not spawn a Ghostscript probe")

    monkeypatch.setattr(gc, "discover", lambda: [])
    monkeypatch.setattr(gc, "probe", _probe)
    monkeypatch.setattr(gc, "_run", _never_runs)
    monkeypatch.setattr(gc.shutil, "which", lambda *_a, **_k: None)


# ── A forced present answer (for tests that stub the spawn itself) ────────


def force_available(monkeypatch: pytest.MonkeyPatch, path: str) -> None:
    """Make the authority answer "usable" for `path`, spawning nothing.

    The mirror of `force_absent`, and for the same reason: a test that stubs
    `subprocess.run` below a door still has the door's own capability check
    above it, and that check probes for real. Forcing the answer at `probe`
    and at `shutil.which` — never at `resolve` or `require` — keeps the door
    exercising the authority it actually calls, and keeps `path` intact as
    the resolved executable so an exact-argv assertion still measures the
    argv the door built. Any other candidate answers unavailable, so a real
    Ghostscript on the machine cannot substitute itself.
    """
    gc.clear_cache()
    version = ".".join(str(part) for part in gc.MINIMUM_VERSION)

    def _probe(candidate) -> gc.GsCapability:
        text = str(candidate or "")
        if text == path:
            return gc.GsCapability(True, text, version, "")
        return gc.GsCapability(False, text, "", gc.NOT_EXECUTABLE)

    def _never_runs(*_args, **_kwargs):
        raise AssertionError("a forced capability answer must not spawn a probe")

    monkeypatch.setattr(gc, "discover", lambda: [path])
    monkeypatch.setattr(gc, "probe", _probe)
    monkeypatch.setattr(gc, "_run", _never_runs)
    monkeypatch.setattr(
        gc.shutil, "which", lambda name, *_a, **_k: path if name == path else None
    )


# ── The mechanical door sweep (shared with the guards) ────────────────────
#
# One predicate, two consumers: the guards in `test_gs_capability.py` (which
# ask whether a door reached Ghostscript without the authority) and the
# absent-axis roster (which asks whether every door has an absent-state
# answer). Deriving both from the same sweep is what makes a NEW gs consumer
# impossible to ship without one: adding a module that builds a Ghostscript
# command adds a roster row that does not exist, and the roster test fails.

#: A module that BUILDS a Ghostscript command names the executable as the
#: command list's first element. A module that merely passes `gs_path` down
#: to another module is not a door.
_BUILDS_A_COMMAND = re.compile(r"\[\s*(?:str\()?\s*gs_path\b")

#: The authority itself and the chokepoint that wraps it. Neither is a door.
AUTHORITY_MODULES = {"budget.py", "gs_capability.py"}


def engine_modules() -> list[pathlib.Path]:
    return sorted(ENGINE_DIR.glob("*.py"))


def builds_a_gs_command(text: str) -> bool:
    return bool(_BUILDS_A_COMMAND.search(text))


def names_the_authority(text: str) -> bool:
    """Reaches Ghostscript through the chokepoint, or consults the authority."""
    return "budget.gs(" in text or "gs_capability" in text


def gs_door_modules() -> list[str]:
    """Every engine module that drives Ghostscript, by module name.

    A door either builds the command itself or requires the capability
    before it runs. The authority and its chokepoint are excluded: they are
    what a door goes THROUGH, and a roster row for them would test the
    plumbing twice while proving nothing about any surface.
    """
    doors: list[str] = []
    for path in engine_modules():
        if path.name in AUTHORITY_MODULES:
            continue
        text = path.read_text(encoding="utf-8")
        if (
            builds_a_gs_command(text)
            or "gs_capability.require" in text
            or "budget.gs(" in text
        ):
            doors.append(path.stem)
    return doors


def modules_missing_the_authority() -> list[str]:
    """Doors that build a Ghostscript command without naming the authority."""
    offenders: list[str] = []
    for path in engine_modules():
        if path.name in AUTHORITY_MODULES:
            continue
        text = path.read_text(encoding="utf-8")
        if builds_a_gs_command(text) and not names_the_authority(text):
            offenders.append(path.name)
    return offenders


def modules_matching(pattern: str, *, skip: set[str] | None = None) -> list[str]:
    """Every engine module whose source matches `pattern` (the guards' shape)."""
    compiled = re.compile(pattern)
    hits: list[str] = []
    for path in engine_modules():
        if skip and path.name in skip:
            continue
        if compiled.search(path.read_text(encoding="utf-8")):
            hits.append(path.name)
    return hits


__all__: tuple[str, ...] = (
    "GS_AVAILABLE",
    "GS_PATH",
    "PRESENT_AXIS_SKIP",
    "builds_a_gs_command",
    "engine_modules",
    "force_absent",
    "force_available",
    "gs_door_modules",
    "modules_matching",
    "modules_missing_the_authority",
    "names_the_authority",
    "requires_gs",
)
