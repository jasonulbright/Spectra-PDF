"""Truthful PDF version declarations, with verified atomic publication."""

from pathlib import Path
import shutil
from io import BytesIO

from lxml import etree

import pikepdf
from engine.inplace import staged_write
from engine.pdf_save import encryption_profile, save_pdf
from engine.pdf_version import effective_version, parse_version, version_facts


def _prepare_version_metadata(pdf: pikepdf.Pdf, version: str) -> None:
    """A subset's version ceiling is not changed by editing its PDF label.

    Keep the shared identifier namespace registry, adding PDF/A (omitted by
    the conversion-loss census because its converter intentionally writes it).
    Unreadable declarations are not proof that no constraint exists.
    """
    from engine.standards_report import _IDENTIFIER_NAMESPACES

    try:
        info = pdf.trailer.get('/Info')
        if info is not None:
            if not isinstance(info, pikepdf.Dictionary):
                raise ValueError()
            if any(info.get(key) is not None for key in ('/GTS_PDFXVersion', '/GTS_PDFXConformance')):
                raise ValueError()
        metadata = pdf.Root.get('/Metadata')
        if metadata is None:
            return
        if not isinstance(metadata, pikepdf.Stream):
            raise ValueError()
        raw = metadata.read_bytes()
        if len(raw) > 8 * 1024 * 1024:
            raise ValueError()
        parser = etree.XMLParser(resolve_entities=False, no_network=True, recover=False,
                                 remove_blank_text=False, remove_comments=False, strip_cdata=False)
        tree = etree.parse(BytesIO(raw), parser)
        if tree.docinfo.doctype:
            raise ValueError()
        identifiers = {**_IDENTIFIER_NAMESPACES, 'http://www.aiim.org/pdfa/ns/id/': ('PDF/A', None)}
        version_key = '{http://ns.adobe.com/pdf/1.3/}PDFVersion'
        changed = False
        for index, node in enumerate(tree.iter()):
            if index > 100000:
                raise ValueError()
            for name in (node.tag, *node.attrib):
                if not isinstance(name, str) or not name.startswith('{'):
                    continue
                namespace, local = name[1:].split('}', 1)
                entry = identifiers.get(namespace)
                if entry is not None and (entry[1] is None or entry[1] == local):
                    raise ValueError()
            if node.tag == version_key:
                # A scalar may not hide nested data that replacing .text
                # would leave contradictory or discard on serialization.
                if len(node):
                    raise ValueError()
                node.text = version
                changed = True
            if version_key in node.attrib:
                node.set(version_key, version)
                changed = True
        if changed:
            # lxml retains namespace bindings, comments, unknown attributes
            # and sibling processing instructions. Without this one property
            # there is no metadata change at all: keep the original bytes.
            metadata.write(etree.tostring(tree, encoding=tree.docinfo.encoding or 'UTF-8', xml_declaration=True))
    except (ValueError, TypeError, RuntimeError, etree.XMLSyntaxError, pikepdf.PdfError):
        raise ValueError("The PDF version cannot be changed without verifying this document's conformance declarations.") from None


def get_pdf_version(file: str) -> dict:
    """Read effective version and explicitly labelled physical declarations."""
    with pikepdf.open(file) as pdf:
        return {"file": file, **version_facts(pdf), "pages": len(pdf.pages)}


def set_pdf_version(
    file: str,
    output: str,
    version: str = "1.7",
) -> dict:
    """Raise a version requirement or copy an already-matching document.

    qpdf's force_version changes a label, not the complete feature set, and
    can weaken encryption for older targets. Without a feature-conversion
    proof, lowering is a refusal, never a claimed compatibility conversion.
    The result names declarations only; it certifies no PDF/A or PDF/X class.
    """
    target = parse_version(version)
    input_path, output_path = Path(file), Path(output)
    original_size = input_path.stat().st_size
    preserved = False
    # Stage even for a different output: a refusal must leave an existing
    # destination intact. Close every input handle before the final rename.
    with staged_write(output_path) as staged:
        with pikepdf.open(file) as pdf:
            facts = version_facts(pdf)
            current = effective_version(pdf)
            if target < current:
                raise ValueError("The PDF version cannot be lowered because compatibility with the requested version cannot be verified.")
            protection = encryption_profile(pdf)
            changed = target != current
            if changed:
                _prepare_version_metadata(pdf, version)
                metadata = pdf.Root.get('/Metadata')
                expected_metadata = metadata.read_bytes() if metadata is not None else None
                if target >= (1, 4):
                    pdf.Root.Version = pikepdf.Name('/' + version)
                save_pdf(pdf, staged, min_version=version, fix_metadata_version=False)
            else:
                # Do not rewrite signed, encrypted or conforming bytes when
                # their effective requirement already matches the request.
                shutil.copyfile(input_path, staged)
        if changed:
            from engine.incremental import finalize_preserving_signatures

            result = finalize_preserving_signatures(str(input_path), str(staged), update_version_metadata=True)
            preserved = bool(result.get('preserved'))
            if not preserved and result.get('reason') != 'not-signed':
                raise ValueError("The PDF version cannot be changed while preserving this document's signatures.")
        with pikepdf.open(staged) as written:
            if effective_version(written) != target:
                raise ValueError("The written PDF does not declare the requested version.")
            if changed:
                metadata = written.Root.get('/Metadata')
                actual_metadata = metadata.read_bytes() if isinstance(metadata, pikepdf.Stream) else None
                if actual_metadata != expected_metadata or (metadata is not None and not isinstance(metadata, pikepdf.Stream)):
                    raise ValueError("The written PDF does not declare the requested version.")
            if encryption_profile(written) != protection:
                raise ValueError("The PDF version change did not preserve the document's encryption.")
            output_facts = version_facts(written)
        output_size = staged.stat().st_size

    return {
        "output": str(output_path),
        "original_version": facts['version'],
        "original_header_version": facts['header_version'],
        "original_catalog_version": facts['catalog_version'],
        "target_version": version,
        "effective_version": output_facts['version'],
        "header_version": output_facts['header_version'],
        "catalog_version": output_facts['catalog_version'],
        "changed": changed,
        "signatures_preserved": not changed or preserved,
        "original_size": original_size,
        "output_size": output_size,
    }
