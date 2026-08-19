"""The source archives that accompany the shipped HEIF decoder libraries."""

import hashlib
import os
import re


REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MANIFEST = os.path.join(REPO, "scripts", "corresponding-source.tsv")
WORKFLOW = os.path.join(REPO, ".github", "workflows", "release.yml")
NOTICE = os.path.join(REPO, "THIRD-PARTY-LICENSES.md")
HEX64 = re.compile(r"^[0-9a-f]{64}$")


def rows():
    found = []
    header = None
    with open(MANIFEST, encoding="utf-8") as fh:
        for line in fh:
            if line.startswith("#") or not line.strip():
                continue
            cells = line.rstrip("\n").split("\t")
            if header is None:
                header = cells
                continue
            found.append(dict(zip(header, cells, strict=True)))
    assert header == ["component", "version", "file", "sha256", "source"]
    return found


class TestManifest:
    def test_it_names_the_complete_heif_source_set(self):
        assert {row["component"] for row in rows()} == {
            "libheif", "libde265", "pi_heif"
        }

    def test_every_archive_is_versioned_pinned_and_fetchable_by_one_route(self):
        for row in rows():
            assert row["version"]
            assert os.path.basename(row["file"]) == row["file"]
            assert HEX64.match(row["sha256"])
            assert row["source"].startswith("https://") or row["source"].startswith(
                "vendor/wheels/"
            )

    def test_the_committed_binding_source_matches_its_pin(self):
        row = next(row for row in rows() if row["component"] == "pi_heif")
        path = os.path.join(REPO, *row["source"].split("/"))
        with open(path, "rb") as fh:
            assert hashlib.sha256(fh.read()).hexdigest() == row["sha256"]


class TestReleaseContract:
    def test_the_release_stages_uploads_and_checksums_the_archives(self):
        text = open(WORKFLOW, encoding="utf-8").read()
        assert "scripts/stage-corresponding-source.ps1" in text
        assert "gh release upload ${{ github.ref_name }} $file.FullName" in text
        assert "$sources = @(Get-ChildItem release-sources" in text
        assert "$files = @($installers) + @($sources)" in text

    def test_the_public_notice_states_the_as_built_mechanism(self):
        text = open(NOTICE, encoding="utf-8").read()
        assert "scripts/corresponding-source.tsv" in text
        assert "scripts/stage-corresponding-source.ps1" in text
        assert "release assets" in text
        assert "For every GPL-2.0 or LGPL-2.1 component" in text
        assert "for at least three years" in text
        assert "preferred form for modifying these dictionaries" in text
