"""Exercise the actual Cargo build script, including its resource watches.

An unchanged build must not rewrite the inputs Tauri watches. Corrupted or
obsolete staging bytes still have to be repaired before they can ship.
"""

from __future__ import annotations

import os
from pathlib import Path
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[1]
STAGING = ROOT / "src-tauri/engine-payload"


def _build() -> str:
    run = subprocess.run(
        ["cargo", "test", "--manifest-path", "src-tauri/Cargo.toml",
         "--test", "updater_manifest", "--no-run"],
        cwd=ROOT, env={**os.environ, "CARGO_TERM_COLOR": "never"},
        capture_output=True, text=True,
    )
    assert run.returncode == 0, run.stdout + run.stderr
    return run.stdout + run.stderr


def _mtimes() -> dict[str, int]:
    return {
        p.relative_to(STAGING).as_posix(): p.stat().st_mtime_ns
        for p in STAGING.rglob("*") if p.is_file()
    }


def test_payload_build_stabilizes_and_still_repairs_drift():
    # Historical-package verifier fixtures share this target directory. With
    # uncommitted build.rs edits, their newer compiled build-script can mask
    # this checkout's older-mtime source. Start from this package's artifacts
    # only (keep dependency caches), then every mutation/unchanged check below
    # exercises the same actual build without further cleaning or touching.
    clean = subprocess.run(
        ["cargo", "clean", "--manifest-path", "src-tauri/Cargo.toml",
         "--package", "spectrapdf", "--profile", "dev"],
        cwd=ROOT, capture_output=True, text=True,
    )
    assert clean.returncode == 0, clean.stdout + clean.stderr
    _build()
    before = _mtimes()
    assert before, "the real build did not stage any engine files"
    _build()
    assert _mtimes() == before, "an unchanged build rewrote watched engine inputs"

    # Change a watched file to force Cargo through the reconciliation path.
    # Also remove another and add obsolete bytecode in a nested directory.
    # Unchanged files must keep their mtimes even during this real rebuild.
    damaged, missing = [STAGING / p for p in sorted(before)[:2]]
    damaged_bytes, missing_bytes = damaged.read_bytes(), missing.read_bytes()
    assert damaged_bytes
    # Hard links cannot cross volumes: the hosted runner's pytest temp is on
    # C: while its checkout is on D:. Keep the other link outside the pruned
    # staging tree, but alongside it on the same filesystem.
    with (
        tempfile.TemporaryDirectory(prefix="hardlink-probe.local.", dir=STAGING.parent) as external_dir,
        tempfile.TemporaryDirectory(prefix="incremental-probe.local.", dir=STAGING) as scratch,
    ):
        stale = Path(scratch) / "__pycache__" / "obsolete.pyc"
        stale.parent.mkdir()
        stale.write_bytes(b"obsolete bytecode")
        try:
            corrupt = bytes([damaged_bytes[0] ^ 1]) + damaged_bytes[1:]
            external = Path(external_dir) / "hardlink-source.local.bin"
            external.write_bytes(corrupt)
            assert external.stat().st_dev == damaged.stat().st_dev
            damaged.unlink()
            os.link(external, damaged)
            assert os.path.samefile(external, damaged), "fixture did not create a real hard link"
            missing.unlink()
            _build()
            assert damaged.read_bytes() == damaged_bytes
            assert external.read_bytes() == corrupt, "repair wrote through a hard link"
            assert missing.read_bytes() == missing_bytes
            assert not Path(scratch).exists(), "obsolete files or empty directories survived"
            changed = {damaged.relative_to(STAGING).as_posix(), missing.relative_to(STAGING).as_posix()}
            after = _mtimes()
            assert set(after) == set(before)
            assert {p: t for p, t in after.items() if p not in changed} == {
                p: t for p, t in before.items() if p not in changed
            }
        finally:
            # Restore only this test's mutations if a broken build refused.
            for path, data in ((damaged, damaged_bytes), (missing, missing_bytes)):
                if not path.exists() or path.read_bytes() != data:
                    path.unlink(missing_ok=True)
                    path.write_bytes(data)

    _build()
    # Tauri's individual file watches cannot detect additions. The staging
    # directory itself must be watched so an extra file alone triggers pruning.
    with tempfile.TemporaryDirectory(prefix="addition-probe.local.", dir=STAGING) as scratch:
        (Path(scratch) / "obsolete.pyc").write_bytes(b"unmanifested")
        _build()
        assert not Path(scratch).exists(), "an added file alone escaped reconciliation"
    _build()
    settled = _mtimes()
    _build()
    assert _mtimes() == settled, "a repaired payload did not settle to an unchanged build"
