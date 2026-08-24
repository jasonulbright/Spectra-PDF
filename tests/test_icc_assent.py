"""The colour-profile assent gate.

The bundled profiles ship under a bundling agreement whose Exhibit B end-user
licence has to be PRESENTED and accepted. The installer obtains that through
its licence page (or `/acceptEULA` when unattended) and records it beside the
executable; a portable copy has no installer, so the application presents the
same text on first run and records the answer itself.

Either way the answer reaches this engine as one environment value, and this
file is what proves the engine honours it: with acceptance the bundled set
reads exactly as before, without it every bundled profile is closed BY NAME —
not by an empty listing, not by a silent fall-through to some producer's own
idea of CMYK — while a profile the user supplies themselves still resolves,
because the bundling licence has nothing to say about their file.
"""

from __future__ import annotations

import struct
from pathlib import Path

import pytest

from engine import icc_profiles
from engine.icc_profiles import ASSENT_ENV


# ── a minimal, self-made profile: no bundled bytes are needed to test this ──


def _profile_bytes(description: str, space: str = b"CMYK", cls: bytes = b"prtr") -> bytes:
    """The smallest thing `read_profile` accepts, built here rather than read.

    The gate is about WHETHER a profile is opened, so the fixture must not
    depend on the vendored tree being provisioned.
    """
    desc = description.encode("latin-1")
    tag = b"desc" + b"\0" * 4 + struct.pack(">I", len(desc) + 1) + desc + b"\0"
    header = bytearray(128)
    header[12:16] = cls
    header[16:20] = space if isinstance(space, bytes) else space.encode()
    header[36:40] = b"acsp"
    table = struct.pack(">I", 1) + struct.pack(">4sII", b"desc", 128 + 4 + 12, len(tag))
    return bytes(header) + table + tag


@pytest.fixture
def profile_dir(tmp_path: Path) -> Path:
    directory = tmp_path / "icc"
    directory.mkdir()
    (directory / "press.icc").write_bytes(_profile_bytes("Test Press Condition"))
    # The cache is keyed by directory + listing, but a stale entry from an
    # earlier test's tmp_path would still be a false green here.
    icc_profiles._CACHE.clear()
    return directory


@pytest.fixture(autouse=True)
def clear_cache():
    yield
    icc_profiles._CACHE.clear()


# ── the three states of the variable ───────────────────────────────────────


def test_absent_variable_means_no_shipped_container_launched_us(monkeypatch, profile_dir):
    """A source-tree run, a pytest, a hand-driven engine: unchanged behaviour."""
    monkeypatch.delenv(ASSENT_ENV, raising=False)
    assert icc_profiles.assent_recorded() is True
    assert "Test Press Condition" in icc_profiles.installed(str(profile_dir))


def test_acceptance_reads_the_bundled_set(monkeypatch, profile_dir):
    monkeypatch.setenv(ASSENT_ENV, "1")
    assert icc_profiles.assent_recorded() is True
    found = icc_profiles.installed(str(profile_dir))
    assert list(found) == ["Test Press Condition"]
    assert icc_profiles.default_cmyk(str(profile_dir)).description == "Test Press Condition"


@pytest.mark.parametrize("recorded", ["0", "", "no", "false"])
def test_anything_but_one_closes_the_bundled_set_by_name(monkeypatch, profile_dir, recorded):
    monkeypatch.setenv(ASSENT_ENV, recorded)
    assert icc_profiles.assent_recorded() is False

    # Every door onto the bundled set refuses, and refuses with the SAME named
    # message — an empty listing would read as "this machine has no profiles",
    # which is a different and untrue statement.
    for call in (
        lambda: icc_profiles.installed(str(profile_dir)),
        lambda: icc_profiles.cmyk_profiles(str(profile_dir)),
        lambda: icc_profiles.default_cmyk(str(profile_dir)),
        lambda: icc_profiles.resolve("", str(profile_dir)),
        lambda: icc_profiles.resolve("Test Press Condition", str(profile_dir)),
    ):
        with pytest.raises(RuntimeError, match="has not been accepted on this computer"):
            call()


def test_a_declined_run_still_converts_against_the_users_own_profile(
    monkeypatch, profile_dir, tmp_path
):
    """The line between named-disabled and crippled.

    The bundling licence covers the profiles that ship with the application. A
    profile the user points at is theirs, so declining must not take it away —
    otherwise the refusal reaches further than the terms it enforces.
    """
    monkeypatch.setenv(ASSENT_ENV, "0")
    mine = tmp_path / "my-press.icc"
    mine.write_bytes(_profile_bytes("My Own Press"))

    resolved = icc_profiles.resolve(str(mine), str(profile_dir))
    assert resolved.description == "My Own Press"
    assert resolved.space == "CMYK"


def test_a_declined_run_refuses_an_unknown_name_as_unaccepted(monkeypatch, profile_dir):
    """The name might well be a bundled profile — we are not allowed to look.

    Reporting "no profile named X is installed" would be a claim the engine
    cannot make without reading the directory the refusal exists to keep shut.
    """
    monkeypatch.setenv(ASSENT_ENV, "0")
    with pytest.raises(RuntimeError, match="has not been accepted on this computer"):
        icc_profiles.resolve("Some Press Nobody Bundled", str(profile_dir))


def test_the_gate_runs_before_the_directory_is_listed(monkeypatch, tmp_path):
    """Refuse for the licence, not for an empty tree.

    A missing resource directory has its own named refusal
    (`refuse_no_profiles`). Without acceptance the licence refusal must win,
    because nothing may read the directory to find out which case it is.
    """
    monkeypatch.setenv(ASSENT_ENV, "0")
    with pytest.raises(RuntimeError, match="has not been accepted on this computer"):
        icc_profiles.installed(str(tmp_path / "not-there"))


def test_acceptance_arriving_mid_session_is_seen_without_a_restart(monkeypatch, profile_dir):
    """The window records the answer and drops the engine, but a cached listing
    inside one process must not outlive the change either."""
    monkeypatch.setenv(ASSENT_ENV, "0")
    with pytest.raises(RuntimeError):
        icc_profiles.installed(str(profile_dir))

    monkeypatch.setenv(ASSENT_ENV, "1")
    assert "Test Press Condition" in icc_profiles.installed(str(profile_dir))
