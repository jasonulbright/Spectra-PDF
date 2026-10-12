"""The engine's temp caches are private to the user and never reuse an entry
they did not create."""

import os
import stat
import tempfile
from pathlib import Path

import pytest

from engine import platform_support, soft_proof
from engine.platform_support import (
    ADMINISTRATORS_SID,
    OWNER_RIGHTS_SID,
    SYSTEM_SID,
    _Security,
    _Token,
    owner_acceptable,
)

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


USER = "S-1-5-21-1-2-3-1001"
OTHER = "S-1-5-21-1-2-3-1002"
STANDARD = _Token(user=USER, owner=USER)
ELEVATED = _Token(user=USER, owner=ADMINISTRATORS_SID)


def test_an_entry_is_owned_by_the_user_in_either_token():
    assert owner_acceptable(_Security(0, USER, frozenset({USER})), STANDARD)
    assert owner_acceptable(_Security(0, USER, frozenset({USER})), ELEVATED)
    assert owner_acceptable(_Security(0, ADMINISTRATORS_SID, frozenset({OTHER})), ELEVATED)


def test_an_elevated_entry_stays_the_users_when_only_the_user_may_use_it():
    private = frozenset({USER, SYSTEM_SID, ADMINISTRATORS_SID, OWNER_RIGHTS_SID})
    assert owner_acceptable(_Security(0, ADMINISTRATORS_SID, private), STANDARD)
    assert not owner_acceptable(_Security(0, ADMINISTRATORS_SID, private | {OTHER}), STANDARD)
    assert not owner_acceptable(_Security(0, ADMINISTRATORS_SID, None), STANDARD)


@pytest.mark.skipif(os.name != "nt", reason="Windows owner records")
def test_an_inherit_only_grant_counts(tmp_path):
    import subprocess

    folder = tmp_path / "shared-children"
    folder.mkdir()
    sid = platform_support.windows_user_sid()
    subprocess.run(["icacls", str(folder), "/inheritance:r", "/grant:r", f"*{sid}:(OI)(CI)F"], check=True, capture_output=True)
    assert platform_support.dacl_grants_only(folder, sid)
    subprocess.run(["icacls", str(folder), "/grant", "*S-1-1-0:(OI)(CI)(IO)R"], check=True, capture_output=True)
    assert "S-1-1-0" in platform_support._windows_security(folder).allowed
    assert not platform_support.dacl_grants_only(folder, sid)
    owned_by_administrators = _Security(0, ADMINISTRATORS_SID, platform_support._windows_security(folder).allowed)
    assert not owner_acceptable(owned_by_administrators, _Token(user=sid, owner=sid))


def test_an_entry_another_account_owns_is_refused():
    assert not owner_acceptable(_Security(0, OTHER, frozenset({USER})), STANDARD)
    assert not owner_acceptable(_Security(0, OTHER, frozenset({USER})), ELEVATED)
    assert not owner_acceptable(_Security(0, None, frozenset({USER})), STANDARD)
    assert not owner_acceptable(_Security(0, USER, frozenset({USER})), None)


def test_a_failed_owner_query_refuses():
    for status in (1, 2, 5, 50):
        assert not owner_acceptable(_Security(status), STANDARD)


windows_only = pytest.mark.skipif(os.name != "nt", reason="Windows owner records")


@windows_only
def test_owned_entry_follows_the_volumes_acl_flag(tmp_path, monkeypatch):
    real = tmp_path / "real"
    real.write_bytes(b"x")
    monkeypatch.setattr(platform_support, "_windows_security", lambda path: _Security(0, OTHER, frozenset({OTHER})))
    monkeypatch.setattr(platform_support, "_volume_keeps_acls", lambda path: True)
    assert not platform_support.owned_entry(real, directory=False)
    monkeypatch.setattr(platform_support, "_volume_keeps_acls", lambda path: False)
    assert platform_support.owned_entry(real, directory=False)
    monkeypatch.setattr(platform_support, "_volume_keeps_acls", lambda path: None)
    assert not platform_support.owned_entry(real, directory=False)


@windows_only
def test_a_null_dacl_on_a_volume_with_acls_is_refused():
    assert not owner_acceptable(_Security(0, ADMINISTRATORS_SID, None), STANDARD)


#: Volumes without ACLs, mounted by the test machine when they exist.
NO_ACL_ROOTS = ("X:\\", "Y:\\")


@windows_only
@pytest.mark.parametrize("root", NO_ACL_ROOTS)
def test_a_volume_without_acls_owns_by_the_file_checks(root):
    import shutil
    import uuid

    if not os.path.isdir(root):
        pytest.skip(f"no volume at {root}")
    assert platform_support._volume_keeps_acls(root) is False
    folder = Path(root) / f"spectra-owned-{uuid.uuid4().hex}"
    folder.mkdir()
    try:
        entry = folder / "entry.bin"
        entry.write_bytes(b"x")
        security = platform_support._windows_security(entry)
        assert security.status == 0 and security.allowed is None
        assert platform_support.owned_entry(folder, directory=True)
        assert platform_support.owned_entry(entry, directory=False)
        assert not platform_support.owned_entry(entry, directory=True)
    finally:
        shutil.rmtree(folder, ignore_errors=True)


@windows_only
def test_a_volume_with_acls_reads_the_owner(tmp_path):
    assert platform_support._volume_keeps_acls(tmp_path) is True
    entry = tmp_path / "entry.bin"
    entry.write_bytes(b"x")
    assert platform_support._windows_security(entry).owner == platform_support.windows_user_sid()
    assert platform_support.owned_entry(entry, directory=False)


@pytest.mark.skipif(os.name != "nt", reason="Windows owner records")
def test_an_entry_handed_to_administrators_stays_the_users(tmp_path):
    import subprocess

    folder = tmp_path / "elevated"
    folder.mkdir()
    sid = platform_support.windows_user_sid()
    subprocess.run(["icacls", str(folder), "/inheritance:r", "/grant:r", f"*{sid}:(OI)(CI)F"], check=True, capture_output=True)
    handed = subprocess.run(["icacls", str(folder), "/setowner", "*S-1-5-32-544"], capture_output=True)
    if handed.returncode != 0:
        pytest.skip("this account cannot hand ownership to Administrators")
    assert platform_support._windows_security(folder).owner == ADMINISTRATORS_SID
    assert platform_support.owned_entry(folder, directory=True)


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
