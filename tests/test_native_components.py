"""The shipped native-component inventory and its advisory floors."""

import hashlib
import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
SCRIPT = REPO / "scripts" / "native-components.py"
_spec = importlib.util.spec_from_file_location("native_components", SCRIPT)
nc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(nc)

EMBEDDED_PYTHON = REPO / "resources" / "python" / "python.exe"


@pytest.mark.parametrize(
    ("a", "b", "expected"),
    [
        ("2.5.2", "2.5.2", 0),
        ("2.5.2", "2.5.2.0", 0),
        ("2.5.10", "2.5.9", 1),
        ("1.10", "1.9", 1),
        ("5.4.0.20240606", "5.4.0", 1),
        ("5.4.0.20240606", "5.4.1", -1),
        ("4.3+1-e9b8812", "4.3", 1),
        ("4.3+1-e9b8812", "4.3.1", -1),
        ("4.3+1-e9b8812", "4.3+2-aaaaaaa", -1),
        ("1.8.0+decode.1", "1.8.0", 0),
        ("1.8.0+decode.1", "1.8.1", -1),
        ("1.3.1.zlib-ng", "1.3.1", 0),
        ("1.5.3-0-gb546257", "1.5.3", 0),
        ("1.1.1w", "1.1.1", 1),
        ("1.1.1w", "1.1.1v", 1),
        ("1.1.1w", "1.1.2", -1),
        ("3.0.0rc1", "3.0.0", -1),
        ("3.0.0rc2", "3.0.0rc1", 1),
        ("3.0.0b1", "3.0.0rc1", -1),
        ("1, 8, 4, 0", "1.8.4", 0),
        ("v5.4.0", "5.4.0", 0),
        ("0.3.34.0.0", "0.3.34", 0),
    ],
)
def test_version_compare_handles_the_forms_upstreams_print(a, b, expected):
    assert nc.compare_versions(a, b) == expected
    assert nc.compare_versions(b, a) == -expected


def test_a_version_without_a_number_is_unparseable():
    assert nc.compare_versions("unknown", "1.0") is None
    assert nc.compare_versions("1.0", "") is None


@pytest.mark.parametrize(
    ("reported", "token"),
    [
        ("OpenSSL 3.5.7 1 Jul 2026", "3.5.7"),
        ("OpenSSL 1.1.1w  11 Sep 2023", "1.1.1w"),
        ("expat_2.8.2", "2.8.2"),
        ("1, 8, 4, 0", "1.8.4.0"),
        ("3.124 Basic ECC", "3.124"),
        ("1.3.1.zlib-ng", "1.3.1.zlib-ng"),
        ("WI-V3.0.7.33374", "3.0.7.33374"),
    ],
)
def test_the_version_token_is_cut_from_a_reported_string(reported, token):
    assert nc._token(reported) == token


def _row(component, version, container="x.dll", tree="python", source="pe-version", evidence="probe"):
    return (tree, container, component, version, source, evidence)


def test_a_version_below_its_floor_is_a_breach_named_by_component_and_container():
    rows = [_row("libheif", "1.19.5", "heif-abc.dll"), _row("zlib", "1.3.1")]
    problems = nc.breaches(rows, [("libheif", "1.20.0", "CVE-2026-84444", "fix by upgrade")])
    assert len(problems) == 1
    assert "below floor" in problems[0]
    assert "libheif 1.19.5" in problems[0]
    assert "python/heif-abc.dll" in problems[0]
    assert "CVE-2026-84444" in problems[0]


def test_a_version_at_or_above_the_floor_clears_it():
    rows = [_row("libheif", "1.20.0"), _row("LibHEIF", "1.23.4", "other.dll")]
    assert nc.breaches(rows, [("libheif", "1.20.0", "CVE-x", "-")]) == []


def test_every_shipped_copy_is_held_to_the_floor():
    rows = [_row("zlib", "1.3.1", "a.dll"), _row("zlib", "1.2.13", "b.dll", tree="tesseract")]
    problems = nc.breaches(rows, [("zlib", "1.3", "CVE-y", "-")])
    assert problems == [p for p in problems if "tesseract/b.dll" in p]
    assert len(problems) == 1


