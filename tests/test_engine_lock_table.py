"""The renderer's engine lock table against the engine's own handlers.

`src/renderer/lib/engine-lock.ts` holds, per engine method, every path
parameter and the lock mode the renderer takes on it. A method or a path
parameter missing from that table is locked by nothing, so two calls that
write one path can interleave; a writer locked shared runs beside readers of
the path it replaces. This test reads every ``server.register`` call in
``engine/__main__.py``, resolves the handler through the module imports
(following re-exports), and fails when:

  * a registered method has no row, or a row names an unregistered method;
  * a row names a parameter the handler does not take;
  * a conditional row names a condition the handler does not take;
  * a handler takes a path-shaped parameter that is neither a key of its row
    nor declared below as a parameter no lock covers;
  * a parameter the handler writes, moves or deletes is locked shared, or a
    parameter it only reads is locked exclusive, unless a reason below says
    why the analysis and the row disagree.

The write analysis follows each parameter through assignments, loops, ``with``
targets, container updates, return values and calls into other engine
functions, to a call that writes, creates, moves or deletes a path: ``open``
for writing, ``os.replace``/``rename``/``remove``/``unlink``/``mkdir``/
``rmdir``, ``shutil`` copies, moves and ``rmtree``, ``Path`` writes,
``unlink``, ``rename`` and ``replace``, ``.save(path)``, ``extract_to`` and a
temporary file created inside a folder. Through those calls it reaches
``staged_write``, ``finish_staged``, ``publish_copy`` and every other engine
helper. ``.parent``, ``.name``, ``.stem``, ``dirname``, ``basename``, hashes
and ``tempfile`` names derive a different path, so a write beside a file or
into a fresh temporary folder is not a write of that file.
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
#: the certificates an encryption reads, and base64 bytes.
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
    "data",
})

#: Parameters with a path-shaped name that hold no path in this handler.
NOT_PATHS = {
    ("alias_ink", "source"): "a colorant name",
    ("check_spelling", "sources"): "the kinds of text to check",
    ("list_source_folders", "sources"): "the kind of files to collect",
    ("create_pdf_folders", "sources"): "the kind of files to collect",
    ("set_struct_props", "path"): "a structure-tree index list",
    ("set_table_headers", "path"): "a structure-tree index list",
    ("move_struct_node", "path"): "a structure-tree index list",
    ("delete_struct_node", "path"): "a structure-tree index list",
    ("add_struct_node", "parent_path"): "a structure-tree index list",
}

#: Exclusive only under the stated options: the row must carry exactly this
#: condition.
CONDITIONAL = {
    ("batch_ocr", "source"): (
        "in_place|moved_root|error_root|remove_empty_folders|replace_repaired_originals",
        "replaces originals in place, moves them to the moved or error folder, "
        "replaces repaired originals, or deletes emptied folders of the source tree",
    ),
    ("run_action", "source"): (
        "in_place|move_processed_root",
        "replaces originals in place or moves processed originals out of the source tree",
    ),
    ("run_preflight_sweep", "source"): (
        "in_place|move_processed_root",
        "replaces originals in place or moves processed originals out of the source tree",
    ),
    ("emit_trapping_setup", "file"): (
        "!output",
        "rewrites the PostScript file in place when no output is given",
    ),
}

#: Shared although the analysis reports a write: the analysis merges values
#: the handler keeps apart.
SHARED_DESPITE_WRITE = {
    ("create_pdf_folders", "source"): (
        "each output is written under dest at a name taken from the source "
        "listing; the sources are only read"
    ),
    ("outline_from_structure", "file"): (
        "autotag writes a private copy; the variable that names it names "
        "file only on the branch that reads it"
    ),
    ("replace_paragraph_text", "font_path"): (
        "the deleted face is a private extract of the document's own font; "
        "font_path is only read"
    ),
    ("split", "file"): (
        "the planned parts carry the source's page data beside the output "
        "paths; only the output folder and outputs are written"
    ),
}

#: Exclusive although the analysis reports no write.
EXCLUSIVE_WITHOUT_WRITE: dict = {}

PATH_NAMES = frozenset({
    "file", "files", "path", "paths", "output", "outputs", "source", "sources",
    "dest", "dir", "directory", "root", "original", "modified", "image", "xfdf",
    "pfx", "protected", "inputs", "file_a", "file_b", "pdf_source", "certs",
    "aff", "dic", "trust_roots", "pkcs11_module", "csc_ca_bundle", "data",
})
PATH_SUFFIXES = ("_path", "_paths", "_dir", "_root", "_prefix")

ROW = re.compile(r"^  (\w+): \{([^}]*)\},$")
CELL = re.compile(r"^(\w+): '(S|X|X:!?\w+(?:\|!?\w+)*)'$")


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


_trees: dict = {}


def _parse(module: str) -> ast.Module | None:
    if module not in _trees:
        path = ENGINE / f"{module}.py"
        _trees[module] = ast.parse(path.read_text(encoding="utf-8")) if path.is_file() else None
    return _trees[module]


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


def _registered() -> dict:
    """``method -> (module, handler function node)``."""
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
            assert method not in out, f"method registered twice: {method}"
            if name in local:
                out[method] = ("__main__", _function("__main__", name))
            else:
                module, attribute = imported[name]
                out[method] = (_defining_module(module, attribute), _function(module, attribute))
    return out


def _defining_module(module: str, name: str) -> str:
    tree = _parse(module)
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name:
            return module
    return _defining_module(*_imported(tree)[name])


def _handlers() -> dict:
    """``method -> (parameter names, takes **kwargs)``."""
    out = {}
    for method, (_, fn) in _registered().items():
        args = fn.args
        params = [a.arg for a in args.posonlyargs + args.args + args.kwonlyargs]
        out[method] = (params, args.kwarg is not None)
    return out


def _path_shaped(name: str) -> bool:
    return name in PATH_NAMES or name.endswith(PATH_SUFFIXES)


# ── write analysis ────────────────────────────────────────────────────────


def _module_imports(module: str) -> dict:
    """``name -> ("fn", module, attribute) | ("mod", module)``, any depth."""
    out = {}
    tree = _parse(module)
    if tree is None:
        return out
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            source = node.module or ""
            if node.level:
                source = "engine." + source if source else "engine"
            if source == "engine":
                for alias in node.names:
                    out[alias.asname or alias.name] = ("mod", alias.name)
            elif source.startswith("engine."):
                for alias in node.names:
                    out[alias.asname or alias.name] = ("fn", source[len("engine."):], alias.name)
        elif isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name.startswith("engine.") and alias.asname:
                    out[alias.asname] = ("mod", alias.name[len("engine."):])
    return out


_import_cache: dict = {}


def _imports_of(module: str) -> dict:
    if module not in _import_cache:
        _import_cache[module] = _module_imports(module)
    return _import_cache[module]


def _top_function(module: str, name: str, seen: frozenset = frozenset()):
    tree = _parse(module)
    if tree is None or (module, name) in seen:
        return None
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name:
            return module, node
    target = _imports_of(module).get(name)
    if target and target[0] == "fn":
        return _top_function(target[1], target[2], seen | {(module, name)})
    return None


def _dotted(expr) -> str | None:
    parts = []
    while isinstance(expr, ast.Attribute):
        parts.append(expr.attr)
        expr = expr.value
    if isinstance(expr, ast.Name):
        parts.append(expr.id)
        return ".".join(reversed(parts))
    return None


_CUT_ATTRIBUTES = {"parent", "parents", "name", "stem", "suffix", "suffixes"}
_CUT_CALLS = {
    "os.path.dirname", "os.path.basename", "os.path.splitext", "os.path.exists",
    "os.path.isfile", "os.path.isdir", "os.path.getsize", "os.path.samefile",
    "os.path.islink", "os.path.getmtime", "len", "bool", "int", "float", "isinstance",
    "hash", "id", "type",
}
_CUT_PREFIXES = ("tempfile.", "hashlib.")
_CUT_METHODS = {
    "exists", "is_file", "is_dir", "stat", "lstat", "samefile", "read_bytes", "read_text",
    "is_symlink", "startswith", "endswith", "count", "index", "find", "hexdigest", "digest",
}
_MUTATORS = {"append", "extend", "add", "insert", "update", "setdefault", "appendleft"}
_WRITE_MODE = set("wax+")


def _base_name(target) -> str | None:
    while isinstance(target, (ast.Subscript, ast.Attribute, ast.Starred)):
        target = target.value
    return target.id if isinstance(target, ast.Name) else None


def _target_names(target) -> set:
    if isinstance(target, (ast.Tuple, ast.List)):
        out = set()
        for element in target.elts:
            out |= _target_names(element)
        return out
    name = _base_name(target)
    return {name} if name else set()


def _writes_mode(expr, default: str = "r") -> bool:
    if expr is None:
        mode = default
    elif isinstance(expr, ast.Constant) and isinstance(expr.value, str):
        mode = expr.value
    else:
        return True
    return bool(_WRITE_MODE & set(mode))


def _sink_arguments(call: ast.Call) -> list:
    """The expressions naming a path the call writes, creates, moves or deletes."""
    func, args = call.func, call.args
    keywords = {k.arg: k.value for k in call.keywords if k.arg}
    dotted = _dotted(func)
    if dotted in ("open", "io.open", "zipfile.ZipFile"):
        mode = args[1] if len(args) > 1 else keywords.get("mode")
        return args[:1] if _writes_mode(mode) else []
    if dotted in ("os.replace", "os.rename", "os.renames", "shutil.move"):
        return args[:2]
    if dotted in ("os.remove", "os.unlink", "os.rmdir", "os.removedirs", "os.mkdir",
                  "os.makedirs", "os.truncate", "os.open", "shutil.rmtree"):
        return args[:1]
    if dotted in ("shutil.copy", "shutil.copy2", "shutil.copyfile", "shutil.copytree",
                  "os.link", "os.symlink"):
        return args[1:2] + ([keywords["dst"]] if "dst" in keywords else [])
    if dotted and dotted.startswith("tempfile.") and "dir" in keywords:
        return [keywords["dir"]]
    if isinstance(func, ast.Attribute):
        attribute = func.attr
        if attribute in ("write_bytes", "write_text", "unlink", "rmdir", "mkdir", "touch", "chmod"):
            return [func.value]
        if attribute in ("rename", "replace") and len(args) == 1 and not call.keywords:
            return [func.value, args[0]]
        if attribute == "open" and (args or "mode" in keywords):
            return [func.value] if _writes_mode(args[0] if args else keywords["mode"]) else []
        if attribute == "save" and args:
            return args[:1]
        if attribute == "extract_to":
            return [keywords[k] for k in ("fileprefix", "stream") if k in keywords] + args[:1]
    return []


def _signature(fn) -> tuple:
    a = fn.args
    positional = [x.arg for x in a.posonlyargs + a.args]
    keyword_only = [x.arg for x in a.kwonlyargs]
    return positional, keyword_only, (a.vararg.arg if a.vararg else None), (a.kwarg.arg if a.kwarg else None)


def _all_parameters(fn) -> list:
    positional, keyword_only, vararg, kwarg = _signature(fn)
    return positional + keyword_only + [x for x in (vararg, kwarg) if x]


class _Summary:
    """Which parameters a function writes and which its result carries."""

    def __init__(self):
        self.written: set = set()
        self.returns: set = set()
        self.elements: list | None = None

    def key(self):
        return (frozenset(self.written), frozenset(self.returns),
                None if self.elements is None else tuple(frozenset(e) for e in self.elements))


class _Analysis:
    """Summaries to a fixpoint: a recursive call reads the previous round's
    summary of the function it re-enters."""

    def __init__(self):
        self.previous: dict = {}
        self.current: dict = {}

    def summary(self, module: str, fn, stack: tuple = ()) -> _Summary:
        key = (module, fn.name, fn.lineno)
        if key in self.current:
            return self.current[key]
        if key in stack:
            return self.previous.get(key, _Summary())
        summary = _Summary()
        _Function(self, module, fn, stack + (key,)).run(summary)
        self.current[key] = summary
        return summary

    def written(self, registered: dict) -> dict:
        for _ in range(20):
            self.current = {}
            for method in sorted(registered):
                self.summary(*registered[method])
            stable = {k: v.key() for k, v in self.current.items()} == {
                k: v.key() for k, v in self.previous.items()
            }
            self.previous = self.current
            if stable:
                return {m: self.current[(mod, fn.name, fn.lineno)].written
                        for m, (mod, fn) in registered.items()}
        raise AssertionError("the write analysis did not reach a fixpoint")


class _Function:
    def __init__(self, analysis: _Analysis, module: str, fn, stack: tuple):
        self.analysis, self.module, self.fn, self.stack = analysis, module, fn, stack
        self.local = {
            n.name: n for n in ast.walk(fn)
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n is not fn
        }
        self.nested = {id(n) for d in self.local.values() for n in ast.walk(d)}

    def resolve(self, call: ast.Call):
        func = call.func
        if isinstance(func, ast.Name):
            if func.id in self.local:
                return ("local", self.local[func.id])
            hit = _top_function(self.module, func.id)
            return ("engine",) + hit if hit else None
        if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name):
            target = _imports_of(self.module).get(func.value.id)
            if target and target[0] == "mod":
                hit = _top_function(target[1], func.attr)
                return ("engine",) + hit if hit else None
        return None

    def bind(self, fn, call: ast.Call) -> dict:
        positional, keyword_only, vararg, kwarg = _signature(fn)
        out, spread = {}, set()
        for index, arg in enumerate(call.args):
            if isinstance(arg, ast.Starred):
                spread |= self.names(arg.value)
            elif index < len(positional):
                out.setdefault(positional[index], set()).update(self.names(arg))
            elif vararg:
                out.setdefault(vararg, set()).update(self.names(arg))
        for keyword in call.keywords:
            if keyword.arg is None:
                spread |= self.names(keyword.value)
            elif keyword.arg in positional or keyword.arg in keyword_only:
                out.setdefault(keyword.arg, set()).update(self.names(keyword.value))
            elif kwarg:
                out.setdefault(kwarg, set()).update(self.names(keyword.value))
        if spread:
            for parameter in _all_parameters(fn):
                out.setdefault(parameter, set()).update(spread)
        return out

    def call_value(self, call: ast.Call, elements: int | None = None):
        hit = self.resolve(call)
        if hit and hit[0] == "engine":
            callee = self.analysis.summary(hit[1], hit[2], self.stack)
            bound = self.bind(hit[2], call)

            def carried(parameters):
                out = set()
                for parameter in parameters:
                    out |= bound.get(parameter, set())
                return out

            if elements is not None and callee.elements is not None and len(callee.elements) == elements:
                return [carried(e) for e in callee.elements]
            return carried(callee.returns)
        out = set()
        for arg in call.args:
            out |= self.names(arg.value if isinstance(arg, ast.Starred) else arg)
        for keyword in call.keywords:
            out |= self.names(keyword.value)
        if isinstance(call.func, ast.Attribute):
            out |= self.names(call.func.value)
        if hit and hit[0] == "local":
            for node in ast.walk(hit[1]):
                if isinstance(node, (ast.Return, ast.Yield)) and node.value is not None:
                    out |= self.names(node.value)
        return [out] * elements if elements is not None else out

    def names(self, node) -> set:
        if node is None:
            return set()
        if isinstance(node, ast.Name):
            return {node.id}
        if isinstance(node, ast.Attribute) and node.attr in _CUT_ATTRIBUTES:
            return set()
        if isinstance(node, (ast.Compare, ast.Lambda)):
            return set()
        if isinstance(node, ast.Call):
            dotted = _dotted(node.func)
            if dotted and (dotted in _CUT_CALLS or dotted.startswith(_CUT_PREFIXES)):
                return set()
            if isinstance(node.func, ast.Attribute) and node.func.attr in _CUT_METHODS:
                return set()
            return self.call_value(node)
        out = set()
        for child in ast.iter_child_nodes(node):
            out |= self.names(child)
        return out

    def run(self, summary: _Summary) -> None:
        edges: dict = {}
        sinks: set = set()

        def edge(sources, targets):
            for source in sources:
                edges.setdefault(source, set()).update(targets)

        def assign(target, value):
            if isinstance(target, (ast.Tuple, ast.List)) and isinstance(value, ast.Call):
                for element, sources in zip(target.elts, self.call_value(value, len(target.elts))):
                    edge(sources, _target_names(element))
            elif (isinstance(target, (ast.Tuple, ast.List)) and isinstance(value, (ast.Tuple, ast.List))
                  and len(target.elts) == len(value.elts)):
                for element, part in zip(target.elts, value.elts):
                    edge(self.names(part), _target_names(element))
            else:
                edge(self.names(value), _target_names(target))

        def loop(target, iterable):
            if isinstance(iterable, ast.Call) and isinstance(target, (ast.Tuple, ast.List)):
                dotted = _dotted(iterable.func)
                if dotted == "enumerate" and len(target.elts) == 2 and iterable.args:
                    loop(target.elts[1], iterable.args[0])
                    return
                if dotted == "zip" and len(target.elts) == len(iterable.args):
                    for element, column in zip(target.elts, iterable.args):
                        loop(element, column)
                    return
            edge(self.names(iterable), _target_names(target))

        returns = []
        for node in ast.walk(self.fn):
            if isinstance(node, ast.Assign):
                for target in node.targets:
                    assign(target, node.value)
            elif isinstance(node, (ast.AnnAssign, ast.AugAssign)) and node.value is not None:
                edge(self.names(node.value), _target_names(node.target))
            elif isinstance(node, ast.NamedExpr):
                edge(self.names(node.value), _target_names(node.target))
            elif isinstance(node, (ast.For, ast.AsyncFor, ast.comprehension)):
                loop(node.target, node.iter)
            elif isinstance(node, (ast.With, ast.AsyncWith)):
                for item in node.items:
                    if item.optional_vars is not None:
                        assign(item.optional_vars, item.context_expr)
            elif isinstance(node, (ast.Return, ast.Yield)) and node.value is not None:
                if id(node) not in self.nested:
                    returns.append(node.value)
            elif isinstance(node, ast.Call):
                for expr in _sink_arguments(node):
                    sinks |= self.names(expr)
                if isinstance(node.func, ast.Attribute) and node.func.attr in _MUTATORS:
                    base = _base_name(node.func.value)
                    if base:
                        for arg in node.args:
                            edge(self.names(arg), {base})
                hit = self.resolve(node)
                if hit and hit[0] == "local":
                    for parameter, sources in self.bind(hit[1], node).items():
                        edge(sources, {parameter})
                elif hit:
                    callee = self.analysis.summary(hit[1], hit[2], self.stack)
                    for parameter, sources in self.bind(hit[2], node).items():
                        if parameter in callee.written:
                            sinks |= sources

        returned = set()
        for value in returns:
            returned |= self.names(value)
        element_names = None
        if returns and all(isinstance(r, ast.Tuple) for r in returns) and len({len(r.elts) for r in returns}) == 1:
            element_names = [set() for _ in returns[0].elts]
            for value in returns:
                for index, element in enumerate(value.elts):
                    element_names[index] |= self.names(element)
            summary.elements = [set() for _ in element_names]
        for parameter in _all_parameters(self.fn):
            reached, todo = {parameter}, [parameter]
            while todo:
                for nxt in edges.get(todo.pop(), ()):
                    if nxt not in reached:
                        reached.add(nxt)
                        todo.append(nxt)
            if reached & sinks:
                summary.written.add(parameter)
            if reached & returned:
                summary.returns.add(parameter)
            if element_names is not None:
                for index, names in enumerate(element_names):
                    if reached & names:
                        summary.elements[index].add(parameter)


_written_cache: dict = {}


def _written() -> dict:
    """``method -> parameters its handler writes, moves or deletes``."""
    if not _written_cache:
        _written_cache.update(_Analysis().written(_registered()))
    return _written_cache


# ── tests ─────────────────────────────────────────────────────────────────


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


def test_conditional_rows_name_parameters_of_their_handler():
    handlers = _handlers()
    conditional = {
        (method, key): mode[2:]
        for method, cells in _table().items()
        for key, mode in cells.items()
        if mode.startswith("X:")
    }
    assert set(conditional) == set(CONDITIONAL), "conditional rows and their stated reasons differ"
    for (method, key), condition in conditional.items():
        assert condition == CONDITIONAL[(method, key)][0], f"{method}.{key}: condition {condition}"
        for term in condition.split("|"):
            assert term.lstrip("!") in handlers[method][0], f"{method}.{key}: {term} is not a parameter"


def test_every_path_parameter_has_a_mode_or_is_declared_unlocked():
    rows = _table()
    missing = []
    for method, (params, _) in _handlers().items():
        for name in params:
            if (
                _path_shaped(name)
                and name not in rows[method]
                and name not in UNLOCKED
                and (method, name) not in NOT_PATHS
            ):
                missing.append(f"{method}.{name}")
    assert missing == [], "path parameters with no lock mode"


def test_no_row_keys_a_value_that_is_not_a_path():
    rows = _table()
    keyed = [f"{m}.{k}" for (m, k) in NOT_PATHS if k in rows[m]]
    assert keyed == [], "lock keys that hold no path"


def test_a_written_parameter_is_exclusive_and_a_read_one_shared():
    rows = _table()
    written = _written()
    wrong = []
    for method, cells in rows.items():
        for key, mode in cells.items():
            writes = key in written[method]
            if mode == "S" and writes and (method, key) not in SHARED_DESPITE_WRITE:
                wrong.append(f"{method}.{key}: written, locked shared")
            if mode != "S" and not writes and (method, key) not in EXCLUSIVE_WITHOUT_WRITE:
                wrong.append(f"{method}.{key}: only read, locked {mode}")
    assert wrong == []


def test_every_written_path_parameter_has_a_row():
    rows = _table()
    unlocked = [
        f"{method}.{name}"
        for method, names in _written().items()
        for name in names
        if _path_shaped(name) and name not in rows[method] and name not in UNLOCKED
    ]
    assert unlocked == [], "written path parameters with no lock row"


def test_every_stated_disagreement_is_still_one():
    rows = _table()
    written = _written()
    stale = [
        f"{m}.{k}" for (m, k) in SHARED_DESPITE_WRITE
        if rows[m].get(k) != "S" or k not in written[m]
    ] + [
        f"{m}.{k}" for (m, k) in EXCLUSIVE_WITHOUT_WRITE
        if rows[m].get(k, "S") == "S" or k in written[m]
    ]
    assert stale == [], "reasons for disagreements the table and the analysis no longer have"


def test_the_analysis_sees_known_writes_and_reads():
    written = _written()
    # Writes reached through staged landing, moves, folder removal, a direct
    # in-place rewrite, a pikepdf extract and a recursive delete.
    assert "output" in written["compress"]
    assert "source" in written["batch_ocr"]
    assert "source" in written["run_action"]
    assert "root" in written["remove_empty_folders"]
    assert "file" in written["emit_trapping_setup"]
    assert "path" in written["open_document_attempt"]
    assert "output_prefix" in written["extract_page_image"]
    assert "directory" in written["print_preview_cleanup"]
    assert "cleanup_dir" in written["print_preview"]
    # Pure reads.
    assert written["recognize"] == set()
    assert written["get_page_count"] == set()
    assert "destination_dir" not in written["split_plan"]
    assert "modified" not in written["transplant_incremental"]
    assert "path" not in written["pubkey_reattach"]
