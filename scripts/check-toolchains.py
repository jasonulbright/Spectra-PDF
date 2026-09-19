#!/usr/bin/env python3
"""Refuses a local gate run on a toolchain other than the one CI installs.

Usage: check-toolchains.py rust|python|node

A gate that passes here is evidence about CI only when it ran on the toolchain
CI installs on every run. Each check reads what CI reads, compares it with
what runs here, and fails closed when any version source cannot be read.

rust    CI: `dtolnay/rust-toolchain@stable`. The toolchain active for
        src-tauri is `stable-<host>` (no directory override, toolchain file
        or RUSTUP_TOOLCHAIN selects another), and `rustup check` reports no
        update for it.
python  CI and the shipped runtime (scripts/setup-python-embed.ps1) read
        `.python-version`. The .venv interpreter is that pin, and the pin is
        the newest final release of its minor that python.org lists.
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
NODE_RELEASES = "https://nodejs.org/dist/index.json"

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


def newest_python(releases: object, major: int, minor: int) -> str:
    """The newest final `major.minor.N` in python.org's release list, or ""."""
    found = []
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
            found.append(numbers)
    return ".".join(str(part) for part in max(found)) if found else ""


def python_verdict(pin: Fetched, venv: Answer, releases: Fetched) -> tuple:
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
    newest = newest_python(releases.value, int(exact[1]), int(exact[2]))
    problems = []
    if not newest:
        problems.append(
            f"python.org lists no final {exact[1]}.{exact[2]} release"
            f" ({releases.error or 'none in its release list'})."
        )
    if not local:
        problems.append(f"the .venv interpreter did not report its version ({_shown(venv)}).")
    if problems:
        return False, _refusal(problems, local or "unknown", newest or "unknown", "rerun once "
                               "python.org and .venv answer; nothing is compared without them")

    pin_text = exact[0]
    if pin_text != newest:
        return False, _refusal(
            [f".python-version pins {pin_text}; python.org's newest {exact[1]}.{exact[2]} "
             f"release is {newest}."],
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
    return True, [f"OK: .venv runs Python {local}, the pin and python.org's newest release"]


def _venv_python() -> Path:
    windows = ROOT / ".venv" / "Scripts" / "python.exe"
    return windows if windows.exists() else ROOT / ".venv" / "bin" / "python"


def check_python() -> tuple:
    return python_verdict(
        read_pin(PYTHON_PIN),
        run(str(_venv_python()), "-B", "-c",
            "import sys; print('%d.%d.%d' % sys.version_info[:3])"),
        fetch_json(PYTHON_RELEASES),
    )


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


CHECKS = {"rust": check_rust, "python": check_python, "node": check_node}


def main(argv: list) -> int:
    if len(argv) != 1 or argv[0] not in CHECKS:
        print(f"usage: check-toolchains.py {'|'.join(CHECKS)}", file=sys.stderr)
        return 2
    passed, lines = CHECKS[argv[0]]()
    print("\n".join(lines))
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
