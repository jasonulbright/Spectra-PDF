"""The engine's own answer to "which doors accept writing over their input".

The two in-place families enumerate their cases by hand, and a hand-written
enumeration cannot notice a door nobody thought of — the failure this exists to
prevent is a door whose in-place write is exercised by nothing, so a change to
the shared staging code lands green and crashes only through that door.

The inventory is read from the engine rather than restated here:

  * a DOOR is a ``server.register("name", fn)`` call in ``engine/__main__.py``,
    resolved through that module's own imports to the function it names;
  * a door is SAME-PATH CAPABLE when its call graph, walked inside the engine
    package, reaches a place where a written file is SWAPPED over another
    name — one of ``engine.inplace``'s staging scopes, or a bare
    ``os.replace`` / ``shutil.move`` where an op stages by hand. Reaching one
    is what "this door accepts ``output == file``" means in this codebase: a
    door that never swaps would write through its own open input, and asking
    only about ``engine.inplace`` would miss every op that stages by hand.

The walk is syntactic (names resolved through each module's imports), so it
sees a call written as a name or as ``module.name``. It does not follow a call
made through ``self``, an attribute of a value, or a dispatch table — a door
that reached staging only that way would be missed. No engine door does today:
every registered door is a module-level function that calls its writer by name.
The direction of that limit is the safe one for a roster the tests then have to
account for by hand, not for a claim that a door is safe.
"""

from __future__ import annotations

import ast
import os
from collections import defaultdict
from pathlib import Path

PACKAGE = Path(__file__).resolve().parent.parent / "src" / "engine"

#: The scopes that make a write in-place-safe. A door that reaches one of these
#: stages beside the output and lands it by swapping a directory entry.
STAGING_SCOPES = frozenset({
    ("engine.inplace", "staged_write"),
    ("engine.inplace", "staged_write_if"),
    ("engine.inplace", "finish_staged"),
})

#: The swap itself, for the ops that stage by hand instead. `engine.inplace`
#: is built on the first of these, so an op reaching either has landed a
#: written file over a name that may be its own input.
SWAPS = frozenset({("os", "replace"), ("shutil", "move")})


def _module_trees() -> dict:
    trees = {}
    for entry in sorted(os.listdir(PACKAGE)):
        if entry.endswith(".py"):
            source = (PACKAGE / entry).read_text(encoding="utf-8")
            trees["engine." + entry[:-3]] = ast.parse(source)
    return trees


def _imports(tree: ast.AST) -> tuple:
    """``name -> (module, attr)`` and ``alias -> module``, for engine imports
    written absolutely (``from engine.x import f``) or relatively
    (``from .x import f``, ``from . import x``)."""
    names: dict = {}
    modules: dict = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            module = node.module or ""
            if node.level:
                module = "engine." + module if module else "engine"
            if module == "engine":
                for alias in node.names:
                    modules[alias.asname or alias.name] = "engine." + alias.name
            elif module.startswith("engine."):
                for alias in node.names:
                    names[alias.asname or alias.name] = (module, alias.name)
        elif isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name.startswith("engine."):
                    modules[alias.asname or alias.name.split(".")[-1]] = alias.name
    return names, modules


def _call_graph(trees: dict) -> tuple:
    """``(module, function) -> {(module, function), ...}`` for every call the
    function makes that resolves to another engine function, plus the set of
    functions that perform a swap themselves."""
    graph: dict = defaultdict(set)
    swappers: set = set()
    for module_name, tree in trees.items():
        names, modules = _imports(tree)
        local = {
            node.name
            for node in ast.walk(tree)
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        }

        def resolve(call: ast.Call):
            func = call.func
            if isinstance(func, ast.Name):
                if func.id in names:
                    return names[func.id]
                if func.id in local:
                    return (module_name, func.id)
            elif isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name):
                if func.value.id in modules:
                    return (modules[func.value.id], func.attr)
            return None

        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            here = (module_name, node.name)
            for inner in ast.walk(node):
                if not isinstance(inner, ast.Call):
                    continue
                target = resolve(inner)
                if target is not None:
                    graph[here].add(target)
                func = inner.func
                if (
                    isinstance(func, ast.Attribute)
                    and isinstance(func.value, ast.Name)
                    and (func.value.id, func.attr) in SWAPS
                ):
                    swappers.add(here)
    return graph, swappers


def _reaching(graph: dict, swappers: set) -> set:
    """Every engine function whose call graph reaches a swap."""
    reached = set(STAGING_SCOPES) | set(swappers)
    changed = True
    while changed:
        changed = False
        for caller, callees in graph.items():
            if caller not in reached and callees & reached:
                reached.add(caller)
                changed = True
    return reached


def registered_doors() -> dict:
    """``door name -> "engine.module.function"``, read from the server's own
    registrations."""
    tree = ast.parse((PACKAGE / "__main__.py").read_text(encoding="utf-8"))
    names, _ = _imports(tree)
    doors = {}
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "register"
            and len(node.args) == 2
            and isinstance(node.args[0], ast.Constant)
            and isinstance(node.args[1], ast.Name)
        ):
            target = names.get(node.args[1].id)
            if target is not None:
                doors[node.args[0].value] = "%s.%s" % target
    return doors


def same_path_capable() -> dict:
    """The doors that accept ``output == file``: ``door name -> "module.fn"``.

    Empty would mean the walk stopped resolving names — the callers assert it
    is not, because a guard over an empty inventory passes for the wrong
    reason.
    """
    trees = _module_trees()
    graph, swappers = _call_graph(trees)
    reached = _reaching(graph, swappers)
    doors = {}
    for door, qualified in registered_doors().items():
        module, _, function = qualified.rpartition(".")
        if (module, function) in reached:
            doors[door] = qualified
    return doors
