"""N12 slice D — the engine refusal inventory (brief 37 § Slices D).

Engine messages stay ENGLISH AT THE ENGINE: diagnostics, the CLI and the
logs are English by contract, and the fingerprint text is byte-stable. What
localizes is the RENDERER's rendering of them, and it does that by matching
the message it received against a checked-in table of the engine's own
refusals.

This module is the sweep that keeps that table honest. It walks every
`src/engine/*.py` with `ast` and enumerates each `raise` of a PUBLIC
exception type carrying a literal message — the refusals that leave a
registered JSON-RPC method and reach the renderer through `ipc.py`'s
`str(exc)`. Two consumers share it:

  * `scripts/gen-engine-messages.py` — the MAINTENANCE tool. Run it when the
    engine's messages change; it rewrites the table, PRESERVING the key of
    every message that already had one, and the diff is reviewed and
    committed. (The `fetch-tesseract-licenses.ps1` precedent: generated once,
    reviewed as a git diff, checked in, regenerated only when the source
    moves — never re-derived at build time.)
  * `tests/test_engine_messages.py` — the GATE. It re-runs the sweep and
    fails when the engine's live inventory diverges from the checked-in
    table, so a new or reworded refusal cannot silently become an
    unlocalized string in the UI.

Classification, and its limits (stated rather than implied):

  * PUBLIC exception types only. The engine's internal sentinels
    (`SvgUnsupported`, `_TransplantRefusal`, `_Unserializable`,
    `_AlreadyHandled`) are control flow their own callers catch — a
    transplant refusal is a RESULT that triggers the ordinary-rewrite
    fallback, never a message the user sees — so they are not refusals and
    are excluded by construction.
  * A raise lexically inside a `try` whose handlers catch its type is
    INTERNAL: it never leaves the function, so it never reaches the bridge.
  * A raise whose message is not a literal (a bare variable, a formatted
    exception passed through) is DYNAMIC: there is no text to match on, so
    it is out of the table by construction and passes through verbatim.
  * The heuristic is deliberately over-inclusive across FUNCTION boundaries:
    a helper's ValueError caught by its caller still lands in the table. An
    extra row costs one translated string; a missing row costs a bare
    English message in a localized UI, so the asymmetry is taken on purpose.
"""

from __future__ import annotations

import ast
import pathlib
import re
from dataclasses import dataclass

REPO = pathlib.Path(__file__).resolve().parent.parent
ENGINE_DIR = REPO / "src" / "engine"
TABLE_PATH = REPO / "src" / "renderer" / "locales" / "engine-messages.tsv"

#: Exception types whose `str()` reaches the renderer via ipc.py. The engine's
#: private sentinels are absent on purpose (see the module docstring).
PUBLIC_EXCEPTIONS = frozenset(
    {
        "ValueError",
        "RuntimeError",
        "FileNotFoundError",
        "TypeError",
        "OSError",
        "IOError",
        "KeyError",
        "NotImplementedError",
        "PermissionError",
    }
)

#: A pattern row must carry at least this many literal characters, so a
#: template can never degrade into a match-everything wildcard.
MIN_LITERAL_ANCHOR = 6


@dataclass(frozen=True)
class Refusal:
    """One enumerated raise site."""

    module: str
    line: int
    exc: str
    #: The message with `{{name}}` where the source interpolated a value.
    template: str
    #: Interpolation names, in the order they appear.
    variables: tuple[str, ...]

    @property
    def kind(self) -> str:
        return "pattern" if self.variables else "exact"


def _placeholder_name(node: ast.AST, src: str, taken: list[str]) -> str:
    """A readable interpolation name for one f-string expression.

    A bare identifier keeps its own name so the catalog reads like the
    message it came from (`Page {{page}} is out of range`); anything else
    (a call, an attribute chain, a format spec) gets a positional name.
    Repeats are suffixed rather than merged: two occurrences of one variable
    are two independent captures in the match, and collapsing them would
    assert an equality the message never promised.
    """
    seg = ast.get_source_segment(src, node) or ""
    name = seg if seg.isidentifier() else f"v{len(taken)}"
    if name in taken:
        name = f"{name}{len(taken)}"
    return name


