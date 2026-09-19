#!/usr/bin/env python3
"""Writes `data_action_cases` into `tests/fixtures/field-spec-corpus.json`.

The rows are MEASURED, not transcribed: each authored list is written into a
real document by `set_field_actions` and read back through `read_form_fields`,
so the corpus records what the writer and the reader actually agree on. Every
other key of the corpus is left as it is.

    .venv/Scripts/python.exe scripts/gen-field-action-cases.py
"""

from __future__ import annotations

import json
import pathlib
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
CORPUS = ROOT / "tests" / "fixtures" / "field-spec-corpus.json"

NOTE = (
    "The /AA and /A action kinds that carry no code. Each row's `authored` list "
    "is written by set_field_actions into a real document and `read` is what "
    "read_form_fields classifies back out of it, so the pair records what the "
    "writer and the reader actually agree on rather than what either intends. "
    "The renderer half additionally requires the properties-editor inverse: "
    "narrowing `read`, taking the authorable actions and re-serializing them "
    "reproduces `authored` exactly, so a field opened and applied unchanged "
    "rewrites what it already had. MEASURED by scripts/gen-field-action-cases.py."
)

CASES = [
    ("a button that goes to a page",
     [{"trigger": "A", "kind": "goto", "page": 1}], None),
    ("a button that opens a link",
     [{"trigger": "A", "kind": "uri", "uri": "https://example.invalid/help"}], None),
    ("a button that resets the whole form",
     [{"trigger": "A", "kind": "reset", "fields": [], "exclude": False}], None),
    ("a button that resets only the fields it names",
     [{"trigger": "A", "kind": "reset", "fields": ["Item1"], "exclude": False}], None),
    ("a button that resets everything except the fields it names",
     [{"trigger": "A", "kind": "reset", "fields": ["Item1"], "exclude": True}], None),
    ("a button that submits as FDF",
     [{"trigger": "A", "kind": "submit", "url": "https://example.invalid/post",
       "format": "fdf", "method": "post", "fields": [], "exclude": False,
       "include_empty": False}], None),
    ("a button that submits selected fields as XFDF over GET, blanks included",
     [{"trigger": "A", "kind": "submit", "url": "https://example.invalid/post",
       "format": "xfdf", "method": "get", "fields": ["Item1", "Item2"],
       "exclude": False, "include_empty": True}], None),
    ("a button that submits as HTML",
     [{"trigger": "A", "kind": "submit", "url": "https://example.invalid/post",
       "format": "html", "method": "post", "fields": [], "exclude": False,
       "include_empty": False}], None),
    ("a button that submits the whole document",
     [{"trigger": "A", "kind": "submit", "url": "https://example.invalid/post",
       "format": "pdf", "method": "post", "fields": [], "exclude": False,
       "include_empty": False}], None),
    ("a button that imports form data",
     [{"trigger": "A", "kind": "import", "file": "data.fdf"}], None),
    ("a rollover that hides on enter and shows on exit",
     [{"trigger": "E", "kind": "hide", "targets": ["Item2"], "hide": True},
      {"trigger": "X", "kind": "hide", "targets": ["Item2"], "hide": False}], None),
    ("every trigger at once",
     [{"trigger": "A", "kind": "goto", "page": 0},
      {"trigger": "D", "kind": "uri", "uri": "https://example.invalid/d"},
      {"trigger": "U", "kind": "reset", "fields": [], "exclude": False},
      {"trigger": "E", "kind": "hide", "targets": ["Item1"], "hide": True},
      {"trigger": "X", "kind": "hide", "targets": ["Item1"], "hide": False},
      {"trigger": "Fo", "kind": "import", "file": "seed.fdf"},
      {"trigger": "Bl", "kind": "submit", "url": "https://example.invalid/blur",
       "format": "fdf", "method": "post", "fields": [], "exclude": False,
       "include_empty": False}], None),
    ("no actions at all",
     [], None),
    ("a go-to naming a page the document does not have refuses",
     [{"trigger": "A", "kind": "goto", "page": 9}], "goto_page_out_of_range"),
    ("an action naming a field the document does not have refuses",
     [{"trigger": "A", "kind": "hide", "targets": ["Nope"], "hide": True}], "unknown_field"),
    ("a link with no address refuses",
     [{"trigger": "A", "kind": "uri", "uri": ""}], "no_address"),
    ("a submission with no address refuses",
     [{"trigger": "A", "kind": "submit", "url": "", "format": "fdf", "method": "post",
       "fields": [], "exclude": False, "include_empty": False}], "no_address"),
    ("a submission in a format this app does not write refuses",
     [{"trigger": "A", "kind": "submit", "url": "https://example.invalid/post",
       "format": "csv", "method": "post", "fields": [], "exclude": False,
       "include_empty": False}], "unknown_format"),
    ("a show-or-hide naming nothing refuses",
     [{"trigger": "A", "kind": "hide", "targets": [], "hide": True}], "no_targets"),
    ("an import naming no file refuses",
     [{"trigger": "A", "kind": "import", "file": ""}], "no_import_file"),
    ("two actions on one trigger refuse",
     [{"trigger": "A", "kind": "reset", "fields": [], "exclude": False},
      {"trigger": "A", "kind": "uri", "uri": "https://example.invalid/x"}], "duplicate_trigger"),
    ("a trigger this app does not know refuses",
     [{"trigger": "PO", "kind": "reset", "fields": [], "exclude": False}], "unknown_trigger"),
    ("an action kind this app does not author refuses",
     [{"trigger": "A", "kind": "named", "name": "NextPage"}], "unknown_kind"),
]


