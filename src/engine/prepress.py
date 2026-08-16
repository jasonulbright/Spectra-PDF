"""ICC-managed colour conversion for prepress.

Converts a document's color to DeviceCMYK for print. Ghostscript drives the
conversion through its
built-in ICC engine (LittleCMS + its compiled-in default CMYK profile), so the
transform is colour-managed even though no external profile is bundled: an RGB
red (`1 0 0 rg`) comes out as CMYK (`0 0.996 1 0 k`), not a naive component
copy.

``convert_cmyk`` takes a destination ICC profile, either a user's .icc file or
a bare name resolved against
gs's ROM-filesystem profiles like ``default_cmyk.icc`` — probe-verified), and
``convert_pdfx`` produces a PDF/X master with a real /OutputIntents entry
(GTS_PDFX, registered characterization by identifier, optionally embedding
the user's destination profile as /DestOutputProfile) via a customized
PDFX_def.ps against the bundled template's contract. Soft-proofing remains a
distinct capability.
"""

import subprocess
import tempfile
from pathlib import Path

import pikepdf

from . import budget
from .acroform import reattach_forms_file
from .trapping import DEFAULT_TRAPPED, TRAPPED_VALUES
from .validate import validate_pdf

# Ghostscript render intent for the colour transform. Relative colorimetric
# (1) is the prepress default — it maps in-gamut colours exactly and clips the
# rest, which is what a print house expects; perceptual (0) would shift every
# colour to compress the gamut. 0=perceptual 1=relative 2=saturation 3=absolute.
# NB: with the BUILT-IN default CMYK profile "saturation" renders IDENTICALLY to
# perceptual — that profile has no Saturation (AToB2) table, so LittleCMS falls
# back to perceptual per the ICC spec. It stays a valid value (a bundled
# destination profile that defines it would make it distinct), but the UI does
# not offer it while it would be a no-op.
_RENDER_INTENTS = {"perceptual": 0, "relative": 1, "saturation": 2, "absolute": 3}


def _dest_profile_flag(dest_profile: str) -> list[str]:
    """-sOutputICCProfile for a user profile. A PATH must exist (typo caught
    early, not as an opaque gs error); a bare name passes through to gs's
    ROM-filesystem profile set (default_cmyk.icc and friends)."""
    p = str(dest_profile).strip()
    if not p:
        return []
    if ("/" in p or "\\" in p) and not Path(p).is_file():
        raise ValueError(f"Destination ICC profile not found: {p}")
    return [f"-sOutputICCProfile={p}"]


def _permit_profile_read(dest_profile: str) -> list[str]:
    """--permit-file-read for a destination profile that is a real file."""
    p = str(dest_profile).strip()
    if not p or not Path(p).is_file():
        return []
    return [f"--permit-file-read={p}"]


def convert_cmyk(
    file: str,
    output: str,
    render_intent: str = "relative",
    dest_profile: str = "",
    gs_path: str = "gs",
) -> dict:
    """Convert a PDF's colour to DeviceCMYK using Ghostscript's ICC engine.

    Args:
        file: Input PDF path.
        output: Output PDF path.
        render_intent: perceptual | relative | saturation | absolute (the ICC
            rendering intent; default relative colorimetric — the prepress norm).
        dest_profile: Optional destination ICC profile — a .icc file path, or a
            bare gs ROM-filesystem profile name. Empty = gs's compiled default.
        gs_path: Path to the Ghostscript executable.
    """
    info = validate_pdf(file)
    intent = _RENDER_INTENTS.get(str(render_intent).strip().lower())
    if intent is None:
        raise ValueError(
            "render_intent must be perceptual, relative, saturation, or absolute."
        )

    input_path = Path(file)
    output_path = Path(output)

    cmd = [
        gs_path,
        "-sDEVICE=pdfwrite",
        "-dCompatibilityLevel=1.5",
        "-sColorConversionStrategy=CMYK",
        "-dProcessColorModel=/DeviceCMYK",
        # Honour the chosen rendering intent for the ICC transform. NB: we do
        # NOT pass -dOverrideICC — that would REPLACE a source object's own
        # embedded ICC profile with gs's default, discarding the accurate source
        # colour description; honouring embedded profiles is the point of a
        # colour-managed conversion.
        f"-dRenderIntent={intent}",
        *_dest_profile_flag(dest_profile),
        # -dSAFER blocks the profile READ, so a destination profile given as a
        # path fails without an explicit permit — every path a file picker can
        # produce. A bare ROM-filesystem name is not a file and needs none.
        *_permit_profile_read(dest_profile),
        "-dNOPAUSE",
        "-dQUIET",
        "-dBATCH",
        "-dSAFER",
        # % is a gs filename template char (distill review).
        f"-sOutputFile={str(output_path).replace('%', '%%')}",
        str(input_path),
    ]

    # Derived budget (budget.run keeps the stdin isolation — gs must
    # never inherit the RPC pipe, the distill review's finding).
    result = budget.gs(cmd, what="Ghostscript (CMYK conversion)", path=input_path, pages=info["pages"])
    if result.returncode != 0:
        raise RuntimeError(f"Ghostscript CMYK conversion failed: {result.stderr}")

    # gs pdfwrite drops /AcroForm and every widget annotation — converting a
    # filled form would silently destroy it. Transplant the original's fields
    # back onto the regenerated pages (no-op for non-form files) — the same
    # reattach grayscale/compress do.
    reattach_forms_file(input_path, output_path)

    return {
        "output": str(output_path),
        "render_intent": str(render_intent).strip().lower(),
        "original_size": input_path.stat().st_size,
        "output_size": output_path.stat().st_size,
    }


