"""PDF/A conversion via Ghostscript."""

import tempfile
from pathlib import Path

from . import budget, gs_capability, standards_report
from .inplace import is_same_file, staged_write_if
from .validate import validate_pdf


def convert_pdfa(
    file: str,
    output: str,
    level: str = "2b",
    gs_path: str = "",
) -> dict:
    """Convert a PDF to PDF/A format using Ghostscript.

    **The conversion reaches conformance partly by deleting content, so the
    result reports what it cost.** ``altered`` carries one row per loss —
    annotations, form fields, attachments, document scripts, optional content,
    tags, a page whose text became a picture, a substituted font — and is
    empty only when every check ran and found nothing; a check that could not
    run leaves a row marked ``undetermined``. ``producer_notices`` carries
    Ghostscript text that matched no known shape, verbatim.

    ``declared_conformance`` is what the OUTPUT FILE asserts about itself,
    read back out of its own metadata. It is not a validation: Ghostscript is
    a producer, and no validator runs here. A conversion whose output does not
    declare the requested level refuses and removes what it wrote, because the
    one thing this op must never do is leave a file whose formal, machine-
    readable claim outlives every chance to correct it.

    Encryption does NOT survive this conversion, and must not: ISO 19005
    forbids a PDF/A file from being encrypted, so an encrypted source cannot
    have a conformant encrypted output. The drop is reported like every other
    one, as an ``encryption_removed`` row.

    Interactive form fields do NOT survive this conversion (gs pdfwrite drops
    them) — and unlike compress/grayscale, they are deliberately NOT
    reattached here: our field appearance streams reference unembedded
    fonts, which PDF/A forbids, so reattaching would silently break the very
    conformance this op exists to produce. Archival conversion of a form is
    flatten-then-convert, and the drop is now reported rather than only
    documented.

    Args:
        file: Input PDF path.
        output: Output PDF path.
        level: PDF/A conformance level ('1b', '2b', '3b').
        gs_path: Path to the Ghostscript executable.
    """
    # Pre-flight: validate PDF structure before passing to Ghostscript
    info = validate_pdf(file)

    pdfa_level = {"1b": "1", "2b": "2", "3b": "3"}.get(level, "2")

    input_path = Path(file)
    output_path = Path(output)
    # In-place: gs must never write the file it is reading (engine/inplace.py).
    same_file = is_same_file(file, output)
    original_size = input_path.stat().st_size

    # The census of the source runs BEFORE the conversion: on the in-place
    # path the source and the destination are one path, and after the rename
    # there is nothing left to compare against.
    source_facts = standards_report.census(input_path)

    capability = gs_capability.require(gs_path)
    with staged_write_if(same_file, output_path) as gs_target,             tempfile.TemporaryDirectory(prefix="spectra-pdfa-") as scratch:
        profile = _rgb_profile(Path(capability.path))
        definition = Path(scratch) / "pdfa_def.ps"
        definition.write_text(_output_intent_ps(profile), encoding="ascii")
        cmd = [
            capability.path,
            "-dPDFA=" + pdfa_level,
            "-dBATCH",
            "-dNOPAUSE",
            "-dSAFER",
            "-sDEVICE=pdfwrite",
            # Policy 1 keeps the conformance claim true by removing what cannot be
            # made conformant. Policy 0 keeps the content and silently abandons the
            # claim; policy 2 names itself an abort but still writes a complete
            # file and still exits 0, so it refuses nothing.
            "-dPDFACompatibilityPolicy=1",
            # Every colour lands in DeviceRGB under one sRGB OutputIntent:
            # without the intent a page that paints in a device space is not
            # PDF/A, whatever the XMP identification says.
            "-sColorConversionStrategy=RGB",
            "-sProcessColorModel=DeviceRGB",
            f"--permit-file-read={_ps_path(profile)}",
            f"-sOutputFile={str(gs_target).replace('%', '%%')}",  # % is a gs filename template char
            str(definition),
            str(input_path),
        ]

        # Derived budget, not a fixed 300 s (budget.run isolates stdin).
        result = budget.gs(cmd, what="Ghostscript (PDF/A)", path=input_path, pages=info["pages"])
        if result.returncode != 0:
            _discard(gs_target)
            raise RuntimeError(f"Ghostscript PDF/A conversion failed: {result.stderr}")

        report = standards_report.build(
            source_facts, gs_target, result.stdout, result.stderr
        )

        requested = f"PDF/A-{level}"
        if not _has_pdfa_output_intent(gs_target):
            _discard(gs_target)
            raise RuntimeError(
                "The output carries no PDF/A output intent, so "
                f"{requested} was not produced."
            )
        declared = standards_report.declared_pdfa(gs_target)
        if declared.upper() != requested.upper():
            _discard(gs_target)
            # Two refusals rather than one carrying a fallback phrase: the refusal
            # table interpolates a captured value verbatim, so a fallback phrase
            # would arrive as English inside every other language.
            if not declared:
                raise RuntimeError(
                    "The output declares no PDF/A conformance at all, so "
                    f"{requested} was not produced."
                )
            raise RuntimeError(
                f"Ghostscript PDF/A conversion did not produce {requested}: "
                f"the output declares {declared}."
            )

    return {
        "output": str(output_path),
        "level": requested,
        "declared_conformance": declared,
        "original_size": original_size,
        "output_size": output_path.stat().st_size,
        **report,
    }


