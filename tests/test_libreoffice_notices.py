"""The vendored LibreOffice tree's licensing contract.

The tree is MPL-2.0 apart from its PDF-import helper, which statically links
poppler (GPL-2.0-or-later) and reads the encoding tables under
``share/xpdfimport/poppler_data``. Both are reachable: LibreOffice imports every
PDF through that helper, and ``engine/office_export.py`` feeds a PDF straight
into it for the docx / rtf / odt / html / xhtml targets.

That reachability is what these tests guard. Removing the helper fails all five
targets outright; removing the GPL ``cidToUnicode`` tables leaves the targets
succeeding while silently dropping the text of any PDF that draws a CJK font
through a predefined CMap encoding — a silent wrong output, which is why the
manifest names the files and the bundler refuses a tree without them.
"""

import hashlib
import os
import re
import shutil
import subprocess
import sys

import pytest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MANIFEST = os.path.join(REPO, "scripts", "libreoffice-notices.tsv")
BUNDLER = os.path.join(REPO, "scripts", "bundle-libreoffice.ps1")
TREE = os.path.join(REPO, "resources", "libreoffice")

# Skip on the FILE, never the directory: the release workflow stubs `resources/`
# with empty directories, so `isdir` is true where the binary is absent.
_provisioned = os.path.isfile(os.path.join(TREE, "program", "soffice.exe"))
needs_tree = pytest.mark.skipif(
    not _provisioned, reason="vendored LibreOffice not provisioned"
)

_HEX64 = re.compile(r"^[0-9a-f]{64}$")


def rows():
    out = []
    seen_header = False
    with open(MANIFEST, encoding="utf-8") as fh:
        for line in fh:
            if line.startswith("#") or not line.strip():
                continue
            cells = line.rstrip("\n").split("\t")
            if not seen_header:
                seen_header = True
                continue
            out.append(cells)
    assert seen_header, "manifest has no header row"
    return out


def _notice_names():
    return {os.path.basename(f) for f, _c, role, *_ in rows() if role == "notice"}


class TestManifest:
    def test_every_row_is_complete(self):
        notices = _notice_names()
        for file, component, role, sha, spdx, notice, source in rows():
            assert file, component
            assert component, file
            assert role in ("binary", "data", "notice"), file
            assert source.startswith("https://"), file
            assert sha == "-" or _HEX64.match(sha), file
            if role == "notice":
                continue
            assert spdx and spdx != "-", file
            assert notice in notices, file

    def test_the_gpl_components_are_named_by_their_class(self):
        by_file = {file: (spdx, role) for file, _c, role, _s, spdx, *_ in rows()}
        assert by_file["program/xpdfimport.exe"] == ("GPL-2.0-or-later", "binary")
        for table in ("cidToUnicode", "nameToUnicode", "unicodeMap"):
            spdx, role = by_file[f"share/xpdfimport/poppler_data/{table}"]
            assert spdx == "GPL-2.0-or-later", table
            assert role == "data", table

    def test_a_notice_text_ships_for_every_licensed_component(self):
        notices = _notice_names()
        assert "LICENSE" in notices
        assert "COPYING.gpl2" in notices
        assert "COPYING.adobe" in notices

    def test_the_public_notice_file_carries_the_poppler_rows(self):
        text = open(os.path.join(REPO, "THIRD-PARTY-LICENSES.md"), encoding="utf-8").read()
        assert "xpdfimport.exe" in text
        assert "poppler_data" in text
        assert "GPL-2.0-or-later" in text


