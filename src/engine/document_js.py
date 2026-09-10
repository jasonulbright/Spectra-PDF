"""Document-level JavaScript: read and EDIT the catalog's /Names /JavaScript
name tree ("AcroJS editor").

This module handles document-level JavaScript as TEXT IN, TEXT OUT: it reads
and rewrites the `/Root /Names /JavaScript` name tree and nothing else. No
eval, no JavaScript engine, no sandbox runs in this process — a script reaching
the engine is bytes, whatever it says.

Execution, where it happens at all, is the renderer's and is off by default
(`docs/architecture/98-f26-field-js.md`). The listing here is the read that
feeds it; this module gains no interpreter from that and must not acquire one,
because the CLI, the guided actions and the batch arms all run through here.

Scope: the document-level name tree only. Per-field and page /AA additional
actions and /OpenAction are separate action sites — a later extension,
not this module's scope.
"""

from pathlib import Path

import pikepdf
from engine.inplace import is_same_file, staged_write
from engine.pdf_save import save_pdf

# The PDF text-string UTF-16BE byte-order mark. `/JS` is a "text string or
# stream" (ISO 32000-2 12.6.4.17): PDFDocEncoding, or UTF-16 with a BOM. We WRITE
# UTF-16BE+BOM so Unicode scripts round-trip and conforming readers decode them.
_BOM_BE = b"\xfe\xff"
_BOM_LE = b"\xff\xfe"


def decode_js(action) -> str | None:
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
        # UTF-8, recovering that common interop case without mangling the
        # specified encoding. Fall back to PDFDocEncoding, then a
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


class _IncompleteScripts(Exception):
    """A partial or lossy read cannot authorize replacing a name tree."""


def _strict_text(raw: bytes) -> str:
    if raw.startswith(_BOM_BE):
        return raw[2:].decode("utf-16-be", "strict")
    if raw.startswith(_BOM_LE):
        return raw[2:].decode("utf-16-le", "strict")
    if raw.startswith(b"\xef\xbb\xbf"):
        return raw[3:].decode("utf-8", "strict")
    # Retain the existing BOM-less UTF-8 interoperability path, but never
    # turn an undecodable byte into a replacement character in editable text.
    try:
        return raw.decode("utf-8", "strict")
    except UnicodeDecodeError:
        text = str(pikepdf.String(raw))
        if "\ufffd" in text:
            raise _IncompleteScripts
        return text


def _editable_scripts(pdf) -> list[dict]:
    """Complete name-tree/action read (ISO 32000-2 7.9.6, 12.6.4.17).

    Do not use NameTree's repair/skip behavior for a full-replacement editor.
    Compare name keys and Limits as bytes; independently refuse decoded-name
    collisions and opaque action entries this text-only editor cannot carry.
    Node/text limits are editable-model limits, not a bounded codec decoder.
    """
    if "/Names" not in pdf.Root:
        return []
    names = pdf.Root.Names
    if not isinstance(names, pikepdf.Dictionary):
        raise _IncompleteScripts
    if "/JavaScript" not in names:
        return []
    scripts, keys, decoded, visited = [], [], set(), set()
    nodes, size = 0, 0

    def walk(node, depth=0):
        nonlocal nodes, size
        nodes += 1
        if nodes > 10000 or depth > 64 or not isinstance(node, pikepdf.Dictionary):
            raise _IncompleteScripts
        if node.objgen != (0, 0):
            if node.objgen in visited:
                raise _IncompleteScripts
            visited.add(node.objgen)
        entries, kids = node.get("/Names"), node.get("/Kids")
        if (entries is None) == (kids is None) or set(node.keys()) - {"/Names", "/Kids", "/Limits"}:
            raise _IncompleteScripts
        first = len(keys)
        if entries is not None:
            if not isinstance(entries, pikepdf.Array) or len(entries) % 2 or len(entries) > 20000:
                raise _IncompleteScripts
            for i in range(0, len(entries), 2):
                key, action = entries[i], entries[i + 1]
                if not isinstance(key, pikepdf.String):
                    raise _IncompleteScripts
                raw = bytes(key)
                # Keys are byte strings, not script text: decode exactly as a
                # PDF string, after checking any Unicode encoding for loss.
                if raw.startswith((_BOM_BE, _BOM_LE, b"\xef\xbb\xbf")):
                    name = _strict_text(raw)
                else:
                    name = str(key)
                    if "\ufffd" in name:
                        raise _IncompleteScripts
                if (keys and raw <= keys[-1] or name in decoded or not name.strip()
                        or len(name) > 10000 or len(scripts) >= 10000
                        or not isinstance(action, pikepdf.Dictionary)
                        or set(action.keys()) - {"/Type", "/S", "/JS"}
                        or action.get("/Type", pikepdf.Name.Action) != pikepdf.Name.Action
                        or action.get("/S") != pikepdf.Name.JavaScript):
                    raise _IncompleteScripts
                js = action.get("/JS")
                if isinstance(js, pikepdf.Stream):
                    text = _strict_text(bytes(js.read_bytes()))
                elif isinstance(js, pikepdf.String):
                    data = bytes(js)
                    if data.startswith((_BOM_BE, _BOM_LE, b"\xef\xbb\xbf")):
                        text = _strict_text(data)
                    else:
                        text = str(js)
                        if "\ufffd" in text:
                            raise _IncompleteScripts
                else:
                    raise _IncompleteScripts
                size += len(name.encode('utf-16-be')) + len(text.encode('utf-16-be')) + 2
                if size > 2000000:
                    raise _IncompleteScripts
                decoded.add(name); keys.append(raw)
                scripts.append({"name": name, "js": text})
        else:
            if not isinstance(kids, pikepdf.Array) or not kids:
                raise _IncompleteScripts
            for kid in kids:
                if not isinstance(kid, pikepdf.Dictionary) or kid.objgen == (0, 0):
                    raise _IncompleteScripts
                walk(kid, depth + 1)
        limits = node.get("/Limits")
        if depth == 0:
            if limits is not None:
                raise _IncompleteScripts
        elif (not isinstance(limits, pikepdf.Array) or len(limits) != 2
              or not all(isinstance(k, pikepdf.String) for k in limits)
              or first == len(keys) or [bytes(k) for k in limits] != [keys[first], keys[-1]]):
            raise _IncompleteScripts
    walk(names.JavaScript)
    return sorted(scripts, key=lambda s: s['name'])


