"""MAINTENANCE TOOL, not a build step. Fetches the GWG Processing Steps Test
Suite v1.0 once, at a pinned archive digest, into the gitignored
`processing-steps-corpus/`.

WHAT THIS IS NOT

Passing the internal gate this corpus feeds is REGRESSION EVIDENCE ONLY. It is
never a conformance certification, and it is not an ISO 19593-1 conformance
claim: the Ghent Workgroup runs a certification programme with its own process
and this repository is not in it, and the standard itself is not held here at
all. No output of this script, and no test that consumes it, may be described
as certified or as conforming.

WHY THE CORPUS IS NEVER COMMITTED

Same posture as `ghent-corpus/`, `pdfa-corpus/` and `pdfa/`: the suite is
published by the Ghent Workgroup for testing workflow setup, this repository is
public and the product is commercial, and a commit here would be a
redistribution under terms nobody has obtained. The archive is fetched onto a
developer's disk and stays there. Moving that line needs written permission
from the Ghent Workgroup, not a re-reading of a download page.

WHAT IS FETCHED

  suite — 39 test patches, each exercising one detail of the specification,
          plus the suite's own documentation stating each patch's expected
          verdict. The patch file names carry the verdict: a name ending `G`
          must be accepted, `E` must be rejected, `W` is compliant but
          notable.

Pinned by SHA-256 of the archive AND by a per-file manifest of the extracted
tree, so a future GWG revision is a deliberate re-pin rather than silent
drift. A pin moves only by editing this file.

Run: .venv/Scripts/python.exe scripts/fetch-processing-steps-suite.py
     .venv/Scripts/python.exe scripts/fetch-processing-steps-suite.py --check
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import shutil
import sys
import urllib.request
import zipfile
from datetime import date
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEST = REPO_ROOT / "processing-steps-corpus"
MANIFEST = DEST / "manifest.json"

#: The committed pin. `sha256` is the archive digest recorded the first time
#: this ran; `None` means "unpinned — record what arrives and print it", which
#: is only ever the state of a NEW source being added here.
SOURCES = [
    {
        "key": "suite",
        "package": 19518,
        "page": "https://gwg.org/download/processing-steps-test-suite-v1-0/",
        "sha256": "49a2da6c37a0f433596be826d9fe9190f69033023395589de824d89b6ed7e34b",
        "into": "suite",
    },
]

DOWNLOAD = "https://gwg.org/?wpdmdl={package}"


def _download(source: dict) -> bytes:
    request = urllib.request.Request(
        DOWNLOAD.format(package=source["package"]),
        headers={"User-Agent": "spectra-pdf-corpus-fetch", "Referer": source["page"]},
    )
    with urllib.request.urlopen(request, timeout=600) as response:
        kind = (response.headers.get("Content-Type") or "").split(";")[0].strip()
        if kind != "application/zip":
            raise RuntimeError(f"{source['key']}: expected a zip, server sent {kind!r}")
        return response.read()


def _extract(archive: bytes, into: Path) -> list[dict]:
    """Unpack the zip into `into`, returning a per-file manifest.

    Every member path is resolved against the destination before anything is
    written: a zip entry names its own path, and an archive is untrusted input
    however reputable its origin.
    """
    if into.exists():
        shutil.rmtree(into)
    into.mkdir(parents=True)
    root = into.resolve()
    files: list[dict] = []
    with zipfile.ZipFile(io.BytesIO(archive)) as zf:
        for member in zf.infolist():
            if member.is_dir():
                continue
            name = member.filename.replace("\\", "/")
            if name.startswith("__MACOSX/") or Path(name).name.startswith("._"):
                continue
            target = (into / name).resolve()
            if root not in target.parents and target != root:
                raise RuntimeError(f"archive member escapes the destination: {name}")
            target.parent.mkdir(parents=True, exist_ok=True)
            payload = zf.read(member)
            target.write_bytes(payload)
            files.append(
                {
                    "path": str(target.relative_to(root)).replace("\\", "/"),
                    "bytes": len(payload),
                    "sha256": hashlib.sha256(payload).hexdigest(),
                }
            )
    files.sort(key=lambda entry: entry["path"])
    return files


def _check() -> int:
    if not MANIFEST.is_file():
        print("processing-steps-corpus/manifest.json is absent — the corpus is not fetched")
        return 1
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    bad = 0
    for source in manifest["sources"]:
        into = DEST / source["into"]
        missing = 0
        altered = 0
        for entry in source["files"]:
            path = into / entry["path"]
            if not path.is_file():
                missing += 1
                continue
            if hashlib.sha256(path.read_bytes()).hexdigest() != entry["sha256"]:
                altered += 1
        state = "ok" if not (missing or altered) else f"{missing} missing, {altered} altered"
        bad += missing + altered
        print(f"{source['key']:>10}  {len(source['files']):>4} files  {state}")
    return 1 if bad else 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Fetch the GWG Processing Steps Test Suite v1.0."
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="verify what is on disk against the manifest and exit",
    )
    parser.add_argument(
        "--repin",
        action="store_true",
        help="accept and print a changed archive digest instead of failing",
    )
    args = parser.parse_args()

    if args.check:
        return _check()

    DEST.mkdir(parents=True, exist_ok=True)
    recorded = []
    for source in SOURCES:
        print(f"fetching {source['key']} (package {source['package']})")
        archive = _download(source)
        digest = hashlib.sha256(archive).hexdigest()
        expected = source["sha256"]
        if expected is None:
            print(f"  UNPINNED — record this digest in SOURCES: {digest}")
        elif digest != expected:
            if not args.repin:
                print(
                    f"  archive digest changed: expected {expected}, got {digest}.\n"
                    "  A GWG revision is a deliberate re-pin: re-read the suite's "
                    "documentation, update the expected-results table, then run "
                    "with --repin and edit SOURCES.",
                    file=sys.stderr,
                )
                return 1
            print(f"  RE-PIN: {digest}")
        files = _extract(archive, DEST / source["into"])
        pdfs = sum(1 for entry in files if entry["path"].lower().endswith(".pdf"))
        recorded.append(
            {
                "key": source["key"],
                "page": source["page"],
                "package": source["package"],
                "into": source["into"],
                "archive_bytes": len(archive),
                "archive_sha256": digest,
                "licence": "USE-ONLY (GWG publication) — not redistributable, never commit",
                "files": files,
            }
        )
        print(f"  {len(files)} files, {pdfs} PDFs -> processing-steps-corpus/{source['into']}")

    MANIFEST.write_text(
        json.dumps(
            {
                "fetched": date.today().isoformat(),
                "suite": "GWG Processing Steps Test Suite v1.0",
                "note": (
                    "Published by the Ghent Workgroup for testing workflow "
                    "setup. This directory is gitignored and must never be "
                    "committed or shipped. Passing the gate that reads it is "
                    "internal regression evidence, never a Ghent Workgroup "
                    "certification and never an ISO 19593-1 conformance claim."
                ),
                "sources": recorded,
            },
            indent=2,
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