@needs_tree
class TestProvisionedTree:
    def test_every_manifest_row_is_present_at_its_pin(self):
        for file, _component, _role, sha, *_ in rows():
            path = os.path.join(TREE, file.replace("/", os.sep))
            assert os.path.exists(path), path
            if sha == "-":
                continue
            with open(path, "rb") as fh:
                assert hashlib.sha256(fh.read()).hexdigest() == sha, file

    def test_the_shipped_license_text_covers_poppler(self):
        # The GPL requires the notice to travel with the object code. The tree's
        # own LICENSE is where it travels, so its content is the assertion —
        # a present-but-silent file would satisfy a path check and nothing else.
        text = open(os.path.join(TREE, "LICENSE"), encoding="utf-8", errors="replace").read()
        assert "poppler" in text
        assert "GNU GENERAL PUBLIC LICENSE" in text
        assert "Version 2, June 1991" in text

    def test_the_gpl_encoding_tables_are_not_empty(self):
        root = os.path.join(TREE, "share", "xpdfimport", "poppler_data")
        for table in ("cidToUnicode", "nameToUnicode", "unicodeMap", "cMap"):
            path = os.path.join(root, table)
            assert os.path.isdir(path) or os.path.isfile(path), path
            if os.path.isdir(path):
                assert any(
                    files for _d, _s, files in os.walk(path)
                ), f"{table} is an empty directory"


# PowerShell 7 first: some environments put a reduced `powershell` on PATH that
# lacks Get-FileHash, which the bundler has always used.
_PWSH = shutil.which("pwsh") or shutil.which("powershell")


@pytest.mark.skipif(_PWSH is None, reason="PowerShell not available")
class TestBundlerGate:
    """The refusal control: the gate must fail a tree that lost the GPL parts.

    A gate that has only ever been run against a good tree proves nothing.
    """

    def _gate(self, tree):
        return subprocess.run(
            [
                _PWSH, "-NoProfile", "-ExecutionPolicy", "Bypass",
                "-File", BUNDLER, "-GateOnly", "-DestDir", str(tree),
            ],
            capture_output=True,
            text=True,
            stdin=subprocess.DEVNULL,
            timeout=180,
        )

    def _skeleton(self, tmp_dir):
        """Only the files the manifest names — enough to exercise the gate."""
        for file, _component, _role, sha, *_ in rows():
            src = os.path.join(TREE, file.replace("/", os.sep))
            dst = os.path.join(tmp_dir, file.replace("/", os.sep))
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            if os.path.isdir(src):
                shutil.copytree(src, dst, dirs_exist_ok=True)
            else:
                shutil.copyfile(src, dst)
        return tmp_dir

    @needs_tree
    def test_it_accepts_a_tree_that_carries_every_named_file(self, tmp_dir):
        done = self._gate(self._skeleton(tmp_dir))
        assert done.returncode == 0, done.stdout + done.stderr

    @needs_tree
    def test_it_refuses_a_tree_with_the_pdf_import_helper_removed(self, tmp_dir):
        tree = self._skeleton(tmp_dir)
        os.remove(os.path.join(tree, "program", "xpdfimport.exe"))
        done = self._gate(tree)
        assert done.returncode != 0
        assert "xpdfimport.exe" in done.stdout + done.stderr

    @needs_tree
    def test_it_refuses_a_tree_with_the_gpl_encoding_tables_removed(self, tmp_dir):
        tree = self._skeleton(tmp_dir)
        shutil.rmtree(os.path.join(tree, "share", "xpdfimport", "poppler_data", "cidToUnicode"))
        done = self._gate(tree)
        assert done.returncode != 0
        assert "cidToUnicode" in done.stdout + done.stderr

    @needs_tree
    def test_it_refuses_a_tree_whose_helper_does_not_match_the_pin(self, tmp_dir):
        tree = self._skeleton(tmp_dir)
        target = os.path.join(tree, "program", "xpdfimport.exe")
        with open(target, "ab") as fh:
            fh.write(b"\0")
        done = self._gate(tree)
        assert done.returncode != 0
        assert "sha256" in (done.stdout + done.stderr).lower()

    def test_it_refuses_a_tree_that_carries_nothing(self, tmp_dir):
        done = self._gate(os.path.join(tmp_dir, "empty"))
        assert done.returncode != 0
        assert "notice gate refused" in done.stdout + done.stderr


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
