"""The renderer's engine lock table against the engine's own handlers.

`src/renderer/lib/engine-lock.ts` holds, per engine method, every path
parameter and the lock mode the renderer takes on it. A method or a path
parameter missing from that table is locked by nothing, so two calls that
write one path can interleave. This test reads every ``server.register``
call in ``engine/__main__.py``, resolves the handler through the module
imports (following re-exports), reads its signature with ``ast``, and fails
when:

  * a registered method has no row, or a row names an unregistered method;
  * a row names a parameter the handler does not take;
  * a row is exclusive only ``in_place`` and the handler takes no ``in_place``;
  * a handler takes a path-shaped parameter that is neither a key of its row
    nor declared below as a parameter no lock covers.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENGINE = ROOT / "src" / "engine"
TABLE = ROOT / "src" / "renderer" / "lib" / "engine-lock.ts"

#: Parameters that name a file or folder but take no renderer lock: bundled
#: or installed tools and resources the engine only reads (Ghostscript,
#: Tesseract, LibreOffice, jbig2enc, fonts, ICC profiles, dictionaries, trust
#: stores, PKCS#11 modules, CA bundles), the dictionary files an import reads,
#: the certificates an encryption reads, a structure-tree path, and base64
#: bytes.
UNLOCKED = frozenset({
    "gs_path",
    "tesseract_path",
    "soffice_path",
    "jbig2_path",
    "font_dir",
    "icc_dir",
    "dictionary_dir",
    "trust_roots",
    "pkcs11_module",
    "csc_ca_bundle",
    "aff",
    "dic",
    "certs",
    "parent_path",
    "data",
})

#: Parameter names that hold a path, beyond the suffix rule below.
PATH_NAMES = frozenset({
    "file", "files", "path", "paths", "output", "outputs", "source", "sources",
    "dest", "dir", "directory", "root", "original", "modified", "image", "xfdf",
    "pfx", "protected", "inputs", "file_a", "file_b", "pdf_source", "certs",
    "aff", "dic", "trust_roots", "pkcs11_module", "csc_ca_bundle", "data",
})
PATH_SUFFIXES = ("_path", "_paths", "_dir", "_root", "_prefix")

ROW = re.compile(r"^  (\w+): \{([^}]*)\},$")
CELL = re.compile(r"^(\w+): '(S|X|X:in_place)'$")


def _table() -> dict:
    source = TABLE.read_text(encoding="utf-8")
    start = source.index("export const ENGINE_LOCK_TABLE")
    end = source.index("\n};", start)
    rows = {}
    for line in source[start:end].splitlines()[1:]:
        match = ROW.match(line)
        assert match, f"unparsable lock-table row: {line!r}"
        method, body = match.groups()
        assert method not in rows, f"duplicate lock-table row: {method}"
        cells = {}
        for cell in filter(None, (c.strip() for c in body.split(","))):
            parsed = CELL.match(cell)
            assert parsed, f"unparsable cell in {method}: {cell!r}"
            cells[parsed.group(1)] = parsed.group(2)
        rows[method] = cells
    return rows


def _parse(module: str) -> ast.Module:
    return ast.parse((ENGINE / f"{module}.py").read_text(encoding="utf-8"))


def _imported(tree: ast.Module) -> dict:
    """``name -> (module, attribute)`` for names imported from the engine."""
    out = {}
    for node in tree.body:
        if isinstance(node, ast.ImportFrom) and node.module is not None:
            module = node.module
            if node.level:
                module = "engine." + module
            if module.startswith("engine."):
                for alias in node.names:
                    out[alias.asname or alias.name] = (module[len("engine."):], alias.name)
    return out


def _function(module: str, name: str, seen: frozenset = frozenset()):
    assert (module, name) not in seen, f"import cycle resolving {module}.{name}"
    tree = _parse(module)
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name:
            return node
    target = _imported(tree).get(name)
    assert target, f"engine.{module} defines no function {name}"
    return _function(*target, seen | {(module, name)})


def _handlers() -> dict:
    """``method -> (parameter names, takes **kwargs)``."""
    tree = _parse("__main__")
    imported = _imported(tree)
    local = {n.name for n in tree.body if isinstance(n, ast.FunctionDef)}
    out = {}
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "register"
        ):
            method = node.args[0].value
            name = node.args[1].id
            fn = _function("__main__", name) if name in local else _function(*imported[name])
            args = fn.args
            params = [a.arg for a in args.posonlyargs + args.args + args.kwonlyargs]
            assert method not in out, f"method registered twice: {method}"
            out[method] = (params, args.kwarg is not None)
    return out


def _path_shaped(name: str) -> bool:
    return name in PATH_NAMES or name.endswith(PATH_SUFFIXES)


def test_every_registered_method_has_a_row_and_every_row_is_registered():
    handlers = _handlers()
    rows = _table()
    assert len(handlers) > 200, "registration walk stopped resolving"
    assert sorted(set(handlers) - set(rows)) == [], "registered methods without a lock row"
    assert sorted(set(rows) - set(handlers)) == [], "lock rows naming no registered method"


def test_every_row_key_is_a_parameter_of_its_handler():
    handlers = _handlers()
    for method, cells in _table().items():
        params, kwargs = handlers[method]
        for key in cells:
            assert key in params or kwargs, f"{method}: lock key {key} is not a parameter"


def test_in_place_rows_take_in_place():
    handlers = _handlers()
    conditional = {m for m, cells in _table().items() if "X:in_place" in cells.values()}
    assert conditional == {"batch_ocr", "run_action", "run_preflight_sweep"}
    for method in conditional:
        assert "in_place" in handlers[method][0], method


def test_every_path_parameter_has_a_mode_or_is_declared_unlocked():
    rows = _table()
    missing = []
    for method, (params, _) in _handlers().items():
        for name in params:
            if _path_shaped(name) and name not in rows[method] and name not in UNLOCKED:
                missing.append(f"{method}.{name}")
    assert missing == [], "path parameters with no lock mode"


def test_in_place_writers_are_exclusive_on_the_key_they_rewrite():
    rows = _table()
    assert rows["open_document"] == {"path": "X"}
    assert rows["open_document_attempt"] == {"path": "X"}
    assert rows["open_pubkey_document"]["path"] == "X"
    assert rows["unlock"] == {"file": "X"}
    assert rows["print_preview"]["cleanup_dir"] == "X"
    assert rows["print_preview_cleanup"] == {"directory": "X"}
    assert rows["extract_page_image"]["output_prefix"] == "X"
    assert rows["add_user_dictionary"] == {"user_dictionary_dir": "X"}
    assert rows["transplant_incremental"]["modified"] == "X"
