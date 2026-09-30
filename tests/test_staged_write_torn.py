"""A writer that dies part-way leaves its target either whole-old or whole-new.

Each writer class is driven to write part of its output and then die: an
exception, an interrupt, or a real process exit. The target must then hold
exactly its previous bytes, and no staging file may remain beside it.
"""

import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pikepdf
import pytest

from engine import credentials as credentials_mod
from engine import inplace
from engine import takeoff as takeoff_mod
from engine.pdf_save import save_pdf

SRC_DIR = str(Path(__file__).resolve().parent.parent / "src")
OLD = b"%PDF-1.7\nthe previous complete bytes\n%%EOF\n"


class Died(Exception):
    pass


def _existing(tmp_path: Path) -> Path:
    target = tmp_path / "doc.pdf"
    target.write_bytes(OLD)
    return target


def _leftovers(folder: Path, keep: set) -> list:
    return sorted(p.name for p in folder.iterdir() if p.name not in keep)


def _new_pdf() -> pikepdf.Pdf:
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(200, 200))
    return pdf


# ── primitive: bytes and text ──────────────────────────────────────────────


@pytest.mark.parametrize("death", [Died, KeyboardInterrupt])
def test_bytes_writer_death_keeps_old_bytes(tmp_path, monkeypatch, death):
    target = _existing(tmp_path)
    real_open = open

    class Half:
        def __init__(self, handle):
            self.handle = handle

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            self.handle.close()

        def write(self, data):
            self.handle.write(data[: len(data) // 2])
            self.handle.flush()
            raise death()

    def opener(path, mode="r", *a, **k):
        handle = real_open(path, mode, *a, **k)
        return Half(handle) if "w" in mode else handle

    monkeypatch.setattr("builtins.open", opener)
    with pytest.raises(death):
        inplace.write_bytes_staged(target, b"N" * 100_000)
    monkeypatch.undo()
    assert target.read_bytes() == OLD
    assert _leftovers(tmp_path, {"doc.pdf"}) == []


def test_bytes_writer_lands_complete_new_bytes(tmp_path):
    target = _existing(tmp_path)
    inplace.write_bytes_staged(target, b"N" * 100_000)
    assert target.read_bytes() == b"N" * 100_000
    assert _leftovers(tmp_path, {"doc.pdf"}) == []


def test_text_writer_keeps_newline_contract(tmp_path):
    target = tmp_path / "out.txt"
    inplace.write_text_staged(target, "a\nb", newline="")
    assert target.read_bytes() == b"a\nb"


def test_staged_bytes_reach_disk_before_the_swap(tmp_path, monkeypatch):
    target = _existing(tmp_path)
    order = []
    real_fsync, real_replace = os.fsync, os.replace
    monkeypatch.setattr(inplace.os, "fsync",
                        lambda fd: (order.append("fsync"), real_fsync(fd))[1])
    real_existing = inplace._replace_existing_windows
    monkeypatch.setattr(inplace.os, "replace",
                        lambda a, b: (order.append("replace"), real_replace(a, b))[1])
    monkeypatch.setattr(inplace, "_replace_existing_windows",
                        lambda a, b: (order.append("replace"), real_existing(a, b))[1])
    inplace.write_bytes_staged(target, b"new")
    inplace.write_bytes_staged(tmp_path / "fresh.pdf", b"new")
    assert order == ["fsync", "replace", "fsync", "replace"]
    assert target.read_bytes() == b"new"


# ── pikepdf saves through save_pdf ─────────────────────────────────────────


def test_save_pdf_death_keeps_old_bytes(tmp_path, monkeypatch):
    target = _existing(tmp_path)
    real_save = pikepdf.Pdf.save

    def torn_save(self, filename, *a, **k):
        real_save(self, filename, *a, **k)
        data = Path(filename).read_bytes()
        Path(filename).write_bytes(data[: len(data) // 2])
        raise Died()

    monkeypatch.setattr(pikepdf.Pdf, "save", torn_save)
    with _new_pdf() as pdf, pytest.raises(Died):
        save_pdf(pdf, target)
    assert target.read_bytes() == OLD
    assert _leftovers(tmp_path, {"doc.pdf"}) == []


def test_save_pdf_lands_complete_document(tmp_path):
    target = _existing(tmp_path)
    with _new_pdf() as pdf:
        save_pdf(pdf, target)
    with pikepdf.open(target) as reread:
        assert len(reread.pages) == 1
    assert _leftovers(tmp_path, {"doc.pdf"}) == []


# ── producers handed one path (Ghostscript shape) ──────────────────────────


@pytest.mark.parametrize("same_file", [True, False])
def test_producer_death_keeps_old_bytes(tmp_path, same_file):
    target = _existing(tmp_path)
    with pytest.raises(KeyboardInterrupt):
        with inplace.staged_write_if(same_file, target) as produced:
            assert Path(produced) != target
            Path(produced).write_bytes(b"%PDF-1.7\npart")
            raise KeyboardInterrupt()
    assert target.read_bytes() == OLD
    assert _leftovers(tmp_path, {"doc.pdf"}) == []


# ── streamed text writers (CSV) ────────────────────────────────────────────


def test_csv_writer_death_keeps_old_bytes(tmp_path, monkeypatch):
    source = tmp_path / "src.pdf"
    with _new_pdf() as pdf:
        pdf.save(source)
    target = tmp_path / "doc.csv"
    target.write_bytes(OLD)
    real_writer = takeoff_mod.csv.writer

    class Dying:
        def __init__(self, handle):
            self.inner = real_writer(handle)
            self.handle = handle
            self.rows = 0

        def writerow(self, row):
            self.rows += 1
            self.inner.writerow(row)
            self.handle.flush()
            if self.rows == 2:
                raise Died()

    monkeypatch.setattr(takeoff_mod.csv, "writer", Dying)
    with pytest.raises(Died):
        takeoff_mod.export_count_summary(str(source), str(target))
    assert target.read_bytes() == OLD
    assert _leftovers(tmp_path, {"src.pdf", "doc.csv"}) == []


# ── byte copies ────────────────────────────────────────────────────────────


def test_copy_death_keeps_old_bytes(tmp_path, monkeypatch):
    source = tmp_path / "src.pdf"
    source.write_bytes(b"%PDF-1.7\n" + b"x" * 50_000)
    target = _existing(tmp_path)

    def torn_copy(src, dst, *a, **k):
        Path(dst).write_bytes(Path(src).read_bytes()[:100])
        raise Died()

    monkeypatch.setattr(credentials_mod.shutil, "copyfile", torn_copy)
    with pytest.raises(Died):
        credentials_mod.copy_document(str(source), str(target))
    assert target.read_bytes() == OLD
    assert _leftovers(tmp_path, {"src.pdf", "doc.pdf"}) == []


# ── a real process death mid-write ─────────────────────────────────────────


@pytest.mark.parametrize("writer", ["bytes", "save_pdf"])
def test_process_killed_mid_write_keeps_old_bytes(tmp_path, writer):
    """The worker exits with no unwinding at all, which is what a kill or a
    power loss looks like to the file: no `finally` runs, so a staging file
    may remain, but the target never holds a prefix."""
    target = _existing(tmp_path)
    script = textwrap.dedent(f"""
        import os, sys
        sys.path.insert(0, {SRC_DIR!r})
        from pathlib import Path
        import pikepdf
        from engine import inplace
        from engine.pdf_save import save_pdf
        target = Path({str(target)!r})
        if {writer!r} == "bytes":
            real_open = open
            class Killed:
                def __init__(self, h): self.h = h
                def __enter__(self): return self
                def __exit__(self, *e): self.h.close()
                def write(self, data):
                    self.h.write(data[: len(data) // 2]); self.h.flush()
                    os._exit(9)
            import builtins
            def opener(p, mode="r", *a, **k):
                h = real_open(p, mode, *a, **k)
                return Killed(h) if "w" in mode else h
            builtins.open = opener
            inplace.write_bytes_staged(target, b"N" * 100000)
        else:
            real_save = pikepdf.Pdf.save
            def killed(self, filename, *a, **k):
                real_save(self, filename, *a, **k)
                data = Path(filename).read_bytes()
                Path(filename).write_bytes(data[: len(data) // 2])
                os._exit(9)
            pikepdf.Pdf.save = killed
            pdf = pikepdf.new(); pdf.add_blank_page(page_size=(200, 200))
            save_pdf(pdf, target)
        os._exit(0)
    """)
    proc = subprocess.run([sys.executable, "-c", script], stdin=subprocess.DEVNULL,
                          capture_output=True, timeout=120)
    assert proc.returncode == 9, proc.stderr.decode(errors="replace")
    assert target.read_bytes() == OLD


# ── an overwritten file keeps what belongs to it ───────────────────────────

windows_only = pytest.mark.skipif(os.name != "nt", reason="Windows file metadata")
FILE_ATTRIBUTE_HIDDEN = 0x2


def _set_attributes(path: Path, flags: int) -> None:
    import ctypes

    assert ctypes.windll.kernel32.SetFileAttributesW(str(path), flags)


@windows_only
def test_overwrite_keeps_dacl_entry_hidden_attribute_and_stream(tmp_path):
    target = _existing(tmp_path)
    grant = subprocess.run(["icacls", str(target), "/grant", "*S-1-5-32-545:(R)"],
                           capture_output=True, text=True)
    assert grant.returncode == 0, grant.stdout + grant.stderr
    Path(str(target) + ":note").write_bytes(b"stream kept")
    _set_attributes(target, FILE_ATTRIBUTE_HIDDEN)

    with _new_pdf() as pdf:
        save_pdf(pdf, target)

    with pikepdf.open(target) as reread:
        assert len(reread.pages) == 1
    acl = subprocess.run(["icacls", str(target)], capture_output=True, text=True).stdout
    assert r"BUILTIN\Users:(R)" in acl, acl
    assert os.stat(target).st_file_attributes & FILE_ATTRIBUTE_HIDDEN
    assert Path(str(target) + ":note").read_bytes() == b"stream kept"
    assert _leftovers(tmp_path, {"doc.pdf"}) == []


def test_read_only_target_refuses_and_keeps_flag(tmp_path):
    target = _existing(tmp_path)
    os.chmod(target, 0o444)
    try:
        with pytest.raises(PermissionError):
            inplace.write_bytes_staged(target, b"new")
        assert target.read_bytes() == OLD
        assert not os.access(target, os.W_OK)
        assert _leftovers(tmp_path, {"doc.pdf"}) == []
    finally:
        os.chmod(target, 0o666)


# ── stages a killed engine left behind ─────────────────────────────────────


def _dead_pid() -> int:
    proc = subprocess.Popen([sys.executable, "-c", "pass"], stdin=subprocess.DEVNULL)
    proc.wait()
    return proc.pid


def test_reclaim_removes_only_dead_owners_stages(tmp_path):
    dead = tmp_path / f".spectra-stage-{_dead_pid()}-abc123.pdf"
    live = tmp_path / f".spectra-stage-{os.getpid()}-abc123.pdf"
    unrelated = [tmp_path / "tmpabc123.pdf", tmp_path / ".spectra-stage-x.pdf",
                 tmp_path / "report.pdf"]
    for path in [dead, live, *unrelated]:
        path.write_bytes(b"x")
    assert inplace.reclaim_stale_stages(tmp_path) == 1
    assert not dead.exists()
    assert live.exists() and all(p.exists() for p in unrelated)


def test_a_later_write_reclaims_its_output_folder(tmp_path):
    dead = tmp_path / f".spectra-stage-{_dead_pid()}-zz9.pdf"
    dead.write_bytes(b"torn")
    inplace.write_bytes_staged(tmp_path / "out.pdf", b"new")
    assert not dead.exists()
    assert _leftovers(tmp_path, {"out.pdf"}) == []


def test_stage_name_carries_owner_pid(tmp_path):
    staged = inplace.staging_target(tmp_path / "out.pdf")
    try:
        assert staged.name.startswith(f".spectra-stage-{os.getpid()}-")
    finally:
        staged.unlink()


# ── ReplaceFile outcomes ───────────────────────────────────────────────────


def _fail_replace_file(monkeypatch, error: int) -> None:
    """ReplaceFileW fails with ``error``; every other export is the real one."""
    import ctypes

    real_dll = ctypes.WinDLL

    class ReplaceFileW:
        argtypes = restype = None

        def __new__(cls, *args):
            ctypes.set_last_error(error)
            return 0

    class Kernel:
        def __init__(self, real):
            self._real = real

        def __getattr__(self, name):
            return ReplaceFileW if name == "ReplaceFileW" else getattr(self._real, name)

    monkeypatch.setattr(ctypes, "WinDLL", lambda *a, **k: Kernel(real_dll(*a, **k)))


@windows_only
@pytest.mark.parametrize("error", [1, 50, 87, 1175])
def test_unsupported_replace_falls_back_to_rename(tmp_path, monkeypatch, error):
    target = _existing(tmp_path)
    _fail_replace_file(monkeypatch, error)
    inplace.write_bytes_staged(target, b"new")
    monkeypatch.undo()
    assert target.read_bytes() == b"new"
    assert _leftovers(tmp_path, {"doc.pdf"}) == []


@windows_only
@pytest.mark.parametrize("error", [1, 50, 87, 1175])
def test_unsupported_replace_keeps_dacl_entry_attributes_stream_and_creation_time(
    tmp_path, monkeypatch, error
):
    target = _existing(tmp_path)
    grant = subprocess.run(["icacls", str(target), "/grant", "*S-1-5-32-545:(R)"],
                           capture_output=True, text=True)
    assert grant.returncode == 0, grant.stdout + grant.stderr
    Path(str(target) + ":note").write_bytes(b"stream kept")
    _set_attributes(target, FILE_ATTRIBUTE_HIDDEN)
    created = os.stat(target).st_birthtime_ns
    _fail_replace_file(monkeypatch, error)
    inplace.write_bytes_staged(target, b"new")
    monkeypatch.undo()
    assert target.read_bytes() == b"new"
    acl = subprocess.run(["icacls", str(target)], capture_output=True, text=True).stdout
    assert r"BUILTIN\Users:(R)" in acl, acl
    assert os.stat(target).st_file_attributes & FILE_ATTRIBUTE_HIDDEN
    assert Path(str(target) + ":note").read_bytes() == b"stream kept"
    assert os.stat(target).st_birthtime_ns == created
    assert _leftovers(tmp_path, {"doc.pdf"}) == []


@windows_only
def test_unsupported_replace_that_cannot_carry_metadata_leaves_the_target(
    tmp_path, monkeypatch
):
    target = _existing(tmp_path)
    Path(str(target) + ":note").write_bytes(b"stream kept")
    _fail_replace_file(monkeypatch, 50)
    real_open = open

    def refuse_streams(path, mode="r", *a, **k):
        if str(path).startswith(str(tmp_path / ".spectra-stage-")) and ":" in Path(str(path)).name:
            raise PermissionError(13, "stream refused", str(path))
        return real_open(path, mode, *a, **k)

    monkeypatch.setattr("builtins.open", refuse_streams)
    with pytest.raises(PermissionError):
        inplace.write_bytes_staged(target, b"new")
    monkeypatch.undo()
    assert target.read_bytes() == OLD
    assert Path(str(target) + ":note").read_bytes() == b"stream kept"
    assert _leftovers(tmp_path, {"doc.pdf"}) == []


@windows_only
def test_injected_sharing_violation_is_a_translated_refusal(tmp_path, monkeypatch):
    target = _existing(tmp_path)
    _fail_replace_file(monkeypatch, 32)
    with pytest.raises(PermissionError) as refused:
        inplace.write_bytes_staged(target, b"new")
    monkeypatch.undo()
    assert str(refused.value) == inplace.FILE_IN_USE
    assert target.read_bytes() == OLD
    assert _leftovers(tmp_path, {"doc.pdf"}) == []


@windows_only
def test_saving_over_a_still_open_source_is_a_translated_refusal(tmp_path):
    target = tmp_path / "doc.pdf"
    with _new_pdf() as pdf:
        pdf.save(target)
    before = target.read_bytes()
    with pikepdf.open(target) as held:
        with pytest.raises(PermissionError) as refused:
            save_pdf(held, target)
    assert str(refused.value) == inplace.FILE_IN_USE
    assert target.read_bytes() == before
    assert _leftovers(tmp_path, {"doc.pdf"}) == []


# ── nested stages and links ────────────────────────────────────────────────


def test_save_onto_a_stage_writes_it_directly(tmp_path, monkeypatch):
    target = _existing(tmp_path)
    made = []
    real = inplace.staging_target
    monkeypatch.setattr(inplace, "staging_target",
                        lambda out: made.append(out) or real(out))
    with inplace.staged_write(target) as staged:
        with _new_pdf() as pdf:
            save_pdf(pdf, staged)
    assert len(made) == 1
    with pikepdf.open(target) as reread:
        assert len(reread.pages) == 1
    assert _leftovers(tmp_path, {"doc.pdf"}) == []


def test_symlink_target_replaces_the_linked_file_and_stays_a_link(tmp_path):
    real = _existing(tmp_path)
    link = tmp_path / "link.pdf"
    try:
        os.symlink(real, link)
    except (OSError, NotImplementedError) as exc:
        pytest.skip(f"symbolic links need a privilege this session lacks: {exc}")
    inplace.write_bytes_staged(link, b"new")
    assert os.path.islink(link)
    assert real.read_bytes() == b"new"
    assert _leftovers(tmp_path, {"doc.pdf", "link.pdf"}) == []
