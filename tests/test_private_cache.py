"""The engine's temp caches are private to the user and never reuse an entry
they did not create."""

import os
import stat
import tempfile

import pytest

from engine import platform_support, soft_proof

posix_only = pytest.mark.skipif(os.name != "posix", reason="POSIX ownership and modes")


@pytest.fixture
def temp_root(tmp_path, monkeypatch):
    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path))
    return tmp_path


@posix_only
def test_cache_folders_are_created_private(temp_root):
    folder = platform_support.private_cache_dir("simulation-profiles")
    assert folder == temp_root / "spectrapdf" / "simulation-profiles"
    for path in (folder.parent, folder):
        assert stat.S_IMODE(os.lstat(path).st_mode) == 0o700


@posix_only
def test_a_loose_folder_of_this_user_is_tightened(temp_root):
    root = temp_root / "spectrapdf"
    root.mkdir()
    os.chmod(root, 0o777)
    platform_support.private_cache_dir("separation-preview")
    assert stat.S_IMODE(os.lstat(root).st_mode) == 0o700


@posix_only
def test_a_link_in_place_of_the_cache_folder_is_refused(temp_root, tmp_path_factory):
    elsewhere = tmp_path_factory.mktemp("elsewhere")
    (temp_root / "spectrapdf").symlink_to(elsewhere, target_is_directory=True)
    with pytest.raises(PermissionError):
        platform_support.private_cache_dir("separation-preview")
    assert not (elsewhere / "separation-preview").exists()


@posix_only
def test_owned_entry_rejects_links_and_the_wrong_kind(tmp_path):
    real = tmp_path / "real.icc"
    real.write_bytes(b"x")
    link = tmp_path / "link.icc"
    link.symlink_to(real)
    assert platform_support.owned_entry(real, directory=False)
    assert not platform_support.owned_entry(link, directory=False)
    assert not platform_support.owned_entry(real, directory=True)
    assert platform_support.owned_entry(tmp_path, directory=True)


def test_a_profile_with_the_right_size_but_other_bytes_is_replaced(temp_root):
    raw = b"profile-bytes-" * 8
    first = soft_proof.materialize(raw)
    assert first.read_bytes() == raw
    first.write_bytes(b"X" * len(raw))
    again = soft_proof.materialize(raw)
    assert again == first
    assert again.read_bytes() == raw


@posix_only
def test_a_planted_link_at_the_profile_path_is_replaced_not_followed(temp_root, tmp_path_factory):
    raw = b"another-profile" * 4
    folder = soft_proof.profile_cache_dir()
    victim = tmp_path_factory.mktemp("victim") / "target"
    victim.write_bytes(b"untouched")
    dest = soft_proof.materialize(raw)
    dest.unlink()
    dest.symlink_to(victim)
    assert soft_proof.materialize(raw) == dest
    assert not dest.is_symlink()
    assert dest.read_bytes() == raw
    assert victim.read_bytes() == b"untouched"
    assert sorted(p.name for p in folder.iterdir()) == [dest.name]
