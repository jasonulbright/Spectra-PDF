"""Structure-tree repairs the accessibility report offers as one click.

These are the fixes a checker can perform without asking anything: the shape
they produce is decided by the document itself, not by a judgment the reader
has to make. Everything that needs a value the machine cannot invent — alt
text, a table summary, a language — stays an authored fix on `set_struct_props`
and its siblings.

`set_table_headers` is the one that needs more than a path: which cells become
headers is a question about the TABLE, so it rides the audit's own row and cell
resolution (`struct_audit`) rather than a second reading of the same tree.
"""

from __future__ import annotations

from pathlib import Path

import pikepdf
from pikepdf import Name

from engine.struct_audit import audit_tree, row_cells, tables
from engine.struct_tree import _save, _set_table_attr, _SCOPES

# A header row's cells describe the COLUMN under them, which is what promoting
# the first row means. The door takes the scope so a left-hand header column
# can be promoted with Row instead.
DEFAULT_SCOPE = "Column"


def _node_at(nodes: list, path: list):
    wanted = [int(v) for v in path]
    for node in nodes:
        if [int(v) for v in node.path] == wanted:
            return node
    return None


def _elem_at(pdf, path: list):
    from engine.struct_tree import _walk_path

    return _walk_path(pdf, path)[-1]


def set_table_headers(
    file: str, output: str, path: list, scope: str = DEFAULT_SCOPE
) -> dict:
    """Promote a table's first row to header cells and give each one a scope.

    `path` names the `Table` element in `get_struct_tree`'s numbering. Every
    cell of its first row becomes a `TH` carrying `/Scope`; a cell that is
    already a `TH` keeps its own scope if it has one.

    Args:
        file: Input PDF path.
        output: Output PDF path (may equal `file`).
        path: Structure path of the table.
        scope: Column (the default), Row or Both.
    """
    value = str(scope or DEFAULT_SCOPE).strip().lstrip("/")
    if value not in _SCOPES:
        raise ValueError(
            f'"{value}" is not a header scope; a header cell reads Row, Column or Both.'
        )
    if not path:
        raise ValueError("path must name a table, not the tree root")

    input_path, output_path = Path(file), Path(output)
    same_file = input_path.resolve() == output_path.resolve()
    with pikepdf.open(file) as pdf:
        tree = audit_tree(pdf)
        if not tree["tagged"]:
            raise ValueError("document has no structure tree (it is untagged)")
        node = _node_at(tree["nodes"], path)
        if node is None:
            raise ValueError(f"path {list(path)} names no element in this document's tree")
        if node.role != "Table":
            raise ValueError(
                f'path {list(path)} names an element tagged "{node.tag or "(none)"}", '
                "not a table."
            )
        found = next((t for t in tables(tree["nodes"]) if t["table"] is node), None)
        rows = found["rows"] if found else []
        if not rows:
            raise ValueError("this table has no rows, so it has no first row to promote.")
        cells = row_cells(rows[0])
        if not cells:
            raise ValueError("this table's first row has no cells to promote.")
        promoted = []
        for cell in cells:
            elem = _elem_at(pdf, cell.path)
            elem[Name.S] = Name.TH
            existing = cell.attrs.get("Scope")
            if cell.role != "TH" or existing is None:
                _set_table_attr(pdf, elem, "/Scope", Name("/" + value))
            promoted.append([int(v) for v in cell.path])
        if not promoted:
            raise ValueError("this table's first row has no cells to promote.")
        _save(pdf, output_path, same_file)
    return {
        "output": str(output_path),
        "path": [int(v) for v in path],
        "promoted": promoted,
        "scope": value,
    }
