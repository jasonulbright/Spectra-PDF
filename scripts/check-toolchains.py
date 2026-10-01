#!/usr/bin/env python3
"""Refuses a local gate run on a toolchain other than the one CI installs.

Usage: check-toolchains.py rust|python|python-linux|node

A gate that passes here is evidence about CI only when it ran on the toolchain
CI installs on every run. Each check reads what CI reads, compares it with
what runs here, and fails closed when any version source cannot be read.

rust    CI: `dtolnay/rust-toolchain@stable`. The toolchain active for
        src-tauri is `stable-<host>` (no directory override, toolchain file
        or RUSTUP_TOOLCHAIN selects another), and `rustup check` reports no
        update for it.
python  CI and the shipped runtime (scripts/setup-python-embed.ps1) read
        `.python-version`. The .venv interpreter is that pin, and the pin is
        the newest final release of its minor that python.org lists AND
        actions/setup-python offers for win32 x64 (the audit job's runner):
        a pin setup-python cannot install fails every CI run. A python.org
        release the manifest does not carry yet passes with a note.
python-linux
        The Linux runtime (scripts/setup-python-embed.sh) comes from
        python-build-standalone, which publishes a CPython patch after
        python.org. Its pin is the same minor as `.python-version` at the same
        or a lower patch, and it is the newest CPython of that minor, at or
        below `.python-version`, in the newest python-build-standalone
        release. A newer matching build fails the check until the pin moves.
node    CI reads the major from `.node-version`, with `check-latest`. Local
        Node is the newest release of that major in nodejs.org/dist/index.json,
        and local npm is the npm that release bundles.

The `rustup check` line forms are rustup's own (1.29.1: `check_updates` in
src/cli/rustup_mode.rs, pinned by tests/suite/cli_exact.rs):

    stable-<host> - up to date: <version>
    stable-<host> - update available: <installed> -> <newest>

Any other line for that toolchain, no line for it, or an exit status other
than 0 or 100 (100: some channel has an update) fails closed.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import urllib.request
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CRATE = ROOT / "src-tauri"
PYTHON_PIN = ROOT / ".python-version"
NODE_PIN = ROOT / ".node-version"
PYTHON_RELEASES = "https://www.python.org/api/v2/downloads/release/?is_published=true"
SETUP_PYTHON_MANIFEST = (
    "https://raw.githubusercontent.com/actions/python-versions/main/versions-manifest.json"
)
NODE_RELEASES = "https://nodejs.org/dist/index.json"
LINUX_EMBED = ROOT / "scripts" / "setup-python-embed.sh"
PBS_LATEST = "https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest"
PBS_ASSET = re.compile(
    r"^cpython-(\d+)\.(\d+)\.(\d+)\+(\d+)-x86_64-unknown-linux-gnu-install_only_stripped\.tar\.gz$"
)
LINUX_PIN = re.compile(r'^PBS_(RELEASE|PINNED_VERSION)="([^"]*)"$', re.M)

#: `rustup check` exits with this when at least one channel has an update.
UPDATES_AVAILABLE = 100

ACTIVE = re.compile(r"^(?P<name>\S+) \((?P<reason>.+)\)$")
HOST = re.compile(r"^host: (?P<host>\S+)$", re.M)
UP_TO_DATE = re.compile(r"^(?P<name>\S+) - up to date: (?P<installed>.+)$")
UPDATE_AVAILABLE = re.compile(
    r"^(?P<name>\S+) - update available: (?P<installed>.+) -> (?P<newest>.+)$"
)
EXACT = re.compile(r"^(\d+)\.(\d+)\.(\d+)$")
FINAL_PYTHON = re.compile(r"^Python (\d+)\.(\d+)\.(\d+)$")
NODE_VERSION = re.compile(r"^v(\d+)\.(\d+)\.(\d+)$")


@dataclass(frozen=True)
class Answer:
    """One command's exit status and its output streams, verbatim."""

    status: int
    stdout: str
    stderr: str = ""


@dataclass(frozen=True)
class Fetched:
    """A version source read from disk or the network: its value, or why not."""

    value: object = None
    error: str = ""


