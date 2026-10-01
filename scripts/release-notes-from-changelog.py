#!/usr/bin/env python3
"""Print the release notes for one version, extracted from CHANGELOG.md.

The release page's body and the updater manifest's `notes` are the same
string; both publishers take it from here so the changelog is the single
source. Output is LF-only bytes on stdout: the draft verifier compares the
manifest's `notes` to the release body byte for byte, and a Windows runner's
text-mode stdout would emit CRLF into one side of that comparison.
"""

from __future__ import annotations

import argparse
import importlib.util
import re
import sys
from pathlib import Path


def _release_version():
    """The sibling version module, by path: this script runs from `scripts/`
    and from a redo's `verifier/scripts/`, and tests load it by file path, so
    the module is never importable as a package."""
    path = Path(__file__).resolve().with_name("release_version.py")
    spec = importlib.util.spec_from_file_location("release_version", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module

FOOTER = "Full changelog: CHANGELOG.md"

# Topics that may never appear in release notes (owner standing rule): code
# signing, certificates and SmartScreen live only in the README's unsigned
# note, and marketing adjectives are banned outright. Matched case-insensitively
# on word boundaries, so a document-signature feature ("signed", "signature")
# is not caught by "sign".
BANNED = (
    "sign",
    "signing",
    "code-sign",
    "code-signing",
    "unsigned",
    "certificate",
    "certificates",
    "smartscreen",
    "exciting",
    "amazing",
    "proudly",
)

RELEASED_LINE = re.compile(r"^\*Released .*\*$")


def extract(changelog: str, version: str) -> str:
    """The notes for `version`, footer appended.

    Raises ValueError when `version` is not a release version, or the section
    is missing, empty, carries a banned term, or carries a `### Remaining`
    heading (private-repo only).
    """
    if not _release_version().is_release_version(version):
        raise ValueError(f"'{version}' is neither a YYYY.MDD.N nor a 1.x.y release version")
    lines = changelog.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    heading = f"## {version}"
    try:
        start = lines.index(heading)
    except ValueError:
        raise ValueError(f"CHANGELOG.md carries no `{heading}` section") from None
    body: list[str] = []
    for line in lines[start + 1:]:
        if line.startswith("## "):
            break
        body.append(line)
    # Everything after the `*Released ...*` line is the notes; a section with
    # no such line contributes its whole body.
    for i, line in enumerate(body):
        if RELEASED_LINE.match(line.strip()):
            body = body[i + 1:]
            break
    notes = "\n".join(body).strip()
    if not notes:
        raise ValueError(f"the `{heading}` section of CHANGELOG.md is empty")
    for line in notes.split("\n"):
        if re.match(r"^#{2,}\s+Remaining\b", line.strip(), re.IGNORECASE):
            raise ValueError(
                f"the `{heading}` section carries a `Remaining` heading; "
                "open items never ship in public release notes"
            )
    lowered = notes.lower()
    for term in BANNED:
        if re.search(rf"(?<![\w-]){re.escape(term)}(?![\w-])", lowered):
            raise ValueError(
                f"the `{heading}` section of CHANGELOG.md carries the banned "
                f"term {term!r}"
            )
    return f"{notes}\n\n{FOOTER}"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("version", help="version without a leading `v`, e.g. 2026.1004.151")
    parser.add_argument(
        "--changelog",
        default=str(Path(__file__).resolve().parents[1] / "CHANGELOG.md"),
    )
    args = parser.parse_args(argv)
    text = Path(args.changelog).read_text(encoding="utf-8")
    try:
        notes = extract(text, args.version)
    except ValueError as exc:
        print(f"release notes: {exc}", file=sys.stderr)
        return 1
    sys.stdout.buffer.write(notes.encode("utf-8") + b"\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