# PDF/X targets: gs -dPDFX level → (GTS version we expect back, PDF level).
# X-3 is colour-managed (our conversion IS ICC-managed) and the default;
# X-1a is the CMYK-only legacy exchange target; X-4 allows transparency.
_PDFX_VERSIONS = {1: "1.3", 3: "1.3", 4: "1.6"}


def _ps_escape(s: str) -> str:
    return s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def _extract_rom_profile(gs_path: str, name: str, dest_dir: Path) -> Path:
    """Copy a gs ROM-filesystem ICC profile (default_cmyk.icc and friends —
    compiled into the gs DLL) out to a real file, so it can be EMBEDDED as a
    PDF/X /DestOutputProfile. Probe-verified: a PostScript read/write loop
    under --permit-file-write; the result carries the 'acsp' ICC magic."""
    dest = dest_dir / name
    dest_ps = str(dest).replace("\\", "/")
    ps = (
        f"(%rom%iccprofiles/{name}) (r) file /in exch def "
        f"({_ps_escape(dest_ps)}) (w) file /out exch def "
        "{ in read { out exch write } { exit } ifelse } loop out closefile"
    )
    result = subprocess.run(
        [
            gs_path,
            "-dNODISPLAY",
            "-dBATCH",
            "-dNOPAUSE",
            "-q",
            f"--permit-file-write={dest_ps}",
            "-c",
            ps,
        ],
        capture_output=True,
        text=True,
        timeout=60,
        stdin=subprocess.DEVNULL,
    )
    if result.returncode != 0 or not dest.is_file():
        raise RuntimeError(
            f"Could not extract the bundled profile {name}: {result.stderr}"
        )
    return dest


def _pdfx_def_ps(
    version: int,
    condition: str,
    identifier: str,
    info: str,
    icc_path: str,
    trapped: str = DEFAULT_TRAPPED,
) -> str:
    """A customized PDFX_def.ps (the bundled template's contract, trimmed to
    our fixed choices): DOCINFO GTS_PDFXVersion per level, an OutputIntent
    with the given condition/identifier, and — when a profile file is given —
    the embedded /DestOutputProfile stream with /N 4 declared directly (our
    ColorConversionStrategy is ALWAYS CMYK, so the template's fragile
    N-detection block is unnecessary, exactly as its own comments advise).

    `/Trapped` is a CLAIM about the document, and the converter is entitled to
    make it only when the caller asserts it: converting colour neither adds a
    trap network nor proves the absence of one, so the default is `/Unknown`.
    """
    gts = {1: "PDF/X-1a:2001", 3: "PDF/X-3:2002", 4: "PDF/X-4"}[version]
    claim = str(trapped).strip().lstrip("/").capitalize()
    if claim not in TRAPPED_VALUES:
        allowed = ", ".join(TRAPPED_VALUES)
        raise ValueError(f"Trapped must be one of {allowed}.")
    lines = [
        "%!",
        f"[ /GTS_PDFXVersion ({gts}) /Trapped /{claim} /DOCINFO pdfmark",
    ]
    if icc_path:
        ps_path = _ps_escape(str(Path(icc_path)).replace("\\", "/"))
        lines += [
            "[/_objdef {icc_PDFX} /type /stream /OBJ pdfmark",
            "[{icc_PDFX} << /N 4 >> /PUT pdfmark",
            f"[{{icc_PDFX}} ({ps_path}) (r) file /PUT pdfmark",
        ]
    lines += [
        "[/_objdef {OutputIntent_PDFX} /type /dict /OBJ pdfmark",
        "[{OutputIntent_PDFX} <<",
        "  /Type /OutputIntent",
        "  /S /GTS_PDFX",
        f"  /OutputCondition ({_ps_escape(condition)})",
        f"  /Info ({_ps_escape(info) if info else 'none'})",
        f"  /OutputConditionIdentifier ({_ps_escape(identifier)})",
        "  /RegistryName (http://www.color.org)",
        *(["  /DestOutputProfile {icc_PDFX}"] if icc_path else []),
        ">> /PUT pdfmark",
        "[{Catalog} <</OutputIntents [ {OutputIntent_PDFX} ]>> /PUT pdfmark",
    ]
    return "\n".join(lines) + "\n"