def test_an_unknown_version_cannot_clear_a_floor():
    problems = nc.breaches([_row("libgif", "unknown")], [("libgif", "5.2.2", "CVE-z", "-")])
    assert len(problems) == 1
    assert problems[0].startswith("unverifiable")


def test_a_dash_floor_checks_nothing():
    assert nc.breaches([_row("zlib", "1.0")], [("zlib", "-", "note", "exempt"), ("ghostscript", "-", "n", "d")]) == []


def test_a_floor_for_a_component_that_is_not_shipped_is_refused():
    problems = nc.breaches([_row("zlib", "1.3.1")], [("libzzz", "1.0", "CVE-q", "-")])
    assert len(problems) == 1
    assert "names no shipped component: libzzz (1 advisories)" in problems[0]


def test_the_diff_names_changed_added_and_removed_components():
    pinned = [_row("libheif", "1.19.5", "heif.dll"), _row("zlib", "1.3.1", "z.dll"), _row("gone", "1.0", "g.dll")]
    current = [_row("libheif", "1.23.4", "heif.dll"), _row("zlib", "1.3.1", "z.dll"), _row("new", "2.0", "n.dll")]
    lines = nc.diff(pinned, current)
    assert sorted(lines) == sorted([
        "changed: libheif in python/heif.dll: pinned 1.19.5, shipped 1.23.4 (pe-version)",
        "no longer shipped: gone 1.0 in python/g.dll (pe-version)",
        "not pinned: new 2.0 in python/n.dll (pe-version)",
    ])
    assert nc.diff(pinned, list(reversed(pinned))) == []


def test_render_is_sorted_deterministic_and_parses_back():
    rows = [_row("zlib", "1.3.1", "b.dll"), _row("expat", "2.8.2", "a.dll", tree="tesseract"), _row("aom", "3.1", "a.dll")]
    text = nc.render(rows)
    assert text == nc.render(list(reversed(rows)))
    assert text.splitlines()[0] == "\t".join(nc.HEADER)
    parsed = nc.parse_tsv(text, nc.HEADER, "pin")
    assert [r[1] for r in parsed] == ["a.dll", "b.dll", "a.dll"]
    assert [r[0] for r in parsed] == ["python", "python", "tesseract"]


def test_check_refuses_a_missing_advisories_file_and_a_missing_pin():
    current = [_row("zlib", "1.3.1")]
    problems = nc.check(current, nc.render(current), None)
    assert len(problems) == 1 and "native-advisories.tsv is missing" in problems[0]
    problems = nc.check(current, None, "component\tfloor\tadvisory\tdisposition\n")
    assert len(problems) == 1 and "native-components.tsv is missing" in problems[0]
    assert nc.check(current, nc.render(current), "component\tfloor\tadvisory\tdisposition\n") == []


def test_check_refuses_a_malformed_advisories_header():
    with pytest.raises(ValueError):
        nc.check([], nc.render([]), "component\tminimum\n")
    with pytest.raises(ValueError):
        nc.check([], nc.render([]), "component\tfloor\tadvisory\tdisposition\nzlib\t1.3\n")


def test_signatures_bare_literals_and_gcc_idents():
    data = (b"\0 deflate 1.3.1 Copyright 1995-2024 \0libpng version 1.6.43\0expat_2.6.2\0"
            b"\x001.0.8, 13-Jul-2019\0../cairo-1.18.0/src/cairo.c\0"
            + "libffi-3.4.4)".encode("utf-16-le"))
    hits = nc.signature_hits(data)
    assert set(hits) == {("zlib", "1.3.1"), ("libpng", "1.6.43"), ("expat", "2.6.2"),
                         ("bzip2", "1.0.8"), ("cairo", "1.18.0"), ("libffi", "3.4.4")}
    assert nc.bare_version(b"\x851.5.6\0\x001.0\0", set()) == "1.5.6"
    assert nc.bare_version(b"\x001.5.6\0\x002.0.1\0", set()) is None
    assert nc.bare_version(b"\x001.5.6\0\x002.0.1\0", {"2.0.1"}) == "1.5.6"
    assert nc.bare_version(b"\x0075.1\0", set()) is None
    assert nc.bare_version(b"\x0075.1\0", set(), "bare2") == "75.1"
    ident = b"GCC: (Rev3, Built by MSYS2 project) 14.1.0\0" * 3 + b"GCC: (Rev6, Built by MSYS2 project) 13.2.0\0"
    assert nc.gcc_ident(ident) == "14.1.0"


