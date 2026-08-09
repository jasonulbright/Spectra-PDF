"""PDF portfolios — /Collection over the /EmbeddedFiles tree.

A portfolio is a catalog `/Collection` dictionary plus member files in the
same `/EmbeddedFiles` name tree that ordinary attachments use — so member
CRUD IS the attachments machinery (`add_attachment` / `extract_attachment` /
`remove_attachment` are reused verbatim by the panel and CLI). This module
adds the portfolio-shaped surface:

- `get_portfolio` [INTERNAL, read-only]: is-it-a-portfolio + the member list.
- `create_portfolio`: a NEW portfolio PDF from disk files — a generated
  one-page cover sheet (the zero-page rule holds: every PDF this app writes
  has at least one real page), a minimal `/Collection << /Type /Collection
  /View /D >>` (details view — the only portfolio presentation modern
  viewers still honour), and each source embedded. Duplicate basenames get
  auto-suffixed "name (2).ext" because different source folders commonly
  contain files with the same name.
- `make_portfolio`: convert an EXISTING document by adding `/Collection`;
  its attachments (if any) become the members.
- `update_portfolio_member`: replace a member's bytes from a disk file,
  preserving its description unless a new one is given — the save-back
  primitive for "open member, edit, update".
- `extract_member_to_dir`: extract a member into a DIRECTORY, sanitizing
  Windows-illegal name characters and creating the directory — the
  open-member primitive (the renderer extracts then opens the real file
  through the one open funnel).

The cover sheet is pure ASCII boilerplate (label + member count). It never
draws user text, so it needs no
font machinery beyond standard-14 Helvetica. The user's title lands in the
document Info `/Title` in full Unicode; the panel and viewers read it there.
"""

import mimetypes
from pathlib import Path

import pikepdf
from pikepdf import Dictionary, Name

from engine.attachments import _save, list_attachments
from engine.fs_names import safe_file_name, unique_name, unique_path
from engine.pdf_metrics import text_width_em
from engine.pdf_save import save_pdf
from engine.watermark import _escape_pdf_text, _n

_PAGE_W = 612.0  # US Letter; the cover sheet is generated boilerplate
_PAGE_H = 792.0

_VIEW_NAMES = {"/D": "details", "/T": "tile", "/H": "hidden"}



def get_portfolio(file: str) -> dict:
    """Whether `file` is a portfolio, its view mode, and its member list."""
    with pikepdf.open(file) as pdf:
        col = pdf.Root.get("/Collection")
        is_portfolio = col is not None
        view = ""
        if is_portfolio:
            raw = col.get("/View")
            view = _VIEW_NAMES.get(str(raw), "custom") if raw is not None else "details"
    members = list_attachments(file)["attachments"]
    return {
        "is_portfolio": bool(is_portfolio),
        "view": view,
        "members": members,
        "count": len(members),
    }


def create_portfolio(output: str, sources: list, title: str = "") -> dict:
    """Build a NEW portfolio PDF at `output` embedding every path in `sources`."""
    if not sources:
        raise ValueError("a portfolio needs at least one member file")
    out_path = Path(output)
    resolved_out = out_path.resolve()
    src_paths = []
    for s in sources:
        p = Path(s)
        if not p.is_file():
            raise ValueError(f"member source not found: {s}")
        if p.resolve() == resolved_out:
            raise ValueError("the portfolio output cannot be one of its own members")
        src_paths.append(p)

    shown_title = (title or "").strip() or out_path.stem
    pdf = pikepdf.new()
    try:
        _draw_cover(pdf, len(src_paths))
        pdf.Root.Collection = pdf.make_indirect(
            Dictionary(Type=Name.Collection, View=Name.D)
        )
        pdf.docinfo["/Title"] = shown_title
        members = []
        used = set()
        for p in src_paths:
            name = unique_name(p.name, used)
            used.add(name.lower())
            data = p.read_bytes()
            mime = mimetypes.guess_type(name)[0] or "application/octet-stream"
            pdf.attachments[name] = pikepdf.AttachedFileSpec(
                pdf, data, filename=name, description="", mime_type=mime
            )
            members.append({"name": name, "size": len(data), "mime": mime})
        out_path.parent.mkdir(parents=True, exist_ok=True)
        save_pdf(pdf, str(out_path))
    finally:
        pdf.close()
    return {"output": str(out_path), "members": members, "count": len(members)}


