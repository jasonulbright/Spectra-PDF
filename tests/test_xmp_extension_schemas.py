"""The PDF Association's XMP extension schema templates, pinned.

ISO 19005-1/-2/-3 cl. 6.6.2.3.2 requires an extension schema description for
any XMP property outside the part's own predefined schemas — which is what a
file also declaring PDF/UA (`pdfuaid`) or PDF/X (`pdfxid`) carries. These two
templates are the association's published wording for those descriptions; they
are held here so a claim about what a conformant packet must contain is checked
against a source rather than reconstructed.

ISO 19005-4 cl. 6.7 takes a different route — no extension schema in XMP, a
RELAX-NG schema as an associated file — so neither template applies to PDF/A-4.

Pinned by digest: an upstream revision is a deliberate re-pin, never a silent
change to what the requirement is understood to be.
"""

from __future__ import annotations

import hashlib
import json
import pathlib

CORPUS = pathlib.Path(__file__).parent / "fixtures" / "xmp-extension-schemas"
MANIFEST = json.loads((CORPUS / "MANIFEST.json").read_text(encoding="utf-8"))

# The identifier namespaces the comprehensive template describes. A file that
# declares one of these alongside a PDF/A identifier is exactly the
# multi-conformant case cl. 6.6.2.3.2 reaches.
_SUBSET_NAMESPACES = (
    "http://www.aiim.org/pdfua/ns/id/",
    "http://www.npes.org/pdfx/ns/id/",
    "http://www.npes.org/pdfvt/ns/id/",
)


def test_templates_match_their_pinned_digests():
    present = {p.name for p in CORPUS.glob("*.xml")}
    assert present == set(MANIFEST["files"])
    for name, digest in sorted(MANIFEST["files"].items()):
        assert hashlib.sha256((CORPUS / name).read_bytes()).hexdigest() == digest, name


def test_the_comprehensive_template_describes_the_subset_identifiers():
    text = (CORPUS / "ExtensionSchemaAllSubsets-2025_02.xml").read_text(encoding="utf-8")
    assert "pdfaExtension:schemas" in text
    for namespace in _SUBSET_NAMESPACES:
        assert namespace in text, namespace


def test_the_tdmrep_template_describes_the_tdm_namespace():
    text = (CORPUS / "TDMRepSchema-2025_02.xml").read_text(encoding="utf-8")
    assert "pdfaExtension:schemas" in text
    assert "http://www.w3.org/ns/tdmrep/" in text
