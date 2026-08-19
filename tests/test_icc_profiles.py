"""The bundled ICC colour profiles: what ships, what names it, and what
changed the day the destination stopped coming out of the producer.

The `icc_dir` guard tests for the PROFILES, not for the directory — the
release workflow creates the resource directories as stubs, so an `isdir`
check would pass over an empty tree and every measurement below would report
green while measuring nothing.
"""

import csv
import os
import subprocess
from pathlib import Path

import pikepdf
import pytest

from engine import icc_profiles
from engine.icc_profiles import DEFAULT_CMYK_DESCRIPTION as DEFAULT_PRESS
from engine.prepress import convert_cmyk, convert_pdfx

MANIFEST = Path(__file__).resolve().parent.parent / "scripts" / "icc-profiles.tsv"
LICENSE_NAME = "Adobe-Color-Profile-License.txt"


def _manifest_rows():
    with open(MANIFEST, encoding="utf-8") as f:
        rows = [
            line for line in f
            if line.strip() and not line.startswith("#")
        ]
    reader = csv.DictReader(rows, delimiter="\t")
    return list(reader)


def _rgb_pdf(path):
    """A one-page PDF with pure-RGB fills — the standard conversion fixture."""
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(200, 200))
    page.Contents = pdf.make_stream(
        b"1 0 0 rg 10 10 100 100 re f  0 0 1 rg 50 50 40 40 re f"
    )
    page.Resources = pikepdf.Dictionary()
    pdf.save(path)
    pdf.close()
    return str(path)


def _k_operands(path):
    """Every `k` (CMYK fill) operand tuple in page 1's content stream.

    The S5 instrument: the conversion's own numbers, read off the file rather
    than off a raster, so a difference between two destination profiles is
    exact rather than sampled.
    """
    found = []
    with pikepdf.open(path) as pdf:
        for operands, operator in pikepdf.parse_content_stream(pdf.pages[0]):
            if str(operator) == "k":
                found.append(tuple(round(float(v), 4) for v in operands))
    return found


class TestWhatShips:
    def test_every_manifest_row_is_installed_under_its_description_string(self, icc_dir):
        installed = icc_profiles.installed(icc_dir)
        for row in _manifest_rows():
            assert row["description"] in installed, row["description"]

    def test_nothing_is_installed_that_the_manifest_does_not_name(self, icc_dir):
        named = {row["description"] for row in _manifest_rows()}
        for description in icc_profiles.installed(icc_dir):
            assert description in named, description

    def test_the_end_user_licence_ships_beside_the_profiles(self, icc_dir):
        # The bundling grant is conditioned on the end user receiving the
        # profiles under the licence, so the text shipping is a condition of
        # shipping the profiles at all.
        text = Path(icc_dir) / LICENSE_NAME
        assert text.is_file()
        body = text.read_text(encoding="utf-8")
        assert "COLOR PROFILE LICENSE AGREEMENT" in body
        # The obtainability statement the agreement requires.
        assert "available from us and from" in body

    def test_every_shipped_profile_is_named_in_the_licence_text(self, icc_dir):
        body = (Path(icc_dir) / LICENSE_NAME).read_text(encoding="utf-8")
        for description in icc_profiles.installed(icc_dir):
            assert description in body, description

    def test_the_shipped_bytes_are_unmodified(self, icc_dir):
        # "No modification" is a condition of the licence, not an
        # implementation detail, so the pinned hash is checked on the files
        # that actually ship rather than only inside the bundling script.
        import hashlib

        installed = icc_profiles.installed(icc_dir)
        for row in _manifest_rows():
            raw = Path(installed[row["description"]].path).read_bytes()
            assert hashlib.sha256(raw).hexdigest() == row["sha256"], row["description"]

    def test_the_copyright_notice_travels_in_the_profile(self, icc_dir):
        # The notices travel because the bytes do. Read them back out of the
        # shipped file's own `cprt` tag rather than trusting the manifest's
        # copy — some carry it as UTF-16, so a byte search would pass or fail
        # for the wrong reason.
        installed = icc_profiles.installed(icc_dir)
        for row in _manifest_rows():
            notice = installed[row["description"]].copyright
            assert notice, row["description"]
            assert notice.startswith(row["copyright"][:40]), row["description"]