def run(*args: str, cwd: Path = ROOT) -> Answer:
    # Auto-install off: a check must never download the toolchain an
    # override names. Colour off: the line forms above carry no escapes.
    env = dict(os.environ, RUSTUP_AUTO_INSTALL="0", RUSTUP_TERM_COLOR="never")
    program = shutil.which(args[0]) or args[0]
    try:
        done = subprocess.run(
            [program, *args[1:]],
            cwd=cwd,
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            stdin=subprocess.DEVNULL,
        )
    except OSError as exc:
        return Answer(127, "", f"{args[0]}: {exc}")
    return Answer(done.returncode, done.stdout, done.stderr)


def fetch_json(url: str) -> Fetched:
    try:
        with urllib.request.urlopen(url, timeout=60) as response:
            return Fetched(json.load(response))
    except (OSError, ValueError) as exc:
        return Fetched(error=f"{url}: {exc}")


def read_pin(path: Path) -> Fetched:
    try:
        words = path.read_text(encoding="utf-8").split()
    except OSError as exc:
        return Fetched(error=f"{path.name}: {exc}")
    return Fetched(words[0]) if words else Fetched(error=f"{path.name} is empty")


def _first_line(text: str) -> str:
    return next((line.strip() for line in text.splitlines() if line.strip()), "")


def _shown(answer: Answer) -> str:
    text = (answer.stdout + answer.stderr).strip() or "(no output)"
    return f"exit {answer.status}: {text}"


def _refusal(problems: list, local: str, expected: str, fix: str) -> list:
    return [
        *(f"FAIL: {problem}" for problem in problems),
        f"Local version: {local}",
        f"Expected version: {expected}",
        f"Fix: {fix}",
    ]


# ── Rust ─────────────────────────────────────────────────────────────────────

RUST_FIX = "rustup update stable"


def rust_verdict(active: Answer, rustc: Answer, check: Answer) -> tuple:
    """(passed, the lines to print)."""
    named = ACTIVE.match(_first_line(active.stdout)) if active.status == 0 else None
    host = HOST.search(rustc.stdout) if rustc.status == 0 else None
    local = _first_line(rustc.stdout) if host else "unknown"
    problems = []
    if named is None:
        problems.append(f"rustup show active-toolchain named no toolchain ({_shown(active)}).")
    if host is None:
        problems.append(f"rustc -vV reported no host ({_shown(rustc)}).")
    if problems:
        return False, _refusal(problems, local, "unknown", RUST_FIX)

    stable = f"stable-{host['host']}"
    line = next(
        (row.strip() for row in check.stdout.splitlines() if row.startswith(f"{stable} - ")),
        None,
    )
    stale = UPDATE_AVAILABLE.match(line) if line is not None else None
    current = UP_TO_DATE.match(line) if line is not None else None
    if check.status not in (0, UPDATES_AVAILABLE) or (stale is None and current is None):
        problems.append(f"rustup check gave no recognizable line for {stable} ({_shown(check)}).")
        return False, _refusal(problems, local, "unknown", RUST_FIX)

    newest = stale["newest"] if stale else current["installed"]
    fix = RUST_FIX
    if named["name"] != stable:
        problems.append(
            f"src-tauri builds with {named['name']} ({named['reason']}), "
            f"not {stable}, which CI installs on every run."
        )
        fix = f"remove that override, then run: {RUST_FIX}"
    if stale:
        problems.append(f"{stable} has an update; CI installs the newest stable on every run.")
    if problems:
        return False, _refusal(problems, local, newest, fix)
    return True, [f"OK: src-tauri builds with {stable}, up to date: {newest}"]


def check_rust() -> tuple:
    return rust_verdict(
        run("rustup", "show", "active-toolchain", cwd=CRATE),
        run("rustc", "-vV", cwd=CRATE),
        run("rustup", "check", "--no-self-update", cwd=CRATE),
    )


# ── Python ───────────────────────────────────────────────────────────────────


