"""A trust bundle that could not be read is read again, not remembered as empty.

The bundles are parsed once and kept. Before this, a read that failed for a
reason that passes (a lock held by a scanner, a dropped share) was kept too:
the source then reported itself unavailable until the process ended. A read that
fails in a way that may pass is not kept, and a bundle some of whose files could
not be read is not used at all for that verification: the root program's
anchors are only meaningful with their cutoffs, so a half-read bundle must never
yield anchors without them.

The bundle is the suite's own files in a temp directory, so nothing here depends
on a real certificate authority.
"""

import json
import pathlib

import pytest

from engine import eutl, msctl
from engine.signatures import _TrustSources


@pytest.fixture(autouse=True)
def _clear_bundle_cache():
    msctl._CACHE.clear()
    eutl._CACHE.clear()
    yield
    msctl._CACHE.clear()
    eutl._CACHE.clear()


def _pem_of_real_bundle(module, name: str) -> bytes:
    return (pathlib.Path(module.__file__).resolve().parent / "trust" / name).read_bytes()


def _write_msctl(directory: pathlib.Path, with_constraints: bool = True) -> None:
    real = pathlib.Path(msctl.__file__).resolve().parent / "trust" / "msctl"
    directory.mkdir(parents=True, exist_ok=True)
    for name in ("msctl-signers.pem", "msctl-timestamp.pem", "msctl-manifest.json"):
        (directory / name).write_bytes((real / name).read_bytes())
    if with_constraints:
        (directory / "msctl-constraints.json").write_bytes(
            (real / "msctl-constraints.json").read_bytes()
        )


def _fail_reads_of(monkeypatch, fragment: str, error: Exception) -> list:
    """Make reading any file whose name holds `fragment` raise `error`.

    Returns the list of reads that were refused, so a test can say the failure
    really happened."""
    refused: list = []
    original = pathlib.Path.read_bytes

    def read_bytes(self):
        if fragment in self.name:
            refused.append(self.name)
            raise error
        return original(self)

    monkeypatch.setattr(pathlib.Path, "read_bytes", read_bytes)
    return refused


class TestMsctl:
    def test_a_read_that_failed_in_a_way_that_may_pass_is_not_kept(self, monkeypatch, tmp_path):
        directory = tmp_path / "msctl"
        _write_msctl(directory)
        monkeypatch.setattr(msctl, "_bundle_dir", lambda: directory)
        refused = _fail_reads_of(monkeypatch, "msctl-signers.pem", PermissionError("locked"))

        assert msctl.available() is False
        assert refused
        assert msctl._CACHE == {}

        # The lock goes away: the next verification reads the bundle again.
        monkeypatch.undo()
        monkeypatch.setattr(msctl, "_bundle_dir", lambda: directory)
        assert msctl.available() is True
        assert directory in msctl._CACHE

    def test_a_missing_file_is_a_fact_about_the_install_and_is_kept(self, monkeypatch, tmp_path):
        directory = tmp_path / "msctl"
        _write_msctl(directory, with_constraints=False)
        monkeypatch.setattr(msctl, "_bundle_dir", lambda: directory)

        assert msctl.available() is True
        assert directory in msctl._CACHE
        assert msctl.constraints() == {}

    def test_an_unparsable_constraints_file_is_kept_not_retried(self, monkeypatch, tmp_path):
        directory = tmp_path / "msctl"
        _write_msctl(directory)
        (directory / "msctl-constraints.json").write_text("{not json", encoding="utf-8")
        monkeypatch.setattr(msctl, "_bundle_dir", lambda: directory)

        msctl.available()
        assert directory in msctl._CACHE

    def test_a_bundle_with_unreadable_cutoffs_gives_no_anchors(self, monkeypatch, tmp_path):
        """The case the earlier retry got wrong: full anchors and an empty cutoff
        map in one verification would trust a root without its cutoff."""
        directory = tmp_path / "msctl"
        _write_msctl(directory)
        monkeypatch.setattr(msctl, "_bundle_dir", lambda: directory)
        refused = _fail_reads_of(monkeypatch, "msctl-constraints.json", PermissionError("locked"))

        snapshot = msctl.snapshot()
        assert refused
        assert snapshot.transient
        assert msctl.anchors(msctl.SIGNER, snapshot) == []
        assert msctl.anchors(msctl.TIMESTAMP, snapshot) == []
        assert msctl.available(snapshot) is False
        assert msctl.constraints(snapshot) == {}

    def test_one_verification_reads_every_part_from_one_snapshot(self, monkeypatch, tmp_path):
        directory = tmp_path / "msctl"
        _write_msctl(directory)
        monkeypatch.setattr(msctl, "_bundle_dir", lambda: directory)
        refused = _fail_reads_of(monkeypatch, "msctl-constraints.json", PermissionError("locked"))
        reads: list = []
        original = msctl._read_bundle

        def recording(where):
            reads.append(where)
            return original(where)

        monkeypatch.setattr(msctl, "_read_bundle", recording)

        sources = _TrustSources(None, False, msctl_trust=True)

        assert refused
        assert len(reads) == 1, "anchors, cutoffs and provenance come from one read"
        assert sources.msctl_available is False
        assert sources.msctl_prints == set()
        assert sources.msctl_constraints == {}

    def test_the_next_verification_after_a_failed_one_has_both_halves(self, monkeypatch, tmp_path):
        directory = tmp_path / "msctl"
        _write_msctl(directory)
        monkeypatch.setattr(msctl, "_bundle_dir", lambda: directory)
        _fail_reads_of(monkeypatch, "msctl-constraints.json", PermissionError("locked"))
        failed = _TrustSources(None, False, msctl_trust=True)
        assert failed.msctl_available is False

        monkeypatch.undo()
        monkeypatch.setattr(msctl, "_bundle_dir", lambda: directory)
        recovered = _TrustSources(None, False, msctl_trust=True)

        assert recovered.msctl_available is True
        assert recovered.msctl_prints
        assert recovered.msctl_constraints, "the cutoffs arrive with the anchors"

    def test_the_kept_bundle_is_still_read_once(self, monkeypatch, tmp_path):
        directory = tmp_path / "msctl"
        _write_msctl(directory)
        monkeypatch.setattr(msctl, "_bundle_dir", lambda: directory)
        reads: list = []
        original = msctl._read_bundle

        def recording(where):
            reads.append(where)
            return original(where)

        monkeypatch.setattr(msctl, "_read_bundle", recording)
        msctl.available()
        msctl.anchors(msctl.SIGNER)
        msctl.provenance()
        msctl.constraints()
        assert len(reads) == 1