def list_document_js(file: str, for_edit: bool = False) -> dict:
    """Every named document-level JavaScript in the PDF (READ-ONLY).

    Returns ``{"scripts": [{"name", "js"}], "count"}`` sorted by name (the
    name-tree order). Empty when the document carries none. Never executes a
    thing.

    Args:
        file: PDF path.
    """
    scripts: list[dict] = []
    with pikepdf.open(file) as pdf:
        if for_edit:
            try:
                scripts = _editable_scripts(pdf)
                return {"scripts": scripts, "count": len(scripts), "complete": True}
            except (pikepdf.PdfError, TypeError, ValueError, AttributeError, _IncompleteScripts):
                return {"scripts": [], "count": 0, "complete": False}
        names = pdf.Root.get("/Names")
        tree = names.get("/JavaScript") if isinstance(names, pikepdf.Dictionary) else None
        # A hostile/corrupt file can carry `/Names << /JavaScript 42 >>` (any
        # scalar), which pikepdf auto-unwraps to a native int/bool/Decimal and
        # `NameTree(...)` then rejects with a TypeError. Treat a non-dict tree
        # as "no scripts" instead of surfacing a raw exception, matching how a
        # non-dict /Names and a non-dict action are
        # already skipped.
        if isinstance(tree, pikepdf.Dictionary):
            for name, action in pikepdf.NameTree(tree).items():
                if not isinstance(action, pikepdf.Dictionary):
                    continue
                js = decode_js(action)
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
    is never parsed or executed, so a syntactically broken script saves as-is.

    Args:
        file: Input PDF path.
        output: Output PDF path.
        scripts: List of ``{"name", "js"}`` document scripts.
    """
    seen: set[str] = set()
    cleaned: list[tuple[str, str]] = []
    if scripts is not None and not isinstance(scripts, list):
        raise ValueError("Each document script must be an object with name and js.")
    size = 0
    for entry in scripts or []:
        if (not isinstance(entry, dict) or not isinstance(entry.get("name"), str)
                or not isinstance(entry.get("js", ""), str)):
            raise ValueError("Each document script must be an object with name and js.")
        name = entry["name"]
        if not name.strip():
            raise ValueError("Each document script needs a non-empty name.")
        if name in seen:
            raise ValueError(f"Duplicate document-script name: {name!r}.")
        seen.add(name)
        js = entry.get("js", "")
        size += len(name.encode('utf-16-be')) + len(js.encode('utf-16-be')) + 2
        if len(name) > 10000 or len(cleaned) >= 10000 or size > 2000000:
            raise ValueError("Document scripts exceed editing limits.")
        cleaned.append((name, js))

    # In-place (output == input) is the normal case here: the renderer routes
    # through the undoable workspace flow, which passes the working copy as both
    # file and output. pikepdf refuses to save over the file it opened, so the
    # write stages beside the target and lands by swapping the directory entry.
    # The scope owns the span: a save that dies takes the staged file with it
    # rather than leaving it beside the user's document.
    same_file = is_same_file(file, output)
    output_path = Path(output)
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
            with staged_write(output_path) as staged:
                save_pdf(pdf, str(staged))
                pdf.close()
        else:
            save_pdf(pdf, output)

    return {"output": output, "count": len(cleaned)}
