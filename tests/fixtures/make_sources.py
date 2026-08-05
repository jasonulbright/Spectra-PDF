"""Deterministic Office/text/web sources for the Create PDF tests.

Run it to regenerate; the resulting `.docx`/`.xlsx`/`.pptx` are CHECKED IN
beside it so a regeneration is reviewable as a git diff rather than a silent
change to what the conversion tests measure (the `make_scans.py` precedent).

    .venv/Scripts/python.exe tests/fixtures/make_sources.py

The flat-ODF originals are hand-written and checked in as text, because they
are the readable statement of what each source CONTAINS; the OOXML files are
produced from them by the VENDORED soffice, which also proves the export
filters those tests lean on. Every source carries the sentinel token
``ZQXJ-2026`` so a conversion test can assert real extractable text rather than
"a PDF appeared".

`fonts-missing.fodt` deliberately declares a face no machine has — it is the
font-substitution pin, and it must stay implausible.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
SOURCES = HERE / "sources"
REPO = HERE.parent.parent
SOFFICE = REPO / "resources" / "libreoffice" / "program" / "soffice.exe"

TOKEN = "ZQXJ-2026"

FODT = """<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
 xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
 xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"
 xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"
 xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"
 office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.text">
 <office:font-face-decls>
  <style:font-face style:name="Liberation Serif" svg:font-family="Liberation Serif"/>
 </office:font-face-decls>
 <office:automatic-styles>
  <style:style style:name="H" style:family="paragraph">
   <style:text-properties fo:font-size="18pt" fo:font-weight="bold"/>
  </style:style>
 </office:automatic-styles>
 <office:body><office:text>
  <text:p text:style-name="H">Quarterly Report</text:p>
  <text:p>The quick brown fox jumps over the lazy dog.</text:p>
  <text:p>Second paragraph with a specific token: ZQXJ-2026.</text:p>
 </office:text></office:body>
</office:document>
"""

FODT_MISSING_FONT = """<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
 xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
 xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"
 xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"
 xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"
 office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.text">
 <office:font-face-decls>
  <style:font-face style:name="NoSuchFace9713" svg:font-family="NoSuchFace9713"/>
 </office:font-face-decls>
 <office:automatic-styles>
  <style:style style:name="M" style:family="paragraph">
   <style:text-properties style:font-name="NoSuchFace9713" fo:font-size="14pt"/>
  </style:style>
 </office:automatic-styles>
 <office:body><office:text>
  <text:p text:style-name="M">Token ZQXJ-2026 set in a face no machine has.</text:p>
 </office:text></office:body>
</office:document>
"""

FODS = """<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
 xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
 xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
 office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.spreadsheet">
 <office:body><office:spreadsheet>
  <table:table table:name="Sheet1">
   <table:table-row><table:table-cell office:value-type="string"><text:p>Region</text:p></table:table-cell>
    <table:table-cell office:value-type="string"><text:p>Revenue</text:p></table:table-cell></table:table-row>
   <table:table-row><table:table-cell office:value-type="string"><text:p>North</text:p></table:table-cell>
    <table:table-cell office:value-type="float" office:value="1200"><text:p>1200</text:p></table:table-cell></table:table-row>
   <table:table-row><table:table-cell office:value-type="string"><text:p>ZQXJ-2026</text:p></table:table-cell>
    <table:table-cell office:value-type="float" office:value="99"><text:p>99</text:p></table:table-cell></table:table-row>
  </table:table>
 </office:spreadsheet></office:body>
</office:document>
"""

FODP = """<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
 xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"
 xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
 xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"
 office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.presentation">
 <office:body><office:presentation>
  <draw:page draw:name="page1">
   <draw:frame svg:width="20cm" svg:height="3cm" svg:x="2cm" svg:y="3cm">
    <draw:text-box><text:p>Slide One ZQXJ-2026</text:p></draw:text-box></draw:frame>
  </draw:page>
  <draw:page draw:name="page2">
   <draw:frame svg:width="20cm" svg:height="3cm" svg:x="2cm" svg:y="3cm">
    <draw:text-box><text:p>Slide Two</text:p></draw:text-box></draw:frame>
  </draw:page>
 </office:presentation></office:body>
</office:document>
"""

HTML = """<html><head><meta charset="utf-8"><title>T</title></head>
<body><h1>HTML Heading</h1><p>Body text ZQXJ-2026 here.</p>
<table border=1><tr><td>a</td><td>b</td></tr></table></body></html>
"""

RTF = r"""{\rtf1\ansi\deff0{\fonttbl{\f0\froman Liberation Serif;}}
\f0\fs24 RTF paragraph ZQXJ-2026.\par Second line.\par}
"""

TXT = "Plain text line one ZQXJ-2026.\nLine two.\n"
CSV = "Region,Revenue\nNorth,1200\nZQXJ-2026,99\n"

TEXT_SOURCES = {
    "report.fodt": FODT,
    "fonts-missing.fodt": FODT_MISSING_FONT,
    "sheet.fods": FODS,
    "deck.fodp": FODP,
    "page.html": HTML,
    "note.rtf": RTF,
    "note.txt": TXT,
    "data.csv": CSV,
}

# flat source -> (soffice filter, produced extension, final name)
BINARY_SOURCES = [
    ("report.fodt", "docx:MS Word 2007 XML", ".docx", "report.docx"),
    ("report.fodt", "odt:writer8", ".odt", "report.odt"),
    ("sheet.fods", "xlsx:Calc MS Excel 2007 XML", ".xlsx", "sheet.xlsx"),
    ("sheet.fods", "ods:calc8", ".ods", "sheet.ods"),
    ("deck.fodp", "pptx:Impress MS PowerPoint 2007 XML", ".pptx", "deck.pptx"),
    ("fonts-missing.fodt", "docx:MS Word 2007 XML", ".docx", "fonts-missing.docx"),
]


def convert(flat: Path, filt: str, out_dir: Path) -> None:
    profile = Path(tempfile.mkdtemp(prefix="lo-fixture-"))
    try:
        subprocess.run(
            [
                str(SOFFICE),
                f"-env:UserInstallation={profile.as_uri()}",
                "--headless",
                "--norestore",
                "--convert-to",
                filt,
                "--outdir",
                str(out_dir),
                str(flat),
            ],
            capture_output=True,
            stdin=subprocess.DEVNULL,
            timeout=300,
            check=True,
        )
    finally:
        shutil.rmtree(profile, ignore_errors=True)


def main() -> int:
    SOURCES.mkdir(parents=True, exist_ok=True)
    for name, body in TEXT_SOURCES.items():
        (SOURCES / name).write_text(body, encoding="utf-8", newline="\n")
        print("  wrote", name)
    if not SOFFICE.is_file():
        print(f"NO VENDORED SOFFICE at {SOFFICE} — the OOXML sources were not rebuilt.")
        return 1
    work = Path(tempfile.mkdtemp(prefix="lo-fixture-out-"))
    try:
        for flat, filt, ext, final in BINARY_SOURCES:
            convert(SOURCES / flat, filt, work)
            produced = work / (Path(flat).stem + ext)
            if not produced.is_file():
                print(f"  FAILED {flat} -> {final}")
                return 1
            shutil.move(str(produced), str(SOURCES / final))
            print(f"  wrote {final} ({(SOURCES / final).stat().st_size} B)")
    finally:
        shutil.rmtree(work, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
