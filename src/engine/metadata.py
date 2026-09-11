"""PDF metadata editing and stripping using pikepdf."""

from pathlib import Path

import pikepdf
from lxml import etree

from .inplace import staged_write
from engine.pdf_save import save_pdf

_PROPERTIES = {
    'title': ('dc:title', '/Title'), 'author': ('dc:creator', '/Author'),
    'subject': ('dc:description', '/Subject'), 'keywords': ('pdf:Keywords', '/Keywords'),
    'creator': ('xmp:CreatorTool', '/Creator'), 'producer': ('pdf:Producer', '/Producer'),
}
_NS = {'rdf': 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
       'dc': 'http://purl.org/dc/elements/1.1/', 'pdf': 'http://ns.adobe.com/pdf/1.3/',
       'xmp': 'http://ns.adobe.com/xap/1.0/', 'xml': 'http://www.w3.org/XML/1998/namespace'}


def _name(value):
    prefix, local = value.split(':')
    return '{' + _NS[prefix] + '}' + local


def _xmp_fields(root):
    """Read the six editable/displayed properties without lossy convenience rules.

    Preserve explicit empty values, select x-default in language alternatives,
    and refuse ambiguous/structured declarations instead of seeding an empty edit.
    Unknown properties remain opaque and are retained by the writer.
    """
    rdfs = list(root.iter(_name('rdf:RDF')))
    if len(rdfs) != 1:
        raise ValueError
    rdf = rdfs[0]
    values, locations = {}, {}
    for key, (xmp_key, _) in _PROPERTIES.items():
        name = _name(xmp_key)
        found = []
        for desc in rdf:
            if desc.tag != _name('rdf:Description'):
                continue
            matches = [(desc, name)] if name in desc.attrib else []
            matches += [(node, None) for node in desc if node.tag == name]
            if matches and desc.get(_name('rdf:about'), '') != '':
                raise ValueError
            found += matches
        if len(found) > 1:
            raise ValueError
        if not found:
            continue
        node, attr = found[0]
        locations[key] = (node, attr)
        if attr:
            if key == 'author':
                raise ValueError
            values[key] = node.get(attr)
            continue
        if any(name != _name('xml:lang') for name in node.attrib):
            raise ValueError
        children = [child for child in node if isinstance(child.tag, str)]
        if not children:
            if key == 'author':
                raise ValueError
            # XML comments/PIs split character data without changing its value.
            values[key] = ''.join(node.itertext())
            continue
        expected = 'rdf:Alt' if key in ('title', 'subject') else 'rdf:Seq' if key == 'author' else None
        if expected is None or len(children) != 1 or children[0].tag != _name(expected) or (node.text or '').strip():
            raise ValueError
        container = children[0]
        if container.attrib or (container.text or '').strip() or any((child.tail or '').strip() for child in node):
            raise ValueError
        items, languages = [], set()
        for item in container:
            if not isinstance(item.tag, str):
                if (item.tail or '').strip():
                    raise ValueError
                continue
            if item.tag != _name('rdf:li') or len(item) or (item.tail or '').strip() or any(
                    name != _name('xml:lang') for name in item.attrib):
                raise ValueError
            if expected == 'rdf:Alt':
                language = item.get(_name('xml:lang'))
                if not language or language in languages:
                    raise ValueError
                languages.add(language)
            items.append(item)
        if expected == 'rdf:Seq':
            values[key] = [item.text or '' for item in items]
        else:
            selected = next((item for item in items if item.get(_name('xml:lang')) == 'x-default'), items[0] if items else None)
            values[key] = '' if selected is None else selected.text or ''
    return rdf, values, locations


def _write_property(rdf, locations, key, value):
    location = locations.get(key)
    if location:
        node, attr = location
        if attr:
            node.set(attr, value)
            return
    else:
        desc = next((d for d in rdf if d.tag == _name('rdf:Description')
                     and d.get(_name('rdf:about'), '') == ''), None)
        if desc is None:
            desc = etree.SubElement(rdf, _name('rdf:Description'), {_name('rdf:about'): ''})
        node = etree.SubElement(desc, _name(_PROPERTIES[key][0]))
    if key in ('title', 'subject'):
        alt = node.find(_name('rdf:Alt'))
        if alt is None:
            for child in list(node):
                node.remove(child)
            node.text = None
            alt = etree.SubElement(node, _name('rdf:Alt'))
        target = next((item for item in alt if item.get(_name('xml:lang')) == 'x-default'), None)
        if target is None:
            target = etree.Element(_name('rdf:li'), {_name('xml:lang'): 'x-default'})
            alt.insert(0, target)
        target.text = value
    elif key == 'author':
        for child in list(node):
            node.remove(child)
        node.text = None
        seq = etree.SubElement(node, _name('rdf:Seq'))
        etree.SubElement(seq, _name('rdf:li')).text = value
    else:
        for child in list(node):
            node.remove(child)
        node.text = value