class TestTheNoticeGate:
    """The bundling script refuses to write the resource tree when a shipped
    profile has lost its notice. The condition is a licence term, so the
    check runs before anything is extracted rather than being left to review.
    """

    SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "bundle-icc.ps1"

    def _run(self, manifest, notices=None):
        args = [
            "powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
            "-File", str(self.SCRIPT), "-Manifest", str(manifest),
            # A destination nothing reads: the gate must fail before the
            # script would ever write there.
            "-DestDir", str(Path(manifest).parent / "out"),
        ]
        if notices is not None:
            args += ["-Notices", str(notices)]
        return subprocess.run(args, capture_output=True, text=True, timeout=300,
                              stdin=subprocess.DEVNULL)

    def _manifest_copy(self, tmp_path, transform):
        lines = MANIFEST.read_text(encoding="utf-8").splitlines()
        out = tmp_path / "icc-profiles.tsv"
        out.write_text("\n".join(transform(lines)) + "\n", encoding="utf-8")
        return out

    def test_a_profile_with_no_notice_row_is_refused(self, tmp_path):
        if not self.SCRIPT.is_file():
            pytest.skip("bundling script not available")
        # A notice inventory that names nothing: every shipped profile is then
        # a profile with no notice.
        notices = tmp_path / "THIRD-PARTY-LICENSES.md"
        notices.write_text("# nothing here\n", encoding="utf-8")
        run = self._run(MANIFEST, notices)
        assert run.returncode != 0
        assert "ICC notice gate refused" in (run.stderr + run.stdout)
        assert "no row in THIRD-PARTY-LICENSES.md" in (run.stderr + run.stdout)

    def test_a_row_with_no_copyright_is_refused(self, tmp_path):
        if not self.SCRIPT.is_file():
            pytest.skip("bundling script not available")

        def strip_copyright(lines):
            out = []
            for line in lines:
                if line.startswith("#") or line.startswith("description\t"):
                    out.append(line)
                    continue
                columns = line.split("\t")
                columns[5] = ""
                out.append("\t".join(columns))
            return out

        run = self._run(self._manifest_copy(tmp_path, strip_copyright))
        assert run.returncode != 0
        assert "no copyright notice" in (run.stderr + run.stdout)

    def test_two_rows_claiming_one_description_string_are_refused(self, tmp_path):
        if not self.SCRIPT.is_file():
            pytest.skip("bundling script not available")

        def duplicate(lines):
            body = [
                line for line in lines
                if line and not line.startswith("#")
                and not line.startswith("description\t")
            ]
            return lines + [body[0]]

        run = self._run(self._manifest_copy(tmp_path, duplicate))
        assert run.returncode != 0
        assert "two rows claim one description string" in (run.stderr + run.stdout)


class TestProfileClass:
    def test_every_cmyk_row_validates_as_an_output_condition(self, icc_dir):
        installed = icc_profiles.installed(icc_dir)
        for row in _manifest_rows():
            if row["role"] != "cmyk":
                continue
            profile = installed[row["description"]]
            assert profile.space == "CMYK", row["description"]
            assert profile.profile_class in icc_profiles.OUTPUT_CLASSES

    def test_the_rgb_rows_are_not_cmyk_destinations(self, icc_dir):
        installed = icc_profiles.installed(icc_dir)
        for row in _manifest_rows():
            if row["role"] != "rgb":
                continue
            assert installed[row["description"]].space != "CMYK", row["description"]

    def test_the_default_press_is_installed_and_is_a_cmyk_destination(self, icc_dir):
        chosen = icc_profiles.default_cmyk(icc_dir)
        assert chosen.description == DEFAULT_PRESS
        assert chosen.space == "CMYK"

    def test_an_empty_directory_refuses_by_name(self, tmp_path):
        empty = tmp_path / "none"
        empty.mkdir()
        with pytest.raises(RuntimeError, match="No colour profiles are installed"):
            icc_profiles.default_cmyk(str(empty))

    def test_a_name_that_is_neither_installed_nor_a_file_refuses(self, icc_dir):
        with pytest.raises(ValueError, match="No colour profile named"):
            icc_profiles.resolve("No Such Press v9", icc_dir)