def convert_pdfx(
    file: str,
    output: str,
    version: int = 3,
    dest_profile: str = "",
    condition: str = "Commercial and specialty printing",
    identifier: str = "CGATS TR001",
    info: str = "",
    gs_path: str = "gs",
    trapped: str = DEFAULT_TRAPPED,
) -> dict:
    """Produce a PDF/X print master with a real output intent (tail).

    The conversion runs CMYK (colour-managed, like convert_cmyk) and the
    output carries /GTS_PDFXVersion + a /GTS_PDFX /OutputIntents entry. With
    ``dest_profile`` (a .icc FILE) the profile is EMBEDDED as the intent's
    /DestOutputProfile and also drives the conversion itself
    (-sOutputICCProfile), so the pixels and the declared condition agree;
    without it, the intent names a registered characterization by
    ``identifier`` alone (PDF/X permits that for registry conditions).

    Deliberate non-carrier: like PDF/A, the output does NOT get the original's
    interactive form fields transplanted back — a PDF/X master is a print
    exchange file, and conformance limits interactive content (the same
    rationale recorded on the PDF/A converter).
    """
    validate_pdf(file)
    version = int(version)
    if version not in _PDFX_VERSIONS:
        raise ValueError("version must be 1 (X-1a), 3 (X-3), or 4 (X-4).")
    profile = str(dest_profile).strip()

    input_path = Path(file)
    output_path = Path(output)

    extracted: Path | None = None
    if profile and not Path(profile).is_file():
        if "/" in profile or "\\" in profile:
            raise ValueError(f"Destination ICC profile not found: {profile}")
        # A bare gs ROM-filesystem name (default_cmyk.icc …): the EMBED needs
        # a real file, so copy it out of the DLL first.
        extracted = _extract_rom_profile(gs_path, profile, output_path.parent)
        profile = str(extracted)

    def_fd, def_path = tempfile.mkstemp(suffix=".ps", dir=str(output_path.parent))
    try:
        with open(def_fd, "w", encoding="ascii") as f:
            f.write(_pdfx_def_ps(version, condition, identifier, info, profile, trapped))
        cmd = [
            gs_path,
            "-sDEVICE=pdfwrite",
            f"-dPDFX={version}" if version != 3 else "-dPDFX",
            f"-dCompatibilityLevel={_PDFX_VERSIONS[version]}",
            "-sColorConversionStrategy=CMYK",
            "-dProcessColorModel=/DeviceCMYK",
            *(_dest_profile_flag(profile)),
            # The def file READS the profile to embed it — -dSAFER blocks
            # that without an explicit permit (live test catch).
            *([f"--permit-file-read={profile}"] if profile else []),
            "-dNOPAUSE",
            "-dQUIET",
            "-dBATCH",
            "-dSAFER",
            f"-sOutputFile={str(output_path).replace('%', '%%')}",
            def_path,
            str(input_path),
        ]
        # Derived budget; the floor stays at this call's own 600 s.
        result = budget.gs(
            cmd, what="Ghostscript (PDF/X conversion)", path=input_path, base=600.0
        )
        if result.returncode != 0:
            raise RuntimeError(f"Ghostscript PDF/X conversion failed: {result.stderr}")
    finally:
        Path(def_path).unlink(missing_ok=True)
        if extracted is not None:
            extracted.unlink(missing_ok=True)

    # The claim is checkable — check it (never ship a silent non-conformance).
    with pikepdf.open(output_path) as pdf:
        intents = pdf.Root.get("/OutputIntents")
        if intents is None or len(intents) == 0:
            raise RuntimeError("PDF/X output carries no /OutputIntents — conversion failed.")
        gts = str(pdf.docinfo.get("/GTS_PDFXVersion", ""))
        claimed = str(pdf.docinfo.get("/Trapped", "")).lstrip("/")

    return {
        "output": str(output_path),
        "pdfx_version": gts,
        "trapped": claimed,
        "embedded_profile": bool(profile),
        "original_size": input_path.stat().st_size,
        "output_size": output_path.stat().st_size,
    }