def base(tmp: pathlib.Path) -> pathlib.Path:
    import pikepdf
    from engine.form_authoring import add_form_fields

    src = tmp / "blank.pdf"
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(612, 792))
    pdf.add_blank_page(page_size=(612, 792))
    pdf.save(src)
    out = tmp / "base.pdf"
    add_form_fields(str(src), str(out), [
        {"name": "Item1", "type": "text", "page_index": 0, "rect": [72, 700, 300, 716]},
        {"name": "Item2", "type": "text", "page_index": 0, "rect": [72, 660, 300, 676]},
        {"name": "Go", "type": "text", "page_index": 0, "rect": [72, 620, 300, 636]},
    ])
    return out


def measure() -> list[dict]:
    from engine.form_authoring import FieldSpecError, set_field_actions
    from engine.forms import read_form_fields

    rows = []
    with tempfile.TemporaryDirectory() as td:
        tmp = pathlib.Path(td)
        src = base(tmp)
        for name, authored, refuses in CASES:
            out = tmp / "out.pdf"
            if refuses:
                try:
                    set_field_actions(str(src), str(out), field="Go", actions=authored)
                except (FieldSpecError, ValueError) as exc:
                    problems = getattr(exc, "problems", [str(exc)])
                    rows.append({"name": name, "authored": authored,
                                 "refuses": refuses, "problems": problems})
                    continue
                raise SystemExit(f"NOT REFUSED: {name}")
            set_field_actions(str(src), str(out), field="Go", actions=authored)
            read = {}
            for f in read_form_fields(str(out))["fields"]:
                if f["name"] == "Go":
                    read = f.get("field_actions", {})
            rows.append({"name": name, "authored": authored, "read": read})
    return rows


def main() -> int:
    sys.path.insert(0, str(ROOT / "src"))
    rows = measure()
    corpus = json.loads(CORPUS.read_text(encoding="utf-8"))
    corpus["data_action_note"] = NOTE
    corpus["data_action_cases"] = rows
    CORPUS.write_text(json.dumps(corpus, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"{len(rows)} rows ({sum(1 for r in rows if 'refuses' in r)} refusing)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