class TestOutputConditionHonesty:
    """A PDF/X identifier says what the profile declares, and nothing more."""

    def test_a_declared_characterization_is_the_identifier_and_names_its_registry(
            self, icc_dir):
        installed = icc_profiles.installed(icc_dir)
        declared = [row for row in _manifest_rows() if row["condition"]]
        assert declared, "no profile in the set declares a characterization"
        for row in declared:
            profile = installed[row["description"]]
            identifier, condition, registry = icc_profiles.output_condition(profile)
            # The manifest records the tag's raw content; the identifier is
            # that content without the CGATS data-format keyword.
            assert row["condition"].endswith(identifier)
            assert identifier and identifier != row["description"]
            assert condition == row["description"]
            assert registry == icc_profiles.CHARACTERIZATION_REGISTRY

    def test_a_profile_that_declares_nothing_is_identified_by_its_description(
            self, icc_dir):
        installed = icc_profiles.installed(icc_dir)
        undeclared = [
            row for row in _manifest_rows()
            if not row["condition"] and row["role"] == "cmyk"
        ]
        assert undeclared
        for row in undeclared:
            identifier, condition, registry = icc_profiles.output_condition(
                installed[row["description"]])
            assert identifier == row["description"]
            assert condition == row["description"]
            # No registry is claimed for a condition the profile defines
            # nowhere — a registry name it does not carry would be invented.
            assert registry == ""

    def test_no_registry_name_is_written_for_an_undeclared_default(
            self, tmp_dir, gs_path, icc_dir):
        # The default press declares no characterization, so the output intent
        # names it by description and claims no registry.
        assert icc_profiles.default_cmyk(icc_dir).condition == ""
        out = os.path.join(tmp_dir, "x3.pdf")
        convert_pdfx(_rgb_pdf(os.path.join(tmp_dir, "rgb.pdf")), out,
                     gs_path=gs_path, icc_dir=icc_dir)
        with pikepdf.open(out) as pdf:
            intent = pdf.Root["/OutputIntents"][0]
            assert str(intent["/OutputConditionIdentifier"]) == DEFAULT_PRESS
            assert intent.get("/RegistryName") is None
            assert intent.get("/DestOutputProfile") is not None

    def test_a_registry_name_is_written_for_a_declared_characterization(
            self, tmp_dir, gs_path, icc_dir):
        chosen = "Coated FOGRA39 (ISO 12647-2:2004)"
        declared = icc_profiles.installed(icc_dir)[chosen].condition
        assert declared
        out = os.path.join(tmp_dir, "fogra.pdf")
        result = convert_pdfx(_rgb_pdf(os.path.join(tmp_dir, "rgb.pdf")), out,
                              dest_profile=chosen, gs_path=gs_path, icc_dir=icc_dir)
        assert result["output_condition_identifier"] == declared
        with pikepdf.open(out) as pdf:
            intent = pdf.Root["/OutputIntents"][0]
            assert str(intent["/OutputConditionIdentifier"]) == declared
            assert str(intent["/RegistryName"]) == icc_profiles.CHARACTERIZATION_REGISTRY
            assert str(intent["/OutputCondition"]) == chosen


class TestEachProfileConvertsDistinctly:
    """A named press has to actually change the numbers.

    A picker offering fourteen presses that all produce one answer would be
    fourteen labels on one transform. The operands are read off the converted
    file, so the comparison is exact.
    """

    def test_the_default_press_converts_rgb_to_cmyk(self, tmp_dir, gs_path, icc_dir):
        src = _rgb_pdf(os.path.join(tmp_dir, "rgb.pdf"))
        out = os.path.join(tmp_dir, "default.pdf")
        result = convert_cmyk(src, out, gs_path=gs_path, icc_dir=icc_dir)
        assert result["dest_profile"] == DEFAULT_PRESS
        operands = _k_operands(out)
        assert len(operands) == 2, operands
        assert all(len(row) == 4 for row in operands)

    def test_every_bundled_press_produces_its_own_operands(
            self, tmp_dir, gs_path, icc_dir):
        src = _rgb_pdf(os.path.join(tmp_dir, "rgb.pdf"))
        seen: dict = {}
        for profile in icc_profiles.cmyk_profiles(icc_dir):
            out = os.path.join(tmp_dir, f"{abs(hash(profile.description))}.pdf")
            result = convert_cmyk(src, out, dest_profile=profile.description,
                                  gs_path=gs_path, icc_dir=icc_dir)
            assert result["dest_profile"] == profile.description
            seen.setdefault(tuple(_k_operands(out)), []).append(profile.description)
        # Two presses may legitimately agree on a saturated primary, but the
        # set as a whole must not collapse onto one answer.
        assert len(seen) > 1, seen
        # And the default is not silently identical to every other press.
        assert len(seen) >= len(icc_profiles.cmyk_profiles(icc_dir)) // 2


#: The RGB grid the disclosure is measured over. Five steps per channel
#: reaches the primaries, the neutrals and the mid-tones in one page; two
#: patches would not distinguish a press change from a rounding artefact.
_GRID_STEPS = (0.0, 0.25, 0.5, 0.75, 1.0)


def _grid_pdf(path):
    ops = []
    x = 0
    for r in _GRID_STEPS:
        for g in _GRID_STEPS:
            for b in _GRID_STEPS:
                ops.append(f"{r} {g} {b} rg {x} 0 4 4 re f".encode())
                x += 4
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(x, 4))
    page.Contents = pdf.make_stream(b"\n".join(ops))
    page.Resources = pikepdf.Dictionary()
    pdf.save(path)
    pdf.close()
    return str(path)


