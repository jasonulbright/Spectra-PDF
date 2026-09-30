"""The lineage record of the shipped copyleft object code and data."""

import hashlib
import os
import re


REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MANIFEST = os.path.join(REPO, "scripts", "corresponding-source.tsv")
WORKFLOWS = [
    os.path.join(REPO, ".github", "workflows", name)
    for name in ("release.yml", "release-redo.yml")
]
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
    def test_it_names_the_complete_copyleft_source_set(self):
        assert {row["component"] for row in rows()} == {
            "libheif", "libde265", "pi_heif",
            "libreoffice", "poppler", "poppler-data",
            "voikko-fi", "libvoikko", "libiconv", "dictionaries",
        }

    def test_each_source_matches_the_version_that_ships(self):
        by = {}
        for row in rows():
            by.setdefault(row["component"], []).append(row)
        libreoffice = open(
            os.path.join(REPO, "scripts", "bundle-libreoffice.ps1"), encoding="utf-8"
        ).read()
        version = by["libreoffice"][0]["version"]
        assert f'[string]$ArchiveVersion = "{version}"' in libreoffice
        voikko = open(os.path.join(REPO, "scripts", "voikko.tsv"), encoding="utf-8").read()
        assert "voikko-fi_2.5-2_amd64.deb" in voikko
        assert {r["file"] for r in by["voikko-fi"]} == {
            "voikko-fi_2.5-2.dsc", "voikko-fi_2.5.orig.tar.gz",
            "voikko-fi_2.5-2.debian.tar.xz",
        }
        assert "libvoikko-4.3.3-3-any.pkg.tar.zst" in voikko
        assert by["libvoikko"][0]["version"] == "4.3.3-3"
        assert by["libiconv"][0]["version"] == "1.17"
        dictionaries = open(
            os.path.join(REPO, "scripts", "bundle-dictionaries.ps1"), encoding="utf-8"
        ).read()
        commit = by["dictionaries"][0]["version"]
        assert f'$Commit = "{commit}"' in dictionaries
        assert commit in by["dictionaries"][0]["source"]

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
    def test_the_release_publishes_no_source_archives(self):
        for path in WORKFLOWS:
            text = open(path, encoding="utf-8").read()
            assert "release-sources" not in text, path
            assert "corresponding source archives" not in text, path
            assert "$files = @($installers) + @($portable)\n" in text, path

    def test_the_public_notice_states_the_as_built_mechanism(self):
        text = open(NOTICE, encoding="utf-8").read()
        assert "scripts/corresponding-source.tsv" in text
        assert "stage-corresponding-source" not in text
        assert "attached to every release" not in text
        assert "attached to the release" not in text
        assert "For every GPL-2.0 or LGPL-2.1 component" in text
        assert "for at least three years" in text
        assert "preferred form for modifying these dictionaries" in text
        for row in rows():
            assert f"`{row['file']}`" in text or row["component"] in (
                "libheif", "libde265", "pi_heif"
            ), row["file"]