def python_finals(releases: object, major: int, minor: int) -> set:
    """The final `major.minor.N` versions in python.org's release list."""
    found = set()
    for release in releases if isinstance(releases, list) else []:
        if not isinstance(release, dict):
            continue
        name = FINAL_PYTHON.match(str(release.get("name", "")))
        if not name or release.get("pre_release") is not False:
            continue
        if release.get("is_published") is not True:
            continue
        numbers = tuple(int(part) for part in name.groups())
        if numbers[:2] == (major, minor):
            found.add(numbers)
    return found


def setup_python_offers(manifest: object, major: int, minor: int) -> set:
    """The stable `major.minor.N` versions actions/setup-python installs on win32 x64."""
    found = set()
    for entry in manifest if isinstance(manifest, list) else []:
        if not isinstance(entry, dict) or entry.get("stable") is not True:
            continue
        version = EXACT.match(str(entry.get("version", "")))
        if not version:
            continue
        files = entry.get("files")
        if not any(
            isinstance(row, dict) and row.get("platform") == "win32" and row.get("arch") == "x64"
            for row in files if isinstance(files, list)
        ):
            continue
        numbers = tuple(int(part) for part in version.groups())
        if numbers[:2] == (major, minor):
            found.add(numbers)
    return found


def _dotted(numbers: tuple) -> str:
    return ".".join(str(part) for part in numbers)


def python_verdict(pin: Fetched, venv: Answer, releases: Fetched, manifest: Fetched) -> tuple:
    exact = EXACT.match(str(pin.value or ""))
    local = venv.stdout.strip() if venv.status == 0 and EXACT.match(venv.stdout.strip()) else ""
    if exact is None:
        detail = pin.error or f".python-version holds {pin.value!r}, not major.minor.patch"
        return False, _refusal(
            [f"the Python pin cannot be read: {detail}."],
            local or "unknown",
            "unknown",
            "write the exact version CI and the shipped runtime use into .python-version",
        )
    minor = f"{exact[1]}.{exact[2]}"
    finals = python_finals(releases.value, int(exact[1]), int(exact[2]))
    released = _dotted(max(finals)) if finals else ""
    offered = setup_python_offers(manifest.value, int(exact[1]), int(exact[2]))
    problems = []
    if not released:
        problems.append(
            f"python.org lists no final {minor} release"
            f" ({releases.error or 'none in its release list'})."
        )
    if not offered:
        problems.append(
            f"actions/setup-python offers no stable {minor} release for win32 x64"
            f" ({manifest.error or 'none in its manifest'})."
        )
    if not local:
        problems.append(f"the .venv interpreter did not report its version ({_shown(venv)}).")
    if problems:
        return False, _refusal(problems, local or "unknown", released or "unknown", "rerun once "
                               "python.org, the setup-python manifest and .venv answer; "
                               "nothing is compared without them")

    both = finals & offered
    newest = _dotted(max(both)) if both else ""
    if not newest:
        return False, _refusal(
            [f"no {minor} release is both final on python.org and offered by "
             "actions/setup-python."],
            local, "unknown", "rerun once python.org and the setup-python manifest share a "
            f"{minor} release",
        )
    pending = [f"NOTE: python {released} released; pinned {newest} until "
               "actions/setup-python offers it"] if released != newest else []

    pin_text = exact[0]
    if pin_text != newest:
        return False, _refusal(
            [f".python-version pins {pin_text}; the newest {minor} release python.org and "
             f"actions/setup-python both offer is {newest}."],
            local,
            newest,
            f"set .python-version to {newest} and $ExpectedSha256 in "
            "scripts/setup-python-embed.ps1 to the SHA-256 python.org publishes for "
            f"python-{newest}-embed-amd64.zip, then run scripts/setup-python-embed.ps1",
        )
    if local != pin_text:
        return False, _refusal(
            [f".venv runs Python {local}; CI and the shipped runtime run {pin_text}."],
            local,
            pin_text,
            f"install Python {pin_text} from python.org, run: py -{exact[1]}.{exact[2]} -m venv "
            "--clear .venv, then install scripts/python-requirements.txt, the vendored wheels "
            "and pytest into it as CI does",
        )
    return True, [f"OK: .venv runs Python {local}, the pin and the newest release python.org "
                  "and actions/setup-python both offer", *pending]


def _venv_python() -> Path:
    windows = ROOT / ".venv" / "Scripts" / "python.exe"
    return windows if windows.exists() else ROOT / ".venv" / "bin" / "python"