def _read_properties(pdf):
    """Read XMP first, falling back per absent property to ordinary Info.

    Never enter the metadata editing context during a read. A malformed
    declaration is not an empty editable baseline, and fallback is not repair.
    """
    try:
        from .doc_properties import _pdf_text
        info = pdf.trailer.get('/Info')
        if info is not None and not isinstance(info, pikepdf.Dictionary):
            raise ValueError
        # Validate even a shadowed Info field: a later edit must not silently
        # replace a declaration whose original value was never understood.
        fallback = {key: '' if info is None or info.get(info_key) is None else _pdf_text(info.get(info_key))
                    for key, (_, info_key) in _PROPERTIES.items()}
        stream = pdf.Root.get('/Metadata')
        root = None
        if stream is not None:
            if not isinstance(stream, pikepdf.Stream):
                raise ValueError
            data = stream.read_bytes()
            if not data.strip() or len(data) > 4 * 1024 * 1024:
                raise ValueError
            parser = etree.XMLPullParser(events=('start', 'comment', 'pi'),
                resolve_entities=False, load_dtd=False, no_network=True, recover=False, huge_tree=False)
            nodes = 0
            for start in range(0, len(data), 65536):
                parser.feed(data[start:start + 65536])
                nodes += sum(1 for _ in parser.read_events())
                if nodes > 100000:
                    raise ValueError
            root = parser.close()
            if root.getroottree().docinfo.doctype or any(isinstance(n, etree._Entity) for n in root.iter()):
                raise ValueError
        values = fallback
        if root is not None:
            _, xmp_values, _ = _xmp_fields(root)
            values.update(xmp_values)
        return root, values
    except Exception:
        raise ValueError("The document's metadata cannot be read completely.") from None


def _save_copy(pdf, output_path, rebrand=False):
    with staged_write(output_path) as staged:
        # This operation does not change the PDF version. Automatic metadata
        # repair re-materializes the stream and loses its unrelated dictionary.
        save_pdf(pdf, staged, fix_metadata_version=False)
        pdf.close()
        if rebrand:
            _rebrand_xmptk(staged)


def _rebrand_xmptk(path: Path) -> None:
    """Replace pikepdf's xmptk attribute. Same byte length to preserve linearization."""
    data = path.read_bytes()
    patched = data.replace(b'xmptk="pikepdf"', b'xmptk="SpecPDF"')
    if patched != data:
        path.write_bytes(patched)


def get_metadata(file: str) -> dict:
    """Read metadata from a PDF.

    Args:
        file: Input PDF path.
    """
    with pikepdf.open(file) as pdf:
        _, values = _read_properties(pdf)
        return {"file": file, **values, "pages": len(pdf.pages)}


def apply_metadata_fields(pdf, **changes):
    """Own only the requested fields; publication and policy belong to callers."""
    root, _ = _read_properties(pdf)
    if root is None:
        root = etree.Element('{adobe:ns:meta/}xmpmeta', nsmap={'x': 'adobe:ns:meta/', **_NS})
        etree.SubElement(root, _name('rdf:RDF'))
    rdf, _, locations = _xmp_fields(root)
    for key, value in changes.items():
        if value is not None:
            _write_property(rdf, locations, key, value)
    stream = pdf.make_stream(etree.tostring(root.getroottree(), encoding='utf-8', xml_declaration=True))
    previous = pdf.Root.get('/Metadata')
    if isinstance(previous, pikepdf.Stream):
        for key, value in previous.items():
            if key not in ('/Length', '/Filter', '/DecodeParms', '/DP'):
                stream[key] = value
    stream.Type = pikepdf.Name.Metadata
    stream.Subtype = pikepdf.Name.XML
    pdf.Root.Metadata = stream
    # Automatic XMP-to-Info syncing deletes absent fields. Preserve unrelated
    # Info-only authors, dates and private metadata instead.
    for key, value in changes.items():
        if value is not None:
            pdf.docinfo[_PROPERTIES[key][1]] = pikepdf.String(value)


def set_metadata(
    file: str,
    output: str,
    title: str | None = None,
    author: str | None = None,
    subject: str | None = None,
    keywords: str | None = None,
) -> dict:
    """Update metadata on a PDF.

    Args:
        file: Input PDF path.
        output: Output PDF path.
        title: Document title (None = don't change).
        author: Author name (None = don't change).
        subject: Subject/description (None = don't change).
        keywords: Keywords string (None = don't change).
    """
    with pikepdf.open(file) as pdf:
        apply_metadata_fields(pdf, title=title, author=author, subject=subject, keywords=keywords)
        output_path = Path(output)
        _save_copy(pdf, output_path)

    return {
        "output": str(output_path),
        "updated_fields": [
            k for k, v in {"title": title, "author": author, "subject": subject, "keywords": keywords}.items()
            if v is not None
        ],
    }


def strip_metadata(file: str, output: str) -> dict:
    """Remove all metadata from a PDF.

    Args:
        file: Input PDF path.
        output: Output PDF path.
    """
    output_path = Path(output)
    with pikepdf.open(file) as pdf:
        # Explicit removal does not need a recoverable interpretation of the
        # bytes being removed; do not repair malformed XML just to delete it.
        if '/Metadata' in pdf.Root:
            del pdf.Root['/Metadata']
        if pikepdf.Name.Info in pdf.trailer:
            del pdf.trailer[pikepdf.Name.Info]
        _save_copy(pdf, output_path, rebrand=True)

    return {
        "output": str(output_path),
        "stripped": True,
    }
