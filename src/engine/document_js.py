"""Document-level JavaScript: read and EDIT the catalog's /Names /JavaScript
name tree (Phase 9.S6 — "AcroJS editor").

The app EDITS document-level JavaScript — the scripts the industry-standard
editor lists under "Document JavaScripts" — as TEXT IN, TEXT OUT. It NEVER
EXECUTES that JavaScript: no eval, no JS engine, no sandbox. Running document
JS is a security surface we deliberately do not build (DECISIONS #33, roadmap
§ I "AcroJS never executing (security) — LEGIT"). So this module only reads and
rewrites the `/Root /Names /JavaScript` name tree; the scripts run in no
process of ours.

Scope: the document-level name tree only. Per-field and page /AA additional
actions and /OpenAction are separate action sites (named in § I F11) — a later
extension, not this slice.
"""

import os
import tempfile
from pathlib import Path

import pikepdf

# The PDF text-string UTF-16BE byte-order mark. `/JS` is a "text string or
# stream" (PDF 32000 §12.6.4.16): PDFDocEncoding, or UTF-16 with a BOM. We WRITE
# UTF-16BE+BOM so any Unicode in a script round-trips and Acrobat reads it.
_BOM_BE = b"\xfe\xff"
_BOM_LE = b"\xff\xfe"


def _decode_js(action) -> str | None:
    """The JavaScript text of a `/JavaScript` action, or None if it carries no
    `/JS`. `/JS` may be a PDF String (pikepdf decodes the text-string encoding
    for us) or a Stream (raw bytes we decode by BOM, else PDFDocEncoding)."""
    js = action.get("/JS")
    if js is None:
        return None
    if isinstance(js, pikepdf.String):
        # pikepdf applies the text-string rules (UTF-16 BOM detection).
        return str(js)
    if isinstance(js, pikepdf.Stream):
        raw = bytes(js.read_bytes())
        if raw.startswith(_BOM_BE):
            return raw[2:].decode("utf-16-be", "replace")
        if raw.startswith(_BOM_LE):
            return raw[2:].decode("utf-16-le", "replace")
        # No BOM. Try strict UTF-8 first: some third-party producers write /JS
        # as UTF-8 without a BOM, and genuine PDFDocEncoding text carrying a
        # non-ASCII byte essentially never ALSO decodes as valid multi-byte
        # UTF-8 — so this recovers that common interop case without mangling the
        # spec case (round-42 gauntlet). Fall back to PDFDocEncoding, then a
        # permissive Latin-1.
        try:
            return raw.decode("utf-8")
        except UnicodeDecodeError:
            pass
        try:
            return raw.decode("pdfdoc")  # type: ignore[arg-type]
        except (LookupError, UnicodeDecodeError):
            return raw.decode("latin-1", "replace")
    # A Name or other atypical value — surface its text rather than dropping it.
    return str(js)


def list_document_js(file: str) -> dict:
    """Every named document-level JavaScript in the PDF (READ-ONLY).

    Returns ``{"scripts": [{"name", "js"}], "count"}`` sorted by name (the
    name-tree order). Empty when the document carries none. Never executes a
    thing.

    Args:
        file: PDF path.
    """
    scripts: list[dict] = []
    with pikepdf.open(file) as pdf:
        names = pdf.Root.get("/Names")
        tree = names.get("/JavaScript") if isinstance(names, pikepdf.Dictionary) else None
        # A hostile/corrupt file can carry `/Names << /JavaScript 42 >>` (any
        # scalar), which pikepdf auto-unwraps to a native int/bool/Decimal and
        # `NameTree(...)` then rejects with a TypeError. Treat a non-dict tree
        # as "no scripts" instead of surfacing a raw exception (round-42
        # gauntlet) — matching how a non-dict /Names and a non-dict action are
        # already skipped.
        if isinstance(tree, pikepdf.Dictionary):
            for name, action in pikepdf.NameTree(tree).items():
                if not isinstance(action, pikepdf.Dictionary):
                    continue
                js = _decode_js(action)
                if js is not None:
                    scripts.append({"name": str(name), "js": js})
    scripts.sort(key=lambda s: s["name"])
    return {"scripts": scripts, "count": len(scripts)}


def set_document_js(file: str, output: str, scripts: list | None = None) -> dict:
    """Replace the document-level JavaScript set with `scripts` and write to
    `output`.

    `scripts` is a list of ``{"name", "js"}``; names must be non-empty and
    unique. An empty/omitted list REMOVES the `/JavaScript` name tree (leaving
    any other `/Names` entries — /Dests, /EmbeddedFiles — untouched). The JS is
    stored as a UTF-16BE (BOM) stream, so arbitrary Unicode survives. The text
    is NEVER parsed or executed — a syntactically broken script saves as-is,
    exactly as the industry editor stores it (it validates at run time, which
    is not us).

    Args:
        file: Input PDF path.
        output: Output PDF path.
        scripts: List of ``{"name", "js"}`` document scripts.
    """
    seen: set[str] = set()
    cleaned: list[tuple[str, str]] = []
    for entry in scripts or []:
        if not isinstance(entry, dict):
            raise ValueError("Each document script must be an object with name and js.")
        name = str(entry.get("name", "")).strip()
        if not name:
            raise ValueError("Each document script needs a non-empty name.")
        if name in seen:
            raise ValueError(f"Duplicate document-script name: {name!r}.")
        seen.add(name)
        cleaned.append((name, str(entry.get("js", ""))))

    # In-place (output == input) is the normal case here: the renderer routes
    # through the undoable workspace flow, which passes the working copy as both
    # file and output. pikepdf refuses to save over the file it opened, so save
    # to a temp beside the target and atomically replace — never a half-written
    # working copy (mirrors redact.py).
    same_file = Path(file).resolve() == Path(output).resolve()
    tmp_path: str | None = None
    with pikepdf.open(file) as pdf:
        names = pdf.Root.get("/Names")
        if not cleaned:
            if isinstance(names, pikepdf.Dictionary) and "/JavaScript" in names:
                del names["/JavaScript"]
                # Drop a now-empty /Names so we don't leave a dangling dict.
                if len(names.keys()) == 0:
                    del pdf.Root["/Names"]
        else:
            if not isinstance(names, pikepdf.Dictionary):
                names = pikepdf.Dictionary()
                pdf.Root.Names = names
            tree = pdf.make_indirect(pikepdf.Dictionary(Names=pikepdf.Array()))
            name_tree = pikepdf.NameTree(tree)  # keeps the tree sorted on write
            for name, js in cleaned:
                stream = pdf.make_stream(_BOM_BE + js.encode("utf-16-be"))
                action = pdf.make_indirect(
                    pikepdf.Dictionary(S=pikepdf.Name("/JavaScript"), JS=stream)
                )
                name_tree[name] = action
            names["/JavaScript"] = tree
        if same_file:
            fd, tmp_path = tempfile.mkstemp(suffix=".pdf", dir=str(Path(output).parent))
            os.close(fd)
            pdf.save(tmp_path)
        else:
            pdf.save(output)
    if same_file and tmp_path is not None:
        try:
            os.replace(tmp_path, output)
        except BaseException:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
            raise

    return {"output": output, "count": len(cleaned)}
