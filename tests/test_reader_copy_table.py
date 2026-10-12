"""The methods that read a private copy of a working copy.

`src/renderer/lib/reader-copy.ts` maps in ``READER_COPY_METHODS`` each engine
method whose working-copy input is replaced by a reader copy to the
parameters it replaces. A member must:

  * run in the window's job process (`METHOD_CLASSES` in
    `src-tauri/src/engine.rs`), where one call can run for minutes;
  * hold every working-path parameter shared and no parameter conditionally
    exclusive (`ENGINE_LOCK_TABLE` in `src/renderer/lib/engine-lock.ts`): a
    method that may rewrite its input in place would rewrite the copy;
  * keep no state past the call that names its input, which rules out the
    exclusions below.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from test_engine_lock_table import _table as lock_table
from test_engine_route_table import _table as process_table

ROOT = Path(__file__).resolve().parent.parent
READER_COPY = ROOT / "src" / "renderer" / "lib" / "reader-copy.ts"

needs_reader_copy = pytest.mark.skipif(
    not READER_COPY.is_file(),
    reason="src/renderer/lib/reader-copy.ts, which declares READER_COPY_METHODS, is not in this tree",
)

#: Methods that keep their input path past the call or read per page.
EXCLUDED = {
    # The plate cache records the input path for later composites.
    "render_separations": "plate cache keeps the input path",
    "composite_separations": "reads the plate cache",
    "inspect_point": "reads the plate cache",
    # A bounded preview with folder state between calls.
    "print_preview": "preview folder state",
    "print_preview_cleanup": "preview folder state",
    # Per page.
    "recognize": "per page",
    "recognize_raster": "per page",
    # Inputs outside the workspace.
    "search_in_files": "inputs outside the workspace",
    "create_pdf": "inputs outside the workspace",
    "list_source_folders": "inputs outside the workspace",
}

COMMENT = re.compile(r"//[^\n]*|/\*.*?\*/", re.S)
ROW = re.compile(r"""['"]?(\w+)['"]?\s*:\s*\[([^\]]*)\]""")
NAME = re.compile(r"""['"](\w+)['"]""")


def _initializer(source: str, name: str) -> str:
    """The text of `name`'s initializer in `source`, from its first bracket
    to the bracket that closes it. `source` has its comments removed."""
    match = re.search(rf"\b(?:const|let|var)\s+{name}\b[^=]*=\s*", source)
    assert match, f"no declaration of {name} in {READER_COPY.name}"
    start = match.end()
    while source[start] not in "[{":
        start += 1
    pairs = {"[": "]", "{": "}"}
    stack = []
    for index in range(start, len(source)):
        char = source[index]
        if char in pairs:
            stack.append(pairs[char])
        elif stack and char == stack[-1]:
            stack.pop()
            if not stack:
                return source[start:index + 1]
    raise AssertionError(f"unterminated {name} in {READER_COPY.name}")


def _parse(source: str) -> dict[str, list[str]]:
    """Each member and the working-path parameters it replaces with a copy.

    The declaration must map each method to its parameters: a working-path
    parameter can have any name (`file`, `source`, `original`, `image`), so a
    list of methods alone leaves no parameter to check the lock mode of."""
    body = _initializer(COMMENT.sub("", source), "READER_COPY_METHODS")
    assert body.startswith("{"), (
        "READER_COPY_METHODS must map each method to the parameters it copies "
        "(`{ print: ['file'] }`), not list method names only"
    )
    rest = ROW.sub("", body[1:-1])
    assert not re.search(r"\w", rest), f"unparsable READER_COPY_METHODS entries: {rest.strip()!r}"
    members: dict[str, list[str]] = {}
    for method, params in ROW.findall(body):
        assert method not in members, f"duplicate READER_COPY_METHODS entry: {method}"
        unread = NAME.sub("", params)
        assert not re.search(r"\w", unread), (
            f"READER_COPY_METHODS.{method} names a parameter that is not a string literal: {unread.strip()!r}"
        )
        members[method] = NAME.findall(params)
    assert members, "READER_COPY_METHODS names no method"
    return members


def _members() -> dict[str, list[str]]:
    return _parse(READER_COPY.read_text(encoding="utf-8"))


def test_every_exclusion_names_a_job_method():
    classes = process_table()
    for method in EXCLUDED:
        assert classes.get(method) == "Job", method


def test_the_parser_reads_the_declaration_not_a_comment_or_a_neighbour():
    source = """
// READER_COPY_METHODS = { compress: ['file'] } is the old spelling.
/* READER_COPY_METHODS lists the members. */
export const OTHER: Record<string, string[]> = { optimize: ['file'] };
export const READER_COPY_METHODS: Readonly<Record<string, readonly string[]>> = {
  print: ['file'], // printed from the copy
  'compare_visual': ['file_a', 'file_b'],
};
export const LATER = { delete: ['file'] };
"""
    assert _parse(source) == {"print": ["file"], "compare_visual": ["file_a", "file_b"]}
    with pytest.raises(AssertionError, match="map each method"):
        _parse("export const READER_COPY_METHODS = new Set(['print']);")
    with pytest.raises(AssertionError, match="unparsable"):
        _parse("export const READER_COPY_METHODS = { print: ['file'], ...EXTRA };")
    for params in ("['file_a', ...MORE]", "['file_a', FILE_B]"):
        with pytest.raises(AssertionError, match="not a string literal"):
            _parse(f"export const READER_COPY_METHODS = {{ compare_visual: {params} }};")


@needs_reader_copy
def test_every_member_runs_in_the_job_process():
    classes = process_table()
    for method in _members():
        assert classes.get(method) == "Job", f"{method} is {classes.get(method)}, not a job method"


@needs_reader_copy
def test_every_member_holds_its_working_paths_shared_and_nothing_conditionally():
    table = lock_table()
    for method, declared in _members().items():
        row = table.get(method)
        assert row is not None, f"{method} has no lock-table row"
        assert declared, f"{method} names no working-path parameter"
        for parameter in declared:
            assert row.get(parameter) == "S", f"{method}.{parameter} is {row.get(parameter)!r}, not 'S'"
        conditional = {p: mode for p, mode in row.items() if mode.startswith("X:")}
        assert not conditional, f"{method} may rewrite its input: {conditional}"


@needs_reader_copy
def test_no_member_is_an_exclusion():
    for method in _members():
        assert method not in EXCLUDED, f"{method}: {EXCLUDED.get(method)}"
