"""Convert a `pip install --report` JSON into a hash-pinned requirements
lockfile. Invoked by scripts/lock-python-deps.ps1 — not run directly in normal
workflows.

Usage: python lockgen.py <pip-report.json> <out-requirements.txt> [platform-label [regenerate-script [install-script]]]
"""

import json
import sys

report_path, out_path = sys.argv[1], sys.argv[2]
platform = sys.argv[3] if len(sys.argv) > 3 else "Windows x86_64"
regenerate = sys.argv[4] if len(sys.argv) > 4 else "scripts/lock-python-deps.ps1"
installer = sys.argv[5] if len(sys.argv) > 5 else "setup-python-embed.ps1"
report = json.load(open(report_path, encoding="utf-8"))

entries = []
for e in report["install"]:
    name = e["metadata"]["name"]
    ver = e["metadata"]["version"]
    hashes = e.get("download_info", {}).get("archive_info", {}).get("hashes", {})
    sha = hashes.get("sha256")
    if not sha:
        raise SystemExit(f"no sha256 hash for {name}=={ver} (non-PyPI source?)")
    entries.append((name, ver, sha))

entries.sort(key=lambda t: t[0].lower())

header = (
    "# Hash-pinned lockfile for the bundled Python engine runtime.\n"
    f"# GENERATED — do not edit by hand. Regenerate with {regenerate}\n"
    "# after changing scripts/python-requirements.in. Installed by\n"
    f"# {installer} via `pip install --require-hashes -r`, so every\n"
    "# transitive dependency (cryptography, lxml, …) is version- and hash-locked,\n"
    f"# not floated at build time. Resolved for CPython 3.14 / {platform}.\n"
    "#\n"
)
lines = [f"{n}=={v} --hash=sha256:{s}" for n, v, s in entries]
with open(out_path, "w", encoding="utf-8", newline="\n") as f:
    f.write(header + "\n".join(lines) + "\n")
print(f"wrote {len(entries)} pinned+hashed packages to {out_path}")
