"""The source archives that accompany the shipped copyleft object code and data."""

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
    def test_it_names_the_complete_copyleft_source_set(self):
        assert {row["component"] for row in rows()} == {
            "libheif", "libde265", "pillow_heif",
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
        tesseract = open(
            os.path.join(REPO, "scripts", "tesseract-licenses.tsv"), encoding="utf-8"
        ).read()
        assert "mingw-w64-libiconv-1.19-1.src.tar.zst" in tesseract
        assert by["libiconv"][0]["file"] == "mingw-w64-libiconv-1.19-1.src.tar.zst"
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
                "vendor/"
            )

    def test_every_committed_source_matches_its_pin(self):
        committed = [row for row in rows() if not row["source"].startswith("https://")]
        assert {row["component"] for row in committed} == {"pillow_heif", "voikko-fi"}
        for row in committed:
            path = os.path.join(REPO, *row["source"].split("/"))
            with open(path, "rb") as fh:
                assert hashlib.sha256(fh.read()).hexdigest() == row["sha256"], row["file"]

    def test_committed_sources_are_never_line_ending_normalized(self):
        text = open(os.path.join(REPO, ".gitattributes"), encoding="utf-8").read()
        assert "vendor/sources/** -text" in text.splitlines()


class TestReleaseContract:
    def test_the_release_stages_uploads_and_checksums_the_archives(self):
        text = open(WORKFLOW, encoding="utf-8").read()
        assert "scripts/stage-corresponding-source.ps1" in text

        stage = text.index("- name: Stage corresponding source archives")
        upload = text.index("- name: Upload corresponding source archives to the draft")
        checksum = text.index("- name: Upload SHA-256 checksums to the draft")
        publish = text.index("- name: Publish the release")
        # Staged, then uploaded to the draft, then checksummed -- all before the
        # single step that makes the release public.
        assert stage < upload < checksum < publish

        step = text[upload:checksum]
        # Addressed by release id, never by tag: a draft has no tag ref, so a
        # tag-addressed upload can resolve to a different, already-public release.
        assert "RELEASE_ID: ${{ steps.draft.outputs.releaseId }}" in step
        assert "$files = @(Get-ChildItem release-sources -File -ErrorAction Stop)" in step
        assert (
            'gh api --method POST -H "Content-Type: application/octet-stream" '
            '"https://uploads.github.com/repos/$repo/releases/$env:RELEASE_ID'
            '/assets?name=$name" --input $file.FullName' in step
        )
        assert "gh release upload" not in step
        assert "github.ref_name" not in step

        sums = text[checksum:publish]
        assert "$sources = @(Get-ChildItem release-sources" in sums
        assert "$files = @($installers) + @($portable) + @($sources)" in sums
        assert "SHA256SUMS.txt" in sums

    def test_the_public_notice_states_the_as_built_mechanism(self):
        text = open(NOTICE, encoding="utf-8").read()
        assert "scripts/corresponding-source.tsv" in text
        assert "scripts/stage-corresponding-source.ps1" in text
        assert "release assets" in text
        assert "For every GPL-2.0 or LGPL-2.1 component" in text
        assert "for at least three years" in text
        assert "preferred form for modifying these dictionaries" in text
        for row in rows():
            assert f"`{row['file']}`" in text or row["component"] in (
                "libheif", "libde265", "pillow_heif"
            ), row["file"]


class TestHeifNotice:
    def test_the_notice_names_what_the_committed_wheel_carries(self):
        import zipfile

        wheel = os.path.join(
            REPO, "vendor", "wheels", "pillow_heif-1.8.0+decode.2-cp314-cp314-win_amd64.whl"
        )
        with zipfile.ZipFile(wheel) as zf:
            names = zf.namelist()
        dlls = sorted(
            n.rsplit("/", 1)[1] for n in names if n.lower().endswith(".dll")
        )
        assert len(dlls) == 2
        dist_info = next(n.split("/", 1)[0] for n in names if n.endswith(".dist-info/METADATA"))
        version = dist_info[len("pillow_heif-"):-len(".dist-info")]
        assert version == "1.8.0+decode.2"
        for n in ("COPYING.libheif", "COPYING.libde265"):
            assert f"{dist_info}/licenses/{n}" in names

        text = open(NOTICE, encoding="utf-8").read()
        for dll in dlls:
            assert dll in text
        assert f"pillow_heif-{version}.dist-info" in text
        assert "| libheif | 1.23.5 |" in text
        assert "| libde265 | 1.1.3 |" in text