def check_python() -> tuple:
    return python_verdict(
        read_pin(PYTHON_PIN),
        run(str(_venv_python()), "-B", "-c",
            "import sys; print('%d.%d.%d' % sys.version_info[:3])"),
        fetch_json(PYTHON_RELEASES),
        fetch_json(SETUP_PYTHON_MANIFEST),
    )


# ── Linux Python runtime ─────────────────────────────────────────────────────


def read_linux_pin(path: Path) -> Fetched:
    """`{"release": ..., "version": ...}` from setup-python-embed.sh."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        return Fetched(error=f"{path.name}: {exc}")
    found = dict(LINUX_PIN.findall(text))
    if set(found) != {"RELEASE", "PINNED_VERSION"}:
        return Fetched(error=f"{path.name} names no PBS_RELEASE and PBS_PINNED_VERSION pair")
    return Fetched({"release": found["RELEASE"], "version": found["PINNED_VERSION"]})


def pbs_builds(release: object) -> dict:
    """`{(major, minor, patch): sha256 or ""}` of one release's Linux x86-64 builds."""
    found = {}
    assets = release.get("assets") if isinstance(release, dict) else None
    for asset in assets if isinstance(assets, list) else []:
        if not isinstance(asset, dict):
            continue
        name = PBS_ASSET.match(str(asset.get("name", "")))
        if not name or name[4] != str(release.get("tag_name", "")):
            continue
        digest = str(asset.get("digest") or "")
        found[tuple(int(part) for part in name.groups()[:3])] = (
            digest[len("sha256:"):] if digest.startswith("sha256:") else ""
        )
    return found


def python_linux_verdict(pin: Fetched, linux: Fetched, latest: Fetched) -> tuple:
    exact = EXACT.match(str(pin.value or ""))
    linux_pin = linux.value if isinstance(linux.value, dict) else {}
    pinned = EXACT.match(str(linux_pin.get("version", "")))
    shown = linux_pin.get("version") or "unknown"
    problems = []
    if exact is None:
        problems.append(f"the Python pin cannot be read: "
                        f"{pin.error or f'.python-version holds {pin.value!r}'}.")
    if pinned is None:
        problems.append(f"the Linux runtime pin cannot be read: "
                        f"{linux.error or f'PBS_PINNED_VERSION is {shown!r}'}.")
    tag = str(latest.value.get("tag_name", "")) if isinstance(latest.value, dict) else ""
    if not tag:
        problems.append(f"python-build-standalone's newest release cannot be read "
                        f"({latest.error or 'it names no tag'}).")
    if problems:
        return False, _refusal(problems, shown, "unknown", "rerun once .python-version, "
                               "scripts/setup-python-embed.sh and the python-build-standalone "
                               "release list answer; nothing is compared without them")

    target = tuple(int(part) for part in exact.groups())
    local = tuple(int(part) for part in pinned.groups())
    minor = f"{target[0]}.{target[1]}"
    if local[:2] != target[:2] or local[2] > target[2]:
        return False, _refusal(
            [f"the Linux runtime pins {_dotted(local)}; it must be Python {minor} at "
             f"{exact[0]} or a lower patch."],
            _dotted(local), f"{minor}.x <= {exact[0]}",
            "set PBS_RELEASE, PBS_PINNED_VERSION and both SHA-256 values in "
            "scripts/setup-python-embed.sh to a python-build-standalone build of "
            f"Python {minor}",
        )
    builds = {v: sha for v, sha in pbs_builds(latest.value).items()
              if v[:2] == target[:2] and v[2] <= target[2]}
    if not builds:
        return False, _refusal(
            [f"python-build-standalone {tag} carries no Linux x86-64 build of Python "
             f"{minor} at or below {exact[0]}."],
            _dotted(local), "unknown",
            "rerun once python-build-standalone publishes a matching build",
        )
    newest = max(builds)
    if local != newest:
        digest = f" (install_only_stripped SHA-256 {builds[newest]})" if builds[newest] else ""
        return False, _refusal(
            [f"the Linux runtime pins {_dotted(local)}; python-build-standalone {tag} "
             f"carries {_dotted(newest)}{digest}."],
            _dotted(local), _dotted(newest),
            f"set PBS_RELEASE to {tag}, PBS_PINNED_VERSION to {_dotted(newest)} and both "
            "SHA-256 values (install_only_stripped and pgo+lto-full) in "
            "scripts/setup-python-embed.sh, then run it",
        )
    lag = ([f"NOTE: the Linux runtime trails .python-version ({exact[0]}) until "
            f"python-build-standalone publishes it"] if local != target else [])
    return True, [f"OK: the Linux runtime pins Python {_dotted(local)}, the newest {minor} "
                  f"build at or below {exact[0]} in python-build-standalone {tag}", *lag]