class TestTheDisclosedChange:
    """THE OUTPUT CHANGE, MEASURED AND PINNED.

    Converting with no destination profile used to reach the producer's own
    compiled-in CMYK space. It now reaches a named press, so what a document
    converts to is a different question — and the answer had to be measured
    rather than assumed. Measured: the producer's compiled-in space is a SWOP
    profile, so the DEFAULT moves almost nothing (16 of 124 grid patches, by
    one 8-bit quantum), while choosing a different press is where the real
    change lives (123 of 124 patches, up to 0.168 of full scale).

    The control is built here rather than reached through the engine: the
    producer's builtin is no longer something any caller can ask for, and that
    is the point.
    """

    #: Patches whose operands differ, of the grid's 124, and the largest
    #: single-component difference. Re-measure and re-pin if the producer
    #: moves — a changed number here IS the disclosure changing.
    DEFAULT_DIFFERING = 16
    DEFAULT_MAX_DELTA = 0.004
    #: One 8-bit quantum, which the producer writes rounded to three decimal
    #: places — so a one-step difference shows up as at most 0.004 in the
    #: operand. The default's whole difference sits at that floor: it is a
    #: rounding-scale change, not a colour decision landing somewhere else.
    ONE_QUANTUM = 1.0 / 255.0
    OPERAND_ROUNDING = 0.001

    OTHER_PRESS = "Coated FOGRA39 (ISO 12647-2:2004)"
    OTHER_DIFFERING = 123
    OTHER_MAX_DELTA = 0.168

    def _builtin(self, tmp_dir, gs_path, src):
        """The fixture through the producer's compiled-in CMYK, as a control."""
        out = os.path.join(tmp_dir, "builtin.pdf")
        run = subprocess.run(
            [gs_path, "-sDEVICE=pdfwrite", "-dCompatibilityLevel=1.5",
             "-sColorConversionStrategy=CMYK", "-dProcessColorModel=/DeviceCMYK",
             "-dPreserveSeparation=true", "-dPreserveDeviceN=true",
             "-dRenderIntent=1", "-dNOPAUSE", "-dQUIET", "-dBATCH", "-dSAFER",
             f"-sOutputFile={out}", src],
            capture_output=True, text=True, timeout=300, stdin=subprocess.DEVNULL)
        assert run.returncode == 0, run.stderr or run.stdout
        return _k_operands(out)

    def _compare(self, control, measured):
        assert len(control) == len(measured)
        differing = sum(1 for a, b in zip(control, measured) if a != b)
        worst = max(
            (max(abs(a - b) for a, b in zip(c, m))
             for c, m in zip(control, measured)),
            default=0.0,
        )
        return differing, worst

    def test_the_default_moves_the_operands_by_at_most_one_quantum(
            self, tmp_dir, gs_path, icc_dir):
        src = _grid_pdf(os.path.join(tmp_dir, "grid.pdf"))
        control = self._builtin(tmp_dir, gs_path, src)
        assert len(control) == 124, len(control)

        out = os.path.join(tmp_dir, "default.pdf")
        result = convert_cmyk(src, out, gs_path=gs_path, icc_dir=icc_dir)
        assert result["dest_profile"] == DEFAULT_PRESS

        differing, worst = self._compare(control, _k_operands(out))
        assert differing == self.DEFAULT_DIFFERING, differing
        assert worst == pytest.approx(self.DEFAULT_MAX_DELTA, abs=1e-6), worst
        assert worst <= self.ONE_QUANTUM + self.OPERAND_ROUNDING

    def test_choosing_another_press_is_where_the_numbers_actually_move(
            self, tmp_dir, gs_path, icc_dir):
        src = _grid_pdf(os.path.join(tmp_dir, "grid.pdf"))
        control = self._builtin(tmp_dir, gs_path, src)

        out = os.path.join(tmp_dir, "other.pdf")
        convert_cmyk(src, out, dest_profile=self.OTHER_PRESS,
                     gs_path=gs_path, icc_dir=icc_dir)
        differing, worst = self._compare(control, _k_operands(out))
        assert differing == self.OTHER_DIFFERING, differing
        assert worst == pytest.approx(self.OTHER_MAX_DELTA, abs=1e-6), worst

    def test_the_default_is_the_named_press_and_says_so(
            self, tmp_dir, gs_path, icc_dir):
        src = _rgb_pdf(os.path.join(tmp_dir, "rgb.pdf"))
        out = os.path.join(tmp_dir, "named.pdf")
        result = convert_cmyk(src, out, gs_path=gs_path, icc_dir=icc_dir)
        # The press is REPORTED. A conversion whose destination the caller
        # cannot name is a number nobody can check.
        assert result["dest_profile"] == DEFAULT_PRESS