def _discard(produced: Path) -> None:
    """A refused conversion leaves no file where a conformant one was asked
    for — an unmarked non-conformant file in that place is the failure this op
    exists to prevent."""
    try:
        produced.unlink(missing_ok=True)
    except OSError:
        pass


# The ICC version PDF/A-1 admits is ICC.1:1998-09 (version 2); the profile the
# user's Ghostscript ships as its own RGB default is version 2, and ROM-built
# Windows binaries carry it under %rom% when the on-disk tree is absent.
_ROM_RGB_PROFILE = "%rom%iccprofiles/default_rgb.icc"


def _rgb_profile(executable: Path) -> str:
    for root in (executable.parent.parent, executable.parent):
        candidate = root / "iccprofiles" / "default_rgb.icc"
        if candidate.is_file():
            return str(candidate)
    return _ROM_RGB_PROFILE


def _ps_path(path: str) -> str:
    return path.replace("\\", "/")


def _ps_string(text: str) -> str:
    escaped = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    return f"({escaped})"


def _output_intent_ps(profile: str) -> str:
    return (
        "%!\n"
        "[/_objdef {spectra_icc} /type /stream /OBJ pdfmark\n"
        "[{spectra_icc} << /N 3 >> /PUT pdfmark\n"
        f"[{{spectra_icc}} {_ps_string(_ps_path(profile))} (r) file /PUT pdfmark\n"
        "[/_objdef {spectra_intent} /type /dict /OBJ pdfmark\n"
        "[{spectra_intent} << /Type /OutputIntent /S /GTS_PDFA1"
        " /DestOutputProfile {spectra_icc}"
        " /OutputConditionIdentifier (sRGB IEC61966-2.1)"
        " /Info (sRGB IEC61966-2.1)"
        " /RegistryName (http://www.color.org) >> /PUT pdfmark\n"
        "[{Catalog} << /OutputIntents [ {spectra_intent} ] >> /PUT pdfmark\n"
    )


def _has_pdfa_output_intent(produced: Path) -> bool:
    import pikepdf

    try:
        with pikepdf.open(str(produced)) as pdf:
            intents = pdf.Root.get("/OutputIntents")
            if not isinstance(intents, pikepdf.Array):
                return False
            for intent in intents:
                if (
                    isinstance(intent, pikepdf.Dictionary)
                    and intent.get("/S") == pikepdf.Name("/GTS_PDFA1")
                    and isinstance(intent.get("/DestOutputProfile"), pikepdf.Stream)
                ):
                    return True
    except Exception:
        return False
    return False