def test_version_report_rows_read_leptonica_style_output():
    report = (
        "tesseract v5.4.0.20240606\n leptonica-1.84.1\n  libgif 5.2.1 : libjpeg 8d (libjpeg-turbo 3.0.1) : "
        "libpng 1.6.43 : libtiff 4.6.0 : zlib 1.3 : libwebp 1.4.0 : libopenjp2 2.5.2\n"
        " Found libarchive 3.7.4 zlib/1.3.1 liblzma/5.6.1 bz2lib/1.0.8 liblz4/1.9.4 libzstd/1.5.6\n"
    )
    got = {(c, v) for c, v, _t in nc.version_report_rows(report)}
    assert got == {
        ("tesseract", "5.4.0.20240606"), ("leptonica", "1.84.1"), ("giflib", "5.2.1"),
        ("libjpeg-turbo", "3.0.1"), ("libpng", "1.6.43"), ("libtiff", "4.6.0"), ("zlib", "1.3"),
        ("libwebp", "1.4.0"), ("openjpeg", "2.5.2"), ("libarchive", "3.7.4"), ("zlib", "1.3.1"),
        ("xz", "5.6.1"), ("bzip2", "1.0.8"), ("lz4", "1.9.4"), ("zstd", "1.5.6"),
    }


def _fixture_tesseract(tmp_path):
    root = tmp_path / "resources" / "tesseract"
    root.mkdir(parents=True)
    (root / "libtiff-6.dll").write_bytes(b"\0LIBTIFF, Version 4.6.0\0 deflate 1.3.1 Copyright\0")
    (root / "libgif-7.dll").write_bytes(b"\0nothing here\0")
    (root / "libzstd.dll").write_bytes(b"\x851.5.6\0")
    manifest = tmp_path / "tesseract-licenses.tsv"
    manifest.write_text(
        "# notices\nfile\tcomponent\tspdx\tnotice\tsource\tsrcpkg\n"
        "libtiff-6.dll\tlibtiff (rebuilt without JBIG)\tlibtiff\tL\ts\tp\n"
        "libgif-7.dll\tgiflib\tMIT\tL\ts\tp\n"
        "libzstd.dll\tZstandard\tBSD-3-Clause\tL\ts\tp\n",
        encoding="utf-8",
    )
    return root, manifest


def test_a_fixture_tree_inventories_own_embedded_and_unknown_rows(tmp_path):
    root, manifest = _fixture_tesseract(tmp_path)
    inv = nc.Inventory(tmp_path / "resources")
    nc.inventory_tesseract(inv, runtime=False, manifest=manifest)
    rows = {(r[1], r[2]): r for r in inv.rows}
    assert rows[("libtiff-6.dll", "libtiff")][3:5] == ("4.6.0", "strings")
    assert rows[("libtiff-6.dll", "zlib")][3] == "1.3.1"
    assert rows[("libgif-7.dll", "giflib")][3] == "unknown"
    assert "no version resource" in rows[("libgif-7.dll", "giflib")][5]
    assert rows[("libzstd.dll", "zstd")][3] == "1.5.6"
    assert "sole standalone version literal" in rows[("libzstd.dll", "zstd")][5]


def test_a_dll_without_a_notice_row_is_refused(tmp_path):
    root, manifest = _fixture_tesseract(tmp_path)
    (root / "libnew.dll").write_bytes(b"\0")
    with pytest.raises(RuntimeError, match="libnew.dll"):
        nc.inventory_tesseract(nc.Inventory(tmp_path / "resources"), runtime=False, manifest=manifest)