def _template(node: ast.AST, src: str) -> tuple[str, tuple[str, ...]] | None:
    """Render a message expression as a template, or None if it is dynamic."""
    parts: list[str] = []
    names: list[str] = []

    def walk(n: ast.AST) -> bool:
        if isinstance(n, ast.Constant) and isinstance(n.value, str):
            parts.append(n.value)
            return True
        if isinstance(n, ast.JoinedStr):
            for value in n.values:
                if isinstance(value, ast.Constant) and isinstance(value.value, str):
                    parts.append(value.value)
                elif isinstance(value, ast.FormattedValue):
                    name = _placeholder_name(value.value, src, names)
                    names.append(name)
                    parts.append("{{" + name + "}}")
                else:  # pragma: no cover - JoinedStr carries only these two
                    return False
            return True
        if isinstance(n, ast.BinOp) and isinstance(n.op, ast.Add):
            return walk(n.left) and walk(n.right)
        return False

    if not walk(node):
        return None
    return "".join(parts), tuple(names)


def _caught_in_place(stack: list[ast.AST], exc: str) -> bool:
    """Is this raise lexically inside a `try` that catches its own type?"""
    for i, node in enumerate(stack):
        if not isinstance(node, ast.Try):
            continue
        child = stack[i + 1] if i + 1 < len(stack) else None
        if child is None or not any(child is stmt for stmt in node.body):
            continue
        for handler in node.handlers:
            if handler.type is None:
                return True
            candidates = (
                list(handler.type.elts)
                if isinstance(handler.type, ast.Tuple)
                else [handler.type]
            )
            for cand in candidates:
                if isinstance(cand, ast.Name) and cand.id in (
                    exc,
                    "Exception",
                    "BaseException",
                ):
                    return True
    return False


def sweep(engine_dir: pathlib.Path | None = None) -> list[Refusal]:
    """Every user-facing refusal in the engine, sorted by module then line."""
    directory = engine_dir or ENGINE_DIR
    found: list[Refusal] = []
    for path in sorted(directory.glob("*.py")):
        src = path.read_text(encoding="utf-8")
        tree = ast.parse(src)
        stack: list[ast.AST] = []

        def visit(node: ast.AST) -> None:
            stack.append(node)
            if isinstance(node, ast.Raise) and isinstance(node.exc, ast.Call):
                func = node.exc.func
                if (
                    isinstance(func, ast.Name)
                    and func.id in PUBLIC_EXCEPTIONS
                    and node.exc.args
                    and not _caught_in_place(stack, func.id)
                ):
                    rendered = _template(node.exc.args[0], src)
                    if rendered is not None:
                        template, variables = rendered
                        found.append(
                            Refusal(path.stem, node.lineno, func.id, template, variables)
                        )
            for child in ast.iter_child_nodes(node):
                visit(child)
            stack.pop()

        visit(tree)
    return found


def literal_anchor(template: str) -> int:
    """How many LITERAL characters a template carries outside its placeholders."""
    return sum(len(part) for part in re.split(r"\{\{[^}]*\}\}", template))


def shape(template: str) -> str:
    """A template with its placeholder NAMES erased.

    Two raises can carry the same English sentence and different local
    variable names (`the fallback font cannot express {{ch}}` and
    `... {{pretty}}`). To a reader — and to the matcher, which captures by
    position — those are ONE message; only the source spelling differs. The
    shape is what identity is decided on, so they collapse to one row and one
    translation instead of two rows the matcher could never tell apart.
    """
    return re.sub(r"\{\{[^}]*\}\}", "{{}}", template)


def _partition(
    engine_dir: pathlib.Path | None,
) -> tuple[dict[str, tuple[str, set[str]]], dict[str, tuple[str, set[str]]]]:
    matchable: dict[str, tuple[str, set[str]]] = {}
    composed: dict[str, tuple[str, set[str]]] = {}
    for refusal in sweep(engine_dir):
        bucket = (
            matchable if literal_anchor(refusal.template) >= MIN_LITERAL_ANCHOR else composed
        )
        key = shape(refusal.template)
        canonical, modules = bucket.get(key, (None, set()))
        # Deterministic canonical spelling: the alphabetically first template
        # of the group, so regeneration never depends on file order.
        if canonical is None or refusal.template < canonical:
            canonical = refusal.template
        modules.add(refusal.module)
        bucket[key] = (canonical, modules)
    return matchable, composed


def inventory(engine_dir: pathlib.Path | None = None) -> dict[str, tuple[str, ...]]:
    """The sweep collapsed to `template -> the modules that raise it`.

    The renderer matches on TEXT, so one message raised from three modules is
    one row. The module list rides along so the table stays reviewable and so
    a message that MOVES shows up in the gate as a real diff.

    COMPOSED messages are excluded — a template with almost no literal text
    (`{{font}}: {{refusal}}`, a name glued to another module's refusal) would
    match nearly any string, so it cannot be recognized and passes through
    verbatim instead. `composed()` reports them so the exclusion is visible
    rather than silent.
    """
    matchable, _ = _partition(engine_dir)
    return {
        canonical: tuple(sorted(modules))
        for canonical, modules in sorted(matchable.values())
    }


