#!/usr/bin/env python3
"""The platforms a release builds, read from `.github/release-platforms.txt`.

One platform name per line. `windows` is always listed; `linux` adds the Linux
packages to the release run, the redo of a tag that lists it, and the local
CI-parity battery. The file is read from the release's own tree, so a redo of
a tag rebuilds exactly the platform set that tag was released with. A tree
without the file is Windows-only.

  release_platforms.py [--root DIR | --rev REV] [--github-output]

Prints `linux=true` or `linux=false`; with --github-output the same line is
appended to $GITHUB_OUTPUT. Exit 1 when the file is malformed.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

PLATFORMS_FILE = ".github/release-platforms.txt"
KNOWN = ("windows", "linux")


def parse(text: str) -> set[str]:
    names = [line.strip() for line in text.replace("\r\n", "\n").split("\n") if line.strip()]
    unknown = [n for n in names if n not in KNOWN]
    if unknown:
        raise ValueError(f"{PLATFORMS_FILE}: unknown platform {unknown[0]!r} (known: {', '.join(KNOWN)})")
    if len(set(names)) != len(names):
        raise ValueError(f"{PLATFORMS_FILE}: a platform is listed twice")
    if "windows" not in names:
        raise ValueError(f"{PLATFORMS_FILE}: 'windows' is not listed")
    return set(names)


def read(root: Path | None = None, rev: str | None = None) -> set[str]:
    if rev is not None:
        # Only a file absent from an existing commit means Windows-only; an
        # unreadable revision or a failed read is an error, never a default.
        def git(*args: str) -> subprocess.CompletedProcess:
            return subprocess.run(["git", *args], cwd=root, capture_output=True, text=True)

        commit = git("rev-parse", "--verify", "--quiet", f"{rev}^{{commit}}")
        if commit.returncode != 0:
            raise ValueError(f"git cannot resolve the revision {rev!r}: {commit.stderr.strip()}")
        if git("cat-file", "-e", f"{rev}:{PLATFORMS_FILE}").returncode != 0:
            return {"windows"}
        shown = git("show", f"{rev}:{PLATFORMS_FILE}")
        if shown.returncode != 0:
            raise ValueError(f"git show {rev}:{PLATFORMS_FILE} failed: {shown.stderr.strip()}")
        return parse(shown.stdout)
    path = (root or Path(__file__).resolve().parents[1]) / PLATFORMS_FILE
    if not path.is_file():
        return {"windows"}
    return parse(path.read_text(encoding="utf-8"))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--root", type=Path)
    parser.add_argument("--rev")
    parser.add_argument("--github-output", action="store_true")
    args = parser.parse_args(argv)
    try:
        platforms = read(args.root, args.rev)
    except ValueError as exc:
        print(f"release platforms: {exc}", file=sys.stderr)
        return 1
    line = f"linux={'true' if 'linux' in platforms else 'false'}"
    print(line)
    if args.github_output:
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as out:
            out.write(line + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