def check_python_linux() -> tuple:
    return python_linux_verdict(read_pin(PYTHON_PIN), read_linux_pin(LINUX_EMBED),
                                fetch_json(PBS_LATEST))


# ── Node and npm ─────────────────────────────────────────────────────────────


def newest_node(index: object, major: int) -> dict:
    """The newest `v<major>.x.y` row of nodejs.org/dist/index.json, or {}."""
    best: tuple = ()
    row: dict = {}
    for release in index if isinstance(index, list) else []:
        if not isinstance(release, dict):
            continue
        version = NODE_VERSION.match(str(release.get("version", "")))
        if not version or int(version[1]) != major or not release.get("npm"):
            continue
        numbers = tuple(int(part) for part in version.groups())
        if numbers > best:
            best, row = numbers, release
    return row


def node_verdict(pin: Fetched, node: Answer, npm: Answer, index: Fetched) -> tuple:
    major = str(pin.value or "")
    local_node = node.stdout.strip() if node.status == 0 else ""
    local_npm = npm.stdout.strip() if npm.status == 0 else ""
    if not major.isdigit():
        detail = pin.error or f".node-version holds {pin.value!r}, not a major version"
        return False, _refusal(
            [f"the Node pin cannot be read: {detail}."],
            local_node or "unknown",
            "unknown",
            "write the Node major CI installs into .node-version",
        )
    release = newest_node(index.value, int(major))
    problems = []
    if not release:
        problems.append(
            f"nodejs.org lists no v{major} release ({index.error or 'none in index.json'})."
        )
    if not NODE_VERSION.match(local_node):
        problems.append(f"node --version did not answer ({_shown(node)}).")
    if not local_npm:
        problems.append(f"npm --version did not answer ({_shown(npm)}).")
    if problems:
        return False, _refusal(problems, local_node or "unknown",
                               release.get("version", "unknown"),
                               "rerun once nodejs.org, node and npm answer")

    newest, bundled = release["version"], release["npm"]
    lines = []
    if local_node != newest:
        local_major = NODE_VERSION.match(local_node)[1]
        why = (f"local Node is major {local_major}; CI installs major {major}"
               if local_major != major else f"CI installs the newest v{major} release")
        lines += _refusal(
            [f"{why}."],
            local_node,
            newest,
            f"install Node.js {newest} from https://nodejs.org/dist/{newest}/"
            f"node-{newest}-x64.msi",
        )
    if local_npm != bundled:
        lines += _refusal(
            [f"local npm is {local_npm}; Node.js {newest} bundles npm {bundled}, which CI runs."],
            local_npm,
            bundled,
            f"npm install --global npm@{bundled}",
        )
    if lines:
        return False, lines
    return True, [f"OK: Node.js {local_node} and npm {local_npm}, the newest v{major} release"]


def check_node() -> tuple:
    return node_verdict(
        read_pin(NODE_PIN),
        run("node", "--version"),
        run("npm", "--version"),
        fetch_json(NODE_RELEASES),
    )


CHECKS = {
    "rust": check_rust,
    "python": check_python,
    "python-linux": check_python_linux,
    "node": check_node,
}


def main(argv: list) -> int:
    if len(argv) != 1 or argv[0] not in CHECKS:
        print(f"usage: check-toolchains.py {'|'.join(CHECKS)}", file=sys.stderr)
        return 2
    passed, lines = CHECKS[argv[0]]()
    print("\n".join(lines))
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