def composed(engine_dir: pathlib.Path | None = None) -> dict[str, tuple[str, ...]]:
    """Refusals deliberately left out of the table (see `inventory`)."""
    _, comp = _partition(engine_dir)
    return {
        canonical: tuple(sorted(modules)) for canonical, modules in sorted(comp.values())
    }


# --------------------------------------------------------------------------
# The checked-in table
# --------------------------------------------------------------------------

TSV_HEADER = ("key", "kind", "modules", "message")

_ESCAPES = (("\\", "\\\\"), ("\t", "\\t"), ("\n", "\\n"), ("\r", "\\r"))


def encode_field(text: str) -> str:
    for raw, esc in _ESCAPES:
        text = text.replace(raw, esc)
    return text


def decode_field(text: str) -> str:
    out: list[str] = []
    i = 0
    while i < len(text):
        ch = text[i]
        if ch == "\\" and i + 1 < len(text):
            nxt = text[i + 1]
            mapped = {"\\": "\\", "t": "\t", "n": "\n", "r": "\r"}.get(nxt)
            if mapped is not None:
                out.append(mapped)
                i += 2
                continue
        out.append(ch)
        i += 1
    return "".join(out)


@dataclass(frozen=True)
class Row:
    key: str
    kind: str
    modules: tuple[str, ...]
    message: str


def read_table(path: pathlib.Path | None = None) -> list[Row]:
    target = path or TABLE_PATH
    rows: list[Row] = []
    for line in target.read_text(encoding="utf-8").splitlines():
        if not line or line.startswith("#"):
            continue
        fields = line.split("\t")
        if tuple(fields) == TSV_HEADER:
            continue
        if len(fields) != 4:
            raise ValueError(f"malformed table row (want 4 columns): {line!r}")
        key, kind, modules, message = fields
        rows.append(
            Row(key, kind, tuple(modules.split(",")) if modules else (), decode_field(message))
        )
    return rows


def write_table(rows: list[Row], path: pathlib.Path | None = None) -> None:
    target = path or TABLE_PATH
    lines = [
        "# N12 slice D — the engine refusal table (brief 37).",
        "# GENERATED by scripts/gen-engine-messages.py; reviewed as a git diff and",
        "# committed. Never hand-add a row: the pytest gate",
        "# (tests/test_engine_messages.py) re-sweeps the engine and fails when this",
        "# file diverges from what src/engine/*.py actually raises.",
        "#",
        "# Engine messages stay ENGLISH at the engine. This table is how the RENDERER",
        "# recognizes one: `message` is matched verbatim (kind=exact) or as a template",
        "# whose {{name}} placeholders capture the interpolated values (kind=pattern),",
        "# and `key` names the catalog entry (engine.<key>) that renders it in the UI",
        "# language. A message NOT in this table passes through verbatim — nothing is",
        "# ever swallowed. Keys are STABLE: rewording a message keeps its key.",
        "\t".join(TSV_HEADER),
    ]
    for row in sorted(rows, key=lambda r: r.key):
        lines.append(
            "\t".join(
                [row.key, row.kind, ",".join(row.modules), encode_field(row.message)]
            )
        )
    target.write_text("\n".join(lines) + "\n", encoding="utf-8")


# --------------------------------------------------------------------------
# Key proposal (new messages only — existing keys are never re-derived)
# --------------------------------------------------------------------------

_STOP_WORDS = frozenset(
    {
        "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "for",
        "from", "had", "has", "have", "in", "into", "is", "it", "its", "no",
        "not", "of", "on", "or", "so", "that", "the", "this", "to", "was",
        "were", "with", "you", "your",
    }
)


def propose_key(template: str, modules: tuple[str, ...], taken: set[str]) -> str:
    """A stable-looking semantic id for a message seen for the first time.

    Only ever called for a message with no key yet — a reworded message keeps
    the key it already had, which is the whole reason the table is checked in
    rather than derived.
    """
    # Placeholder NAMES are source-code identifiers, not English — a key built
    # from them reads like `compare.binaryPpmPV`. Strip them first.
    prose = re.sub(r"\{\{[^}]*\}\}", " ", template)
    words = [w for w in re.findall(r"[A-Za-z]+", prose) if w.lower() not in _STOP_WORDS]
    if not words:
        words = re.findall(r"[A-Za-z]+", prose) or ["message"]
    head = words[0].lower()
    slug = head + "".join(w[:1].upper() + w[1:].lower() for w in words[1:4])
    base = f"{modules[0]}.{slug}"
    key = base
    n = 2
    while key in taken:
        key = f"{base}{n}"
        n += 1
    return key
