"""Embedded file attachments — the /EmbeddedFiles name tree (§ I.6).

The king lets a document carry attached files (a spreadsheet beside its report,
a source file beside its export). They live in the catalog's /Names
/EmbeddedFiles name tree; pikepdf exposes them as `pdf.attachments`. This module
lists, adds, extracts, and removes them — a name-tree editor, like the AcroJS
and page-labels editors.
"""

import mimetypes
import shutil
import tempfile
from pathlib import Path

import pikepdf


def list_attachments(file: str) -> dict:
    """Every embedded file: name, byte size, description, and MIME type."""
    with pikepdf.open(file) as pdf:
        out = []
        for name in pdf.attachments.keys():
            spec = pdf.attachments[name]
            size = 0
            mime = ""
            try:
                data = spec.get_file()
                raw = data.read_bytes()
                size = len(raw)
                mime = data.mime_type or ""
            except Exception:
                pass
            out.append({
                "name": name,
                "size": size,
                "description": spec.description or "",
                "mime": mime,
            })
        out.sort(key=lambda a: a["name"].lower())
        return {"attachments": out, "count": len(out)}


def add_attachment(
    file: str,
    output: str,
    source: str,
    name: str = "",
    description: str = "",
) -> dict:
    """Embed `source` into the PDF as an attachment.

    Args:
        source: path of the file to embed.
        name: the embedded name (defaults to the source's base name).
        description: optional human description.
    """
    src = Path(source)
    if not src.is_file():
        raise ValueError(f"source file not found: {source}")
    attach_name = name.strip() or src.name
    data = src.read_bytes()
    mime = mimetypes.guess_type(attach_name)[0] or "application/octet-stream"

    input_path = Path(file)
    output_path = Path(output)
    same_file = input_path.resolve() == output_path.resolve()

    with pikepdf.open(file) as pdf:
        if attach_name in pdf.attachments:
            raise ValueError(f"an attachment named {attach_name!r} already exists")
        spec = pikepdf.AttachedFileSpec(
            pdf, data, filename=attach_name, description=description or "", mime_type=mime
        )
        pdf.attachments[attach_name] = spec
        _save(pdf, input_path, output_path, same_file)

    return {"output": str(output_path), "name": attach_name, "size": len(data), "mime": mime}


def extract_attachment(file: str, name: str, output: str) -> dict:
    """Write an embedded file out to `output` on disk."""
    with pikepdf.open(file) as pdf:
        if name not in pdf.attachments:
            raise ValueError(f"no attachment named {name!r}")
        data = pdf.attachments[name].get_file().read_bytes()
    Path(output).write_bytes(data)
    return {"output": str(output), "name": name, "size": len(data)}


def remove_attachment(file: str, output: str, name: str) -> dict:
    """Delete an embedded file from the document."""
    input_path = Path(file)
    output_path = Path(output)
    same_file = input_path.resolve() == output_path.resolve()

    with pikepdf.open(file) as pdf:
        if name not in pdf.attachments:
            raise ValueError(f"no attachment named {name!r}")
        del pdf.attachments[name]
        _save(pdf, input_path, output_path, same_file)

    return {"output": str(output_path), "name": name}


def _save(pdf, input_path: Path, output_path: Path, same_file: bool) -> None:
    if same_file:
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False, dir=str(input_path.parent)) as tmp:
            tmp_path = tmp.name
        pdf.save(tmp_path)
        shutil.move(tmp_path, str(output_path))
    else:
        pdf.save(output_path)
