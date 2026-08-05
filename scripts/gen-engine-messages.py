"""Regenerate the engine refusal table.

MAINTENANCE TOOL, not a build step. Run it when the engine's refusal
messages change, review the resulting diff to
`src/renderer/locales/engine-messages.tsv`, and commit it — the same honesty
rule the Tesseract notice inventory follows. The pytest gate
(`tests/test_engine_messages.py`) is what fails when someone forgets.

    .venv/Scripts/python.exe scripts/gen-engine-messages.py

Keys are PRESERVED across runs by message text; a message whose wording
changed is reported so its key can be carried over by hand rather than
silently reminted (a new key orphans every translation of that message).
"""

from __future__ import annotations

import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from engine_message_sweep import (  # noqa: E402
    Row,
    inventory,
    propose_key,
    read_table,
    shape,
    write_table,
    TABLE_PATH,
)


def main() -> int:
    live = inventory()
    # Keyed by SHAPE, so renaming the local variable behind a placeholder
    # rewrites the row without orphaning its translations.
    existing = (
        {shape(row.message): row for row in read_table()} if TABLE_PATH.exists() else {}
    )

    rows: list[Row] = []
    taken = {row.key for row in existing.values()}
    added: list[str] = []
    for message, modules in live.items():
        prior = existing.get(shape(message))
        if prior is not None:
            key = prior.key
        else:
            key = propose_key(message, modules, taken)
            taken.add(key)
            added.append(key)
        kind = "pattern" if "{{" in message else "exact"
        rows.append(Row(key, kind, modules, message))

    live_shapes = {shape(m) for m in live}
    removed = [row.key for sh, row in existing.items() if sh not in live_shapes]

    write_table(rows)
    print(f"wrote {TABLE_PATH.relative_to(TABLE_PATH.parents[3])}: {len(rows)} rows")
    print(f"  exact  : {sum(1 for r in rows if r.kind == 'exact')}")
    print(f"  pattern: {sum(1 for r in rows if r.kind == 'pattern')}")
    if added:
        print(f"  NEW keys ({len(added)}): {', '.join(sorted(added))}")
    if removed:
        print(
            f"  DROPPED keys ({len(removed)}): {', '.join(sorted(removed))}\n"
            "  If a message was REWORDED rather than deleted, carry its old key onto\n"
            "  the new row by hand — a fresh key orphans every translation it had."
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
