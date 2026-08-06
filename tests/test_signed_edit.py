"""The signed-edit decision, engine side, against the shared corpus.

`tests/fixtures/signed-edit-corpus.json` is read here and by
`tests/signed-edit-corpus.test.ts`, so the engine's table and the renderer's
cannot drift on what a document's own signatures permit.
"""

import json
import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).parent.parent / "src"))

from engine.incremental import signed_edit_decision  # noqa: E402

CORPUS = json.loads(
    (pathlib.Path(__file__).parent / "fixtures" / "signed-edit-corpus.json").read_text(
        encoding="utf-8"
    )
)


@pytest.mark.parametrize("case", CORPUS["cases"], ids=lambda c: c["name"])
def test_corpus_case(case):
    decision = signed_edit_decision(case["policy"], case["class"], case.get("fields"))
    assert decision["kind"] == case["kind"]
    assert decision.get("reason") == case.get("reason")


def test_corpus_covers_every_kind():
    kinds = {case["kind"] for case in CORPUS["cases"]}
    assert kinds == {"proceed", "warn", "refuse"}


def test_unknown_edit_class_refuses_by_name():
    with pytest.raises(ValueError, match="edit class"):
        signed_edit_decision({"signed": True, "certified": False, "level": None}, "flatten")