def test_depmf_rows_carry_canonical_names(tmp_path):
    root = tmp_path / "resources" / "jbig2enc"
    root.mkdir(parents=True)
    (root / "depmf.json").write_text(json.dumps({"projects": {
        "jbig2enc": {"version": "0.32"}, "tiff": {"version": "4.7.1"}, "openjp2": {"version": "2.5.4"}}}))
    (root / "jbig2.exe").write_bytes(b"\0libpng version 1.6.58\0")
    inv = nc.Inventory(tmp_path / "resources")
    nc.inventory_jbig2enc(inv, runtime=False)
    got = {(r[1], r[2], r[3], r[4]) for r in inv.rows}
    assert got == {
        ("depmf.json", "jbig2enc", "0.32", "manifest:depmf.json"),
        ("depmf.json", "libtiff", "4.7.1", "manifest:depmf.json"),
        ("depmf.json", "openjpeg", "2.5.4", "manifest:depmf.json"),
        ("jbig2.exe", "libpng", "1.6.58", "strings"),
    }


def test_an_unprovisioned_tree_is_refused(tmp_path):
    (tmp_path / "python").mkdir()
    with pytest.raises(RuntimeError, match="not provisioned"):
        nc.generate(tmp_path, runtime=False)


@pytest.mark.skipif(not EMBEDDED_PYTHON.is_file(), reason="the embedded runtime is not provisioned")
def test_the_shipped_trees_match_the_pin_and_clear_every_floor():
    done = subprocess.run([sys.executable, str(SCRIPT), "--check"], cwd=REPO, capture_output=True, text=True,
                          timeout=900)
    assert done.returncode == 0, done.stdout + done.stderr


def test_the_advisories_file_tolerates_comments_and_crlf():
    text = "# floors\r\n# more\r\ncomponent\tfloor\tadvisory\tdisposition\r\nzlib\t1.3\tCVE-a\tnote\r\n"
    assert nc.parse_tsv(text, nc.ADVISORY_HEADER, "adv") == [("zlib", "1.3", "CVE-a", "note")]


def test_a_multi_branch_floor_holds_each_branch_to_its_own_floor():
    rows = [_row("cpython", "3.14.7", "a.dll"), _row("cpython", "3.12.13", "b.dll"),
            _row("cpython", "3.13.9", "c.dll"), _row("cpython", "3.11.2", "d.dll")]
    problems = nc.breaches(rows, [("CPython", "3.12.15,3.14.8", "CVE-b", "-")])
    containers = sorted(p.split(" in ")[1].split(" ")[0] for p in problems)
    # 3.13.9 is on no listed branch and clears the lowest floor 3.12.15; 3.11.2 does not.
    assert containers == ["python/a.dll", "python/b.dll", "python/d.dll"]
    assert nc.floor_for("3.13.9", ["3.14.8", "3.12.15"]) == "3.12.15"
    assert nc.floor_for("3.14.1", ["3.12.15", "3.14.8"]) == "3.14.8"


def test_aliases_and_case_match_advisory_names():
    rows = [_row("xz", "5.6.1"), _row("postgresql-libpq", "15.18"), _row("openssl", "3.5.7")]
    problems = nc.breaches(rows, [("XZ Utils", "5.8.0", "c1", "-"), ("PostgreSQL", "15.19", "c2", "-"),
                                  ("OpenSSL", "3.5.7", "c3", "-")])
    assert len(problems) == 2 and all(p.startswith("below floor") for p in problems)


def test_an_exempt_row_is_reported_but_not_enforced(capsys, monkeypatch, tmp_path):
    problems = nc.breaches([_row("libheif", "1.19.5")], [("libheif", "1.20.0", "CVE-c", "EXEMPT: owner ruling")])
    assert len(problems) == 1 and problems[0].startswith("EXEMPT: ")


def test_pinned_evidence_applies_only_to_the_exact_bytes(tmp_path):
    import hashlib
    root, manifest = _fixture_tesseract(tmp_path)
    sha = hashlib.sha256((root / "libgif-7.dll").read_bytes()).hexdigest()
    evidence = {("tesseract", "libgif-7.dll"): (sha, "giflib", "6.1.3", "package giflib-6.1.3-1")}
    inv = nc.Inventory(tmp_path / "resources", evidence)
    nc.inventory_tesseract(inv, runtime=False, manifest=manifest)
    gif = [r for r in inv.rows if r[1] == "libgif-7.dll"]
    assert [(r[3], r[4]) for r in gif] == [("6.1.3", "manifest:scripts/native-components-evidence.tsv")]

    (root / "libgif-7.dll").write_bytes(b"\0changed\0")
    inv = nc.Inventory(tmp_path / "resources", evidence)
    nc.inventory_tesseract(inv, runtime=False, manifest=manifest)
    gif = [r for r in inv.rows if r[1] == "libgif-7.dll"]
    assert gif[0][3] == "unknown" and "evidence row is for sha256" in gif[0][5]


