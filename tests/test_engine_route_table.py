"""The Rust process table against the engine's own handlers.

`src-tauri/src/engine.rs` names, per engine method, the process that serves
it (`METHOD_CLASSES`): the window process, the window's job process, a run
process per call, or the health worker. A method the table does not name runs
in the window process, so a new long method would land there by omission.
This test reads every ``server.register`` call in ``engine/__main__.py``,
resolves each handler's signature with ``ast``, and fails when:

  * a registered method has no row, or a row names an unregistered method;
  * methods that share per-process state are split across processes;
  * an in-place credential method is routed away from the window process;
  * the health class is anything but the health methods;
  * a run method takes a path parameter that `RUN_PATH_PARAMS` does not list,
    so its process would not be given that working copy's credential.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENGINE = ROOT / "src" / "engine"
TABLE = ROOT / "src-tauri" / "src" / "engine.rs"

ROW = re.compile(r'^    \("(\w+)", ProcessClass::(Window|Job|Run|Health)\),$')
NAME = re.compile(r'^    "(\w+)",$')

#: Methods that read or write state another method of the group left in the
#: process: a split plan, a remote-signing session, a preview folder, the
#: plate folder of a separation render.
AFFINITY_GROUPS = (
    ("split_plan", "split"),
    ("list_csc_credentials", "sign_pdf"),
    ("print_preview", "print_preview_cleanup"),
    ("render_separations", "composite_separations", "inspect_point"),
)

#: They rewrite the working copy in place, so they run in one process only.
WINDOW_ONLY = ("open_document", "open_document_attempt", "open_pubkey_document", "unlock")

#: Parameters that name a path the run process only reads as a tool or
#: resource, never a working copy.
TOOL_PATHS = frozenset({
    "gs_path", "tesseract_path", "soffice_path", "jbig2_path", "font_dir",
    "icc_dir", "dictionary_dir",
})
PATH_NAMES = frozenset({
    "file", "files", "path", "paths", "output", "outputs", "source", "sources",
    "dest", "dir", "directory", "root", "inputs", "protected",
})
PATH_SUFFIXES = ("_path", "_paths", "_dir", "_root", "_prefix")


def _block(start: str) -> list[str]:
    source = TABLE.read_text(encoding="utf-8")
    begin = source.index(start)
    end = source.index("\n];", begin)
    return source[begin:end].splitlines()[1:]


def _table() -> dict[str, str]:
    rows: dict[str, str] = {}
    for line in _block("pub(crate) const METHOD_CLASSES"):
        match = ROW.match(line)
        assert match, f"unparsable process-table row: {line!r}"
        method, process = match.groups()
        assert method not in rows, f"duplicate process-table row: {method}"
        rows[method] = process
    return rows


def _run_path_params() -> set[str]:
    names = set()
    for line in _block("pub(crate) const RUN_PATH_PARAMS"):
        match = NAME.match(line)
        assert match, f"unparsable run path parameter: {line!r}"
        names.add(match.group(1))
    return names


def _parse(module: str) -> ast.Module:
    return ast.parse((ENGINE / f"{module}.py").read_text(encoding="utf-8"))


def _imported(tree: ast.Module) -> dict:
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


def _handlers() -> dict[str, list[str]]:
    """``method -> parameter names`` of every registered handler."""
    tree = _parse("__main__")
    imported = _imported(tree)
    local = {n.name for n in tree.body if isinstance(n, ast.FunctionDef)}
    out: dict[str, list[str]] = {}
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
            assert method not in out, f"method registered twice: {method}"
            out[method] = [a.arg for a in args.posonlyargs + args.args + args.kwonlyargs]
    return out


def test_every_registered_method_has_a_process_and_every_row_is_registered():
    handlers = _handlers()
    rows = _table()
    assert len(handlers) > 200, "registration walk stopped resolving"
    assert sorted(set(handlers) - set(rows)) == [], "registered methods without a process row"
    assert sorted(set(rows) - set(handlers)) == [], "process rows naming no registered method"


def test_methods_that_share_process_state_share_a_process():
    rows = _table()
    for group in AFFINITY_GROUPS:
        processes = {rows[method] for method in group}
        assert len(processes) == 1, f"{group} split across {sorted(processes)}"


def test_in_place_credential_methods_run_only_in_the_window_process():
    rows = _table()
    for method in WINDOW_ONLY:
        assert rows[method] == "Window", method


def test_the_health_class_is_the_health_methods():
    rows = _table()
    health = sorted(m for m, process in rows.items() if process == "Health")
    assert health == sorted(m for m in rows if m.startswith("document_health"))


def test_every_working_copy_path_of_a_run_method_is_a_run_path_parameter():
    rows = _table()
    handlers = _handlers()
    named = _run_path_params()
    runs = [m for m, process in rows.items() if process == "Run"]
    assert runs, "no run methods"
    taken = set()
    missing = []
    for method in runs:
        for name in handlers[method]:
            if name in TOOL_PATHS:
                continue
            if name in PATH_NAMES or name.endswith(PATH_SUFFIXES):
                taken.add(name)
                if name not in named:
                    missing.append(f"{method}.{name}")
    assert missing == [], "run path parameters whose credential no run process is given"
    assert sorted(named - taken) == [], "run path parameters no run method takes"
