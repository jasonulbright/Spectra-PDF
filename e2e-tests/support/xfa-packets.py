"""Independent read of a PDF's `/XFA` packets and field `/V` entries.

The spec drives the shipped app; this is the third reader that says what
actually landed in the bytes. It is deliberately the ENGINE's own packet
accessor (`engine/xfa.py`) rather than a hand-rolled one, because the two
`/XFA` spellings are the thing being read, not the thing being tested.

Packet bodies are emitted as latin-1 text so the caller compares BYTES:
every code unit round-trips, which UTF-8 would not for arbitrary stream
content.

    python e2e-tests/support/xfa-packets.py <pdf>  ->  JSON on stdout
"""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "src"))

import pikepdf  # noqa: E402

from engine import xfa  # noqa: E402


def main(path: str) -> None:
    out: dict = {"packets": {}, "values": {}, "needs_rendering": False}
    with pikepdf.open(path) as pdf:
        out["needs_rendering"] = xfa.needs_rendering(pdf)
        entry = xfa.xfa_entry(pdf)
        out["has_xfa"] = entry is not None
        out["classification"] = xfa.classify(pdf)
        if entry is not None:
            for name, stream in xfa.packets(entry):
                out["packets"][name] = stream.read_bytes().decode("latin-1")
        acro = xfa.acroform(pdf)
        if isinstance(acro, pikepdf.Dictionary):
            for field in acro.get("/Fields") or []:
                title = field.get("/T")
                if title is None:
                    continue
                value = field.get("/V")
                out["values"][str(title)] = None if value is None else str(value)
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main(sys.argv[1])