def test_the_firebird_build_string_must_agree_with_its_major_minor():
    assert nc.signature_hits(b"\0NP-V3.0.7.33374 Firebird 3.0\0") == {
        ("firebird", "3.0.7.33374"): 'strings: "-V<v> Firebird <major.minor>"'}
    assert nc.signature_hits(b"\0NP-V6.3.7.33374 Firebird 3.0\0") == {}


def test_one_library_reported_by_several_files_is_one_finding():
    rows = [_row("cpython", "3.14.7", "python.exe"), _row("cpython", "3.14.7", "python314.dll"),
            _row("sqlite", "3.50.4", "sqlite3.dll", source="runtime"), _row("sqlite", "3.50.4.0", "sqlite3.dll")]
    problems = nc.breaches(rows, [("CPython", "3.14.8", "CVE-a", "-"), ("SQLite", "3.53.2", "CVE-b", "-")])
    assert len(problems) == 2
    assert "python/python.exe, python314.dll" in problems[0]
    assert problems[1].count("sqlite3.dll") == 1


def test_a_compile_time_report_resolves_to_the_library_that_carries_the_code():
    rows = [_row("xz", "5.6.2", "liblzma-5.dll", tree="tesseract"),
            _row("xz", "5.6.1", "tesseract.exe", tree="tesseract", source="runtime",
                 evidence='tesseract.exe --version: "liblzma/5.6.1"; code in liblzma-5.dll')]
    assert nc.breaches(rows, [("XZ Utils", "5.6.2", "CVE-2024-3094", "-")]) == []
    problems = nc.breaches(rows, [("XZ Utils", "5.8.3", "CVE-c", "-")])
    assert problems == ["below floor: XZ Utils 5.6.2 in tesseract/liblzma-5.dll, tesseract.exe < 5.8.3 (CVE-c)"]


def test_a_compile_time_report_keeps_its_own_version_when_the_library_is_unknown():
    rows = [_row("giflib", "unknown", "libgif-7.dll", tree="tesseract"),
            _row("giflib", "5.2.1", "tesseract.exe", tree="tesseract", evidence="x; code in libgif-7.dll")]
    problems = nc.breaches(rows, [("giflib", "5.2.2", "CVE-d", "-")])
    assert any("giflib 5.2.1 in tesseract/tesseract.exe" in p for p in problems)
    assert any(p.startswith("unverifiable") for p in problems)


def test_an_extension_module_takes_its_library_version_from_the_evidence_file(tmp_path):
    root = tmp_path / "resources" / "python"
    root.mkdir(parents=True)
    pyd = root / "_lzma.pyd"
    pyd.write_bytes(b"MZ not a real image")
    sha = hashlib.sha256(pyd.read_bytes()).hexdigest()
    inv = nc.Inventory(tmp_path / "resources", {("python", "_lzma.pyd"): (sha, "xz", "5.2.5", "embed zip")})
    inv.primary("python", root, pyd, "xz", stamped_by="Python")
    assert [(r[2], r[3]) for r in inv.rows] == [("xz", "5.2.5")]


def test_a_removed_component_that_returns_fails_the_gate():
    advisories = [("GLib", "absent:2.82.1", "CVE-2024-52533", "removed")]
    assert nc.breaches([_row("zlib", "1.3.2")], advisories) == []
    problems = nc.breaches([_row("glib", "2.99.0", "libglib-2.0-0.dll", tree="tesseract")], advisories)
    assert problems == ["removed component shipped: GLib in tesseract/libglib-2.0-0.dll; "
                        "restore floor 2.82.1 (CVE-2024-52533)"]
