"""MAINTENANCE TOOL, not a build step. Fetches the public PDF/A conformance
suites once, at pinned commits, into the gitignored `pdfa-corpus/`.

WHY THE CORPUS IS NEVER COMMITTED AND NEVER SHIPPED

Neither upstream declares a licence — the GitHub licence field is null for
both, and neither tree carries a LICENSE file. Redistribution terms we cannot
read are terms we cannot satisfy, so the files are fetched onto a developer's
disk and stay there. This repository is public; a commit here republishes them.
The same rule already governs `pdfa/`, and it is the reason this is a fetch
script rather than a vendored directory.

WHAT THE CORPUS IS FOR, AND WHAT IT IS NOT FOR

It is a SCOREBOARD, not a target. Passing every file would mean agreeing with
the judgement of whoever authored the files, which is not the same as
implementing the clause — BFO's own notes mark two cases *contentious*, where
implementations legitimately disagree. So the scoreboard records what this
product does against each stated rule, and a file we pass that no stated rule
explains is flagged rather than counted.

A claim sourced this way is worded "corroborated by two independent conformance
suites at clause X". It is never worded "the standard requires", because the
standard is ISO 19005 and this repository does not hold it (see `docs/README.md`
for what `pdfa/` does hold). Where the normative text IS on disk, it outranks
every file here.

WHAT IS FETCHED

  bfocom/pdfa-testsuite   — one flat directory plus `description.txt`, which
                            states the RULE per file ("More than 28 q/Q nests",
                            "Embedded file is not PDF/A") and marks the
                            relaxations between PDF/A-1 and PDF/A-2.
  veraPDF/veraPDF-corpus  — organised as the standard's own table of contents
                            (`PDF_A-1b/6.1 File structure/6.1.2 File header/…`),
                            and it bundles the Isartor suite under
                            `Isartor test files/`.

Both are pinned by commit SHA below. A pin moves only by editing this file, so
what the scoreboard measured is always recoverable.

Run: .venv/Scripts/python.exe scripts/fetch-pdfa-corpus.py
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import shutil
import sys
import tarfile
import urllib.request
from datetime import date
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEST = REPO_ROOT / "pdfa-corpus"

# Pinned sources. `sha` is the commit the tarball is taken at; `into` is the
# directory name under `pdfa-corpus/`.
SOURCES = [
    {
        "owner": "bfocom",
        "repo": "pdfa-testsuite",
        "sha": "c22d80260c7ec975a511f9bfcc6590b7ceb1cf18",
        "into": "bfo",
    },
    {
        "owner": "veraPDF",
        "repo": "veraPDF-corpus",
        "sha": "49de56cd987929932c9e4fbbbe67d052bf44ef83",
        "into": "verapdf",
    },
]

TARBALL = "https://codeload.github.com/{owner}/{repo}/tar.gz/{sha}"


def _download(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "spectra-pdf-corpus-fetch"})
    with urllib.request.urlopen(request, timeout=300) as response:
        return response.read()


def _extract(archive: bytes, into: Path) -> int:
    """Unpack the tarball's single top-level directory into `into`.

    Every member path is checked against the destination before anything is
    written: a tar entry names its own path, and an archive is untrusted input
    however reputable its origin.
    """
    if into.exists():
        shutil.rmtree(into)
    into.mkdir(parents=True)
    count = 0
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tar:
        for member in tar.getmembers():
            if not member.isfile():
                continue
            parts = Path(member.name).parts[1:]  # drop the `repo-sha/` prefix
            if not parts:
                continue
            target = (into / Path(*parts)).resolve()
            if not str(target).startswith(str(into.resolve())):
                raise RuntimeError(f"archive member escapes the destination: {member.name}")
            target.parent.mkdir(parents=True, exist_ok=True)
            extracted = tar.extractfile(member)
            if extracted is None:
                continue
            target.write_bytes(extracted.read())
            count += 1
    return count


def _digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="report what is on disk and exit without fetching anything",
    )
    args = parser.parse_args()

    if args.check:
        manifest_path = DEST / "manifest.json"
        if not manifest_path.is_file():
            print("pdfa-corpus/manifest.json is absent — the corpus is not fetched")
            return 1
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        for source in manifest["sources"]:
            print(f"{source['repo']:>16} @ {source['sha'][:12]}  {source['files']} files")
        print(f"{'total':>16}    {manifest['total_files']} files, {manifest['total_pdfs']} PDFs")
        return 0

    DEST.mkdir(parents=True, exist_ok=True)
    recorded = []
    total_files = 0
    total_pdfs = 0

    for source in SOURCES:
        url = TARBALL.format(**source)
        print(f"fetching {source['owner']}/{source['repo']} @ {source['sha'][:12]}")
        archive = _download(url)
        into = DEST / source["into"]
        files = _extract(archive, into)
        pdfs = sorted(p for p in into.rglob("*") if p.is_file() and p.suffix.lower() == ".pdf")
        total_files += files
        total_pdfs += len(pdfs)
        recorded.append(
            {
                "owner": source["owner"],
                "repo": source["repo"],
                "sha": source["sha"],
                "into": source["into"],
                "url": url,
                "archive_sha256": hashlib.sha256(archive).hexdigest(),
                "files": files,
                "pdfs": len(pdfs),
                # The licence position is recorded beside the files themselves
                # so nobody has to go back to the script to find it.
                "licence": "NONE-DECLARED — not redistributable, never commit",
            }
        )
        print(f"  {files} files, {len(pdfs)} PDFs -> {into.relative_to(REPO_ROOT)}")

    manifest = {
        "fetched": date.today().isoformat(),
        "note": (
            "Neither source declares a licence. This directory is gitignored and "
            "must never be committed or shipped. The corpus is a scoreboard, not "
            "a target."
        ),
        "sources": recorded,
        "total_files": total_files,
        "total_pdfs": total_pdfs,
    }
    (DEST / "manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print(f"total {total_files} files, {total_pdfs} PDFs")
    return 0


if __name__ == "__main__":
    sys.exit(main())
