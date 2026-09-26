"""Archive containment of the PDF/A corpus fetch."""

from __future__ import annotations

import importlib.util
import io
import tarfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


def _module():
    spec = importlib.util.spec_from_file_location("fetch_pdfa_corpus", ROOT / "scripts" / "fetch-pdfa-corpus.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _tarball(members: dict[str, bytes]) -> bytes:
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode="w:gz") as tar:
        for name, data in members.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return out.getvalue()


def test_members_land_under_the_destination(tmp_path: Path) -> None:
    into = tmp_path / "bfo"
    count = _module()._extract(_tarball({"repo-sha/a/b.pdf": b"%PDF"}), into)
    assert count == 1
    assert (into / "a" / "b.pdf").read_bytes() == b"%PDF"


def test_a_member_in_a_sibling_sharing_the_name_prefix_is_refused(tmp_path: Path) -> None:
    into = tmp_path / "bfo"
    archive = _tarball({"repo-sha/../bfox/planted.pdf": b"%PDF"})
    with pytest.raises(RuntimeError, match="escapes the destination"):
        _module()._extract(archive, into)
    assert not (tmp_path / "bfox").exists()
