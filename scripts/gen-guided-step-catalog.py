#!/usr/bin/env python3
"""Writes `tests/fixtures/guided-step-catalog.json` from the engine's step table.

The fixture is checked in and reviewed as a diff. `tests/test_guided_actions.py`
compares `render()` with the checked-in file, so a change to
`engine/guided_actions.py::_STEPS` or to the server's registrations fails there
until this script runs again. The suite never writes the fixture: a fixture the
suite regenerates pins nothing.

    .venv/Scripts/python.exe scripts/gen-guided-step-catalog.py
"""

from __future__ import annotations

import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "tests" / "fixtures" / "guided-step-catalog.json"

NOTE = (
    "The guided-step catalog, generated from engine/guided_actions.py::_STEPS. "
    "That table is the authority on op names, the parameter keys each op "
    "accepts and the tool paths each op is handed (`tools`); "
    "tests/test_guided_actions.py pins this file to it in both directions. "
    "src/renderer/lib/guided-actions.ts is the editor over the same set. What a "
    "step needs from Ghostscript is not recorded here: the window and the command "
    "line ask engine/guided_actions.py::step_gs_need through run_action(plan=True). "
    "`method` is the registered JSON-RPC name the single-document runner sends for "
    "the step; the folder tier sends step ids to run_action instead. Regenerate "
    "with scripts/gen-guided-step-catalog.py and review the diff."
)


def registered_methods() -> dict[str, str]:
    """The JSON-RPC name each handler symbol is registered under.

    Read from the server's own register() calls: importing `engine.__main__`
    would run its module body, which reconfigures stdio and starts the loop.
    """
    main_py = (ROOT / "src" / "engine" / "__main__.py").read_text(encoding="utf-8")
    return {
        symbol: name
        for name, symbol in re.findall(r'server\.register\("(\w+)", (\w+)\)', main_py)
    }


def render() -> str:
    """The fixture's full text."""
    src = str(ROOT / "src")
    if src not in sys.path:
        sys.path.insert(0, src)
    from engine.guided_actions import _STEPS

    by_symbol = registered_methods()
    catalog = {
        "note": NOTE,
        "steps": {
            op: {
                "method": by_symbol[spec.fn.__name__],
                "params": sorted(spec.params),
                "tools": sorted(spec.tools),
            }
            for op, spec in sorted(_STEPS.items())
        },
    }
    return json.dumps(catalog, indent=2) + "\n"


def main() -> int:
    FIXTURE.write_text(render(), encoding="utf-8")
    print(f"wrote {FIXTURE.relative_to(ROOT).as_posix()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