class TestEutl:
    def _write(self, directory: pathlib.Path) -> None:
        real = pathlib.Path(eutl.__file__).resolve().parent / "trust"
        directory.mkdir(parents=True, exist_ok=True)
        for name in ("eutl-signers.pem", "eutl-timestamp.pem", "eutl-manifest.json"):
            (directory / name).write_bytes((real / name).read_bytes())

    def test_a_read_that_failed_in_a_way_that_may_pass_is_not_kept(self, monkeypatch, tmp_path):
        directory = tmp_path / "eutl"
        self._write(directory)
        monkeypatch.setattr(eutl, "_bundle_dir", lambda: directory)
        refused = _fail_reads_of(monkeypatch, "eutl-signers.pem", OSError(5, "I/O error"))

        assert eutl.available() is False
        assert refused
        assert eutl._CACHE == {}

        monkeypatch.undo()
        monkeypatch.setattr(eutl, "_bundle_dir", lambda: directory)
        assert eutl.available() is True
        assert directory in eutl._CACHE

    def test_a_missing_manifest_is_kept(self, monkeypatch, tmp_path):
        directory = tmp_path / "eutl"
        self._write(directory)
        (directory / "eutl-manifest.json").unlink()
        monkeypatch.setattr(eutl, "_bundle_dir", lambda: directory)

        eutl.available()
        assert directory in eutl._CACHE
        assert eutl.provenance()["fetched"] is None

    def test_a_half_read_bundle_gives_no_anchors(self, monkeypatch, tmp_path):
        directory = tmp_path / "eutl"
        self._write(directory)
        monkeypatch.setattr(eutl, "_bundle_dir", lambda: directory)
        _fail_reads_of(monkeypatch, "eutl-timestamp.pem", PermissionError("locked"))

        snapshot = eutl.snapshot()
        assert snapshot.transient
        assert eutl.anchors(eutl.SIGNER, snapshot) == []
        assert eutl.available(snapshot) is False


def test_the_real_bundles_are_complete_and_kept():
    """The shipped files read cleanly: nothing here is transient, so the real
    app keeps its one parse exactly as before."""
    assert msctl.snapshot().transient is False
    assert eutl.snapshot().transient is False
    assert msctl._CACHE and eutl._CACHE
    assert json.loads(_pem_of_real_bundle(eutl, "eutl-manifest.json").decode("utf-8"))