def make_portfolio(file: str, output: str) -> dict:
    """Add `/Collection` to an existing document; its attachments become members."""
    input_path = Path(file)
    output_path = Path(output)
    same_file = input_path.resolve() == output_path.resolve()
    with pikepdf.open(file) as pdf:
        if pdf.Root.get("/Collection") is not None:
            raise ValueError("this document is already a portfolio")
        pdf.Root.Collection = pdf.make_indirect(
            Dictionary(Type=Name.Collection, View=Name.D)
        )
        _save(pdf, input_path, output_path, same_file)
    count = list_attachments(str(output_path))["count"]
    return {"output": str(output_path), "count": count}


def update_portfolio_member(
    file: str,
    output: str,
    name: str,
    source: str,
    description: str = "",
) -> dict:
    """Replace member `name`'s bytes with `source`'s; keep its description
    unless a non-empty `description` is given."""
    src = Path(source)
    if not src.is_file():
        raise ValueError(f"source file not found: {source}")
    input_path = Path(file)
    output_path = Path(output)
    same_file = input_path.resolve() == output_path.resolve()

    data = src.read_bytes()
    mime = mimetypes.guess_type(name)[0] or "application/octet-stream"
    with pikepdf.open(file) as pdf:
        if name not in pdf.attachments:
            raise ValueError(f"no member named {name!r}")
        kept = description.strip() or (pdf.attachments[name].description or "")
        del pdf.attachments[name]
        pdf.attachments[name] = pikepdf.AttachedFileSpec(
            pdf, data, filename=name, description=kept, mime_type=mime
        )
        _save(pdf, input_path, output_path, same_file)
    return {"output": str(output_path), "name": name, "size": len(data)}


def extract_member_to_dir(file: str, name: str, dest_dir: str) -> dict:
    """Extract member `name` into `dest_dir` (created if missing), sanitizing
    characters the filesystem refuses; returns the real path written."""
    with pikepdf.open(file) as pdf:
        if name not in pdf.attachments:
            raise ValueError(f"no member named {name!r}")
        data = pdf.attachments[name].get_file().read_bytes()

    dest = Path(dest_dir)
    dest.mkdir(parents=True, exist_ok=True)
    target = unique_path(dest, safe_file_name(name, "member"))
    target.write_bytes(data)
    return {"output": str(target), "name": name, "size": len(data)}


def _draw_cover(pdf: "pikepdf.Pdf", member_count: int) -> None:
    """Generate a Letter cover page containing boilerplate and a member count.

    The user-supplied title lives in /Title rather than page content.
    """
    page = pdf.add_blank_page(page_size=(_PAGE_W, _PAGE_H))
    plural = "file" if member_count == 1 else "files"
    lines = [
        ("PDF Portfolio", 24.0, _PAGE_H - 180.0),
        (f"Contains {member_count} embedded {plural}.", 12.0, _PAGE_H - 214.0),
        ("Open this document in a portfolio-aware viewer to browse its files.", 11.0, _PAGE_H - 234.0),
    ]
    ops = ["q", "0.13 0.13 0.13 rg"]
    for text, size, y in lines:
        w = text_width_em(text) * size
        x = max((_PAGE_W - w) / 2.0, 36.0)
        ops.append(
            f"BT /F0 {_n(size)} Tf {_n(x)} {_n(y)} Td ({_escape_pdf_text(text)}) Tj ET"
        )
    ops.append("Q")
    page.Contents = pdf.make_stream(" ".join(ops).encode("latin-1"))
    page.Resources = Dictionary(
        Font=Dictionary(
            F0=Dictionary(
                Type=Name.Font,
                Subtype=Name.Type1,
                BaseFont=Name.Helvetica,
                Encoding=Name.WinAnsiEncoding,
            )
        )
    )
