"""The GitHub credential in the three fetch helpers: scripts/github_auth.py,
`curl_fetch` in scripts/posix-common.sh and `Invoke-DownloadWithRetry -Uri` in
scripts/download-retry.ps1.

Each helper sends `Authorization: Bearer <token>` to a GitHub host, refuses a
GitHub host before any request when no token resolves, sends nothing to any
other host, and never carries the header across a redirect to another host. A local HTTP server stands in for both hosts:
127.0.0.1 plays the GitHub host (each test widens the helper's host check to
it) and `localhost` plays the other host a release-asset redirect lands on.
"""

from __future__ import annotations

import http.server
import os
import re
import shutil
import subprocess
import sys
import threading
import urllib.error
import urllib.request
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
TOKEN = "ghp_TestOnlyCredential0123456789abcdef"

sys.path.insert(0, str(SCRIPTS))
import github_auth  # noqa: E402


class _Recorder(http.server.BaseHTTPRequestHandler):
    seen: list = []

    def do_GET(self) -> None:  # noqa: N802 - http.server's naming
        port = self.server.server_address[1]
        type(self).seen.append((self.path, self.headers.get("Authorization")))
        targets = {
            "/cross": f"http://localhost:{port}/final",
            "/same": f"http://127.0.0.1:{port}/final",
        }
        if self.path in targets:
            self.send_response(302)
            self.send_header("Location", targets[self.path])
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if self.path == "/forbidden":
            body = b"rate limit exceeded"
            self.send_response(403)
        else:
            body = b"ok"
            self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args) -> None:
        pass


@pytest.fixture(scope="module")
def server():
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Recorder)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield httpd.server_address[1]
    httpd.shutdown()
    httpd.server_close()


@pytest.fixture
def seen(server):
    _Recorder.seen = []
    return _Recorder.seen


def _clean_env(**extra: str) -> dict:
    env = {k: v for k, v in os.environ.items() if k not in ("GH_TOKEN", "GITHUB_TOKEN")}
    env.update(extra)
    return env


# ── Python ───────────────────────────────────────────────────────────────────


@pytest.fixture
def py_auth(monkeypatch, server):
    monkeypatch.setattr(github_auth, "SCHEMES", frozenset({"http"}))
    monkeypatch.setattr(github_auth, "GITHUB_HOSTS", frozenset({"127.0.0.1"}))
    monkeypatch.setattr(github_auth, "PORTS", frozenset({server}))
    monkeypatch.setattr(github_auth, "_token", [TOKEN])
    monkeypatch.setattr(github_auth, "_opener", [])
    return github_auth


def _get(module, url: str) -> bytes:
    with module.urlopen(url, timeout=10) as response:
        return response.read()


def test_python_sends_the_token_to_a_github_host(py_auth, server, seen) -> None:
    assert _get(py_auth, f"http://127.0.0.1:{server}/ok") == b"ok"
    assert seen == [("/ok", f"Bearer {TOKEN}")]


def test_python_sends_no_token_to_another_host(py_auth, server, seen) -> None:
    _get(py_auth, f"http://localhost:{server}/ok")
    assert seen == [("/ok", None)]


def test_python_refuses_a_github_host_when_no_token_resolves(py_auth, server, seen,
                                                             monkeypatch) -> None:
    monkeypatch.setattr(github_auth, "_token", [""])
    with pytest.raises(github_auth.MissingCredential) as raised:
        _get(py_auth, f"http://127.0.0.1:{server}/ok")
    assert seen == [], "no anonymous request reaches the GitHub host"
    assert "GH_TOKEN" in str(raised.value) and "gh auth login" in str(raised.value)
    assert "127.0.0.1" in str(raised.value)


def test_python_fetches_another_host_with_no_token(py_auth, server, seen, monkeypatch) -> None:
    monkeypatch.setattr(github_auth, "_token", [""])
    assert _get(py_auth, f"http://localhost:{server}/ok") == b"ok"
    assert seen == [("/ok", None)]


def test_python_retry_never_retries_a_missing_credential(py_auth, server, seen,
                                                         monkeypatch) -> None:
    import download_retry

    monkeypatch.setattr(github_auth, "_token", [""])
    monkeypatch.setattr(download_retry.time, "sleep", lambda _s: pytest.fail("retried"))
    with pytest.raises(github_auth.MissingCredential):
        download_retry.fetch_with_retry(
            urllib.request.Request(f"http://127.0.0.1:{server}/ok"), timeout=10,
            description="probe")
    assert seen == []


def test_check_toolchains_reports_a_missing_credential_as_a_fetch_error(monkeypatch) -> None:
    import importlib.util

    spec = importlib.util.spec_from_file_location("check_toolchains", SCRIPTS / "check-toolchains.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module.github_auth, "_token", [""])
    fetched = module.fetch_json("https://api.github.com/repos/o/r/releases/latest")
    assert fetched.error and "no GitHub credential for api.github.com" in fetched.error


def test_python_drops_the_token_on_a_cross_host_redirect(py_auth, server, seen) -> None:
    _get(py_auth, f"http://127.0.0.1:{server}/cross")
    assert seen == [("/cross", f"Bearer {TOKEN}"), ("/final", None)]


def test_python_keeps_the_token_on_a_same_origin_redirect(py_auth, server, seen) -> None:
    _get(py_auth, f"http://127.0.0.1:{server}/same")
    assert seen == [("/same", f"Bearer {TOKEN}"), ("/final", f"Bearer {TOKEN}")]


def test_python_error_text_never_carries_the_token(py_auth, server, seen) -> None:
    import download_retry

    with pytest.raises(urllib.error.HTTPError) as raised:
        _get(py_auth, f"http://127.0.0.1:{server}/forbidden")
    assert seen == [("/forbidden", f"Bearer {TOKEN}")]
    assert TOKEN not in str(raised.value) and TOKEN not in repr(raised.value)
    with pytest.raises(urllib.error.HTTPError) as raised:
        download_retry.fetch_with_retry(
            urllib.request.Request(f"http://127.0.0.1:{server}/forbidden"),
            timeout=10, description="probe")
    assert TOKEN not in str(raised.value)


@pytest.mark.parametrize("url,expected", [
    ("https://api.github.com/repos/o/r/releases/latest", True),
    ("https://github.com/o/r/releases/download/v1/a.tar", True),
    ("https://raw.githubusercontent.com/o/r/sha/f", True),
    ("https://objects.githubusercontent.com/x", True),
    ("https://codeload.github.com/o/r/tar.gz/sha", True),
    ("https://release-assets.githubusercontent.com/x", True),
    ("https://API.GitHub.com/x", True),
    ("http://api.github.com/x", False),
    ("https://github.com.example.invalid/x", False),
    ("https://example.invalid/?u=https://github.com/", False),
    ("https://www.python.org/ftp/python/", False),
])
def test_python_names_only_the_github_hosts_over_https(url: str, expected: bool) -> None:
    assert github_auth.is_github(url) is expected


def test_python_resolves_gh_token_then_github_token_then_gh(monkeypatch) -> None:
    calls = []

    def fake_run(args, **kwargs):
        calls.append((args, kwargs))
        return subprocess.CompletedProcess(args, 0, "fromgh\n", None)

    monkeypatch.setattr(github_auth.shutil, "which", lambda name: "gh-path" if name == "gh" else None)
    monkeypatch.setattr(github_auth.subprocess, "run", fake_run)
    for env, expected in (
        ({"GH_TOKEN": "a", "GITHUB_TOKEN": "b"}, "a"),
        ({"GITHUB_TOKEN": "b"}, "b"),
        ({}, "fromgh"),
    ):
        monkeypatch.delenv("GH_TOKEN", raising=False)
        monkeypatch.delenv("GITHUB_TOKEN", raising=False)
        for name, value in env.items():
            monkeypatch.setenv(name, value)
        monkeypatch.setattr(github_auth, "_token", [])
        assert github_auth.token() == expected
        assert github_auth.token() == expected
    assert len(calls) == 1, "gh runs once per process, and only when no variable is set"
    args, kwargs = calls[0]
    assert args == ["gh-path", "auth", "token"]
    assert kwargs["stderr"] == subprocess.DEVNULL and kwargs["timeout"] > 0
    assert "shell" not in kwargs


@pytest.mark.parametrize("failure", [
    subprocess.TimeoutExpired(["gh"], 15),
    OSError("gh vanished"),
    subprocess.CompletedProcess(["gh"], 1, "", None),
    subprocess.CompletedProcess(["gh"], 0, "two\nlines\n", None),
])
def test_python_treats_a_failed_gh_as_no_token(monkeypatch, failure) -> None:
    def fake_run(args, **kwargs):
        if isinstance(failure, BaseException):
            raise failure
        return failure

    monkeypatch.delenv("GH_TOKEN", raising=False)
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    monkeypatch.setattr(github_auth.shutil, "which", lambda name: "gh-path")
    monkeypatch.setattr(github_auth.subprocess, "run", fake_run)
    monkeypatch.setattr(github_auth, "_token", [])
    assert github_auth.token() == ""


@pytest.mark.parametrize("value", ["two words", "line\nbreak", 'quo"te'])
def test_python_refuses_a_token_a_header_cannot_carry(monkeypatch, value) -> None:
    monkeypatch.setenv("GH_TOKEN", value)
    monkeypatch.setattr(github_auth, "_token", [])
    assert github_auth.token() == ""


def test_python_needs_no_gh_on_path(monkeypatch) -> None:
    monkeypatch.delenv("GH_TOKEN", raising=False)
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    monkeypatch.setattr(github_auth.shutil, "which", lambda name: None)
    monkeypatch.setattr(github_auth, "_token", [])
    assert github_auth.token() == ""


def test_every_python_github_fetch_goes_through_the_helper() -> None:
    for name in ("check-toolchains.py", "download_retry.py", "bundle-dictionaries.sh"):
        text = (SCRIPTS / name).read_text(encoding="utf-8")
        assert "github_auth.urlopen(" in text, name
        assert "urllib.request.urlopen(" not in text, name


# ── POSIX shell ──────────────────────────────────────────────────────────────

needs_sh = pytest.mark.skipif(shutil.which("sh") is None, reason="no POSIX shell")


def _stub_dir(tmp_path: Path, gh_output: str | None) -> Path:
    stubs = tmp_path / "stubs"
    stubs.mkdir(parents=True)
    curl_stub = (
        b'#!/bin/sh\nprintf \'%s\\n\' "$@" > "$STUB_LOG/args"\n'
        b'cat > "$STUB_LOG/stdin"\n'
        b'exit 0\n')
    (stubs / "curl").write_bytes(curl_stub)
    if os.name == "nt":
        # Git Bash resolves curl.exe ahead of an extensionless script.
        (stubs / "curl.exe").write_bytes(curl_stub)
    gh = (b'#!/bin/sh\nexit 1\n' if gh_output is None
          else b'#!/bin/sh\nprintf \'%s\\n\' "' + gh_output.encode() + b'"\n')
    (stubs / "gh").write_bytes(gh)
    if os.name == "nt":
        (stubs / "gh.exe").write_bytes(gh)
    if os.name == "nt":
        # Git for Windows can resolve the native Windows timeout.exe before
        # GNU timeout; their command-line syntax is unrelated.
        (stubs / "timeout").write_bytes(b'#!/bin/sh\nshift\nexec "$@"\n')
        (stubs / "timeout.exe").write_bytes(b'#!/bin/sh\nshift\nexec "$@"\n')
    for stub in stubs.iterdir():
        stub.chmod(0o755)
    return stubs


def _sh(script: str, env: dict, cwd: Path = ROOT) -> subprocess.CompletedProcess:
    return subprocess.run(["sh", "-c", script], capture_output=True, text=True,
                          stdin=subprocess.DEVNULL, env=env, cwd=cwd, timeout=120)


def _stubbed(tmp_path: Path, url: str, gh_output: str | None = None, trace: bool = False,
             **tokens: str) -> tuple:
    stubs = _stub_dir(tmp_path, gh_output)
    log = tmp_path / "log"
    log.mkdir()
    env = _clean_env(STUB_LOG=log.as_posix(), **tokens)
    env["PATH"] = str(stubs) + os.pathsep + env["PATH"]
    run = _sh(f'. scripts/posix-common.sh; {"set -x; " if trace else ""}'
              f'curl_fetch "{url}" "{(tmp_path / "out").as_posix()}"', env)
    assert run.returncode == 0, run.stderr
    args = (log / "args").read_text().splitlines()
    stdin = (log / "stdin").read_text() if (log / "stdin").exists() else ""
    return args, stdin, run


@needs_sh
def test_shell_passes_the_token_on_stdin_for_a_github_host(tmp_path) -> None:
    args, stdin, _run = _stubbed(tmp_path, "https://api.github.com/x", GH_TOKEN=TOKEN)
    assert stdin == f'header = "Authorization: Bearer {TOKEN}"\n'
    assert "-K" in args and args[args.index("-K") + 1] == "-"
    assert not any(TOKEN in arg for arg in args)
    assert "--location-trusted" not in args


@needs_sh
def test_shell_prefers_gh_token_then_github_token_then_gh(tmp_path) -> None:
    _args, stdin, _run = _stubbed(tmp_path / "a", "https://github.com/x", GITHUB_TOKEN="second")
    assert "Bearer second" in stdin
    _args, stdin, _run = _stubbed(tmp_path / "b", "https://github.com/x", gh_output="third")
    assert "Bearer third" in stdin
    _args, stdin, _run = _stubbed(tmp_path / "c", "https://github.com/x", gh_output="third",
                                  GH_TOKEN="first", GITHUB_TOKEN="second")
    assert "Bearer first" in stdin


@needs_sh
@pytest.mark.parametrize("url", ["https://www.python.org/x", "http://github.com/x",
                                 "https://github.com.example.invalid/x"])
def test_shell_sends_no_token_to_another_host(tmp_path, url) -> None:
    args, stdin, _run = _stubbed(tmp_path, url, GH_TOKEN=TOKEN)
    assert "-K" not in args and stdin == ""
    assert not any(TOKEN in arg for arg in args)


def _stubbed_refusal(tmp_path: Path, url: str, **tokens: str) -> subprocess.CompletedProcess:
    stubs = _stub_dir(tmp_path, None)
    log = tmp_path / "log"
    log.mkdir()
    env = _clean_env(STUB_LOG=log.as_posix(), **tokens)
    env["PATH"] = str(stubs) + os.pathsep + env["PATH"]
    run = _sh(f'. scripts/posix-common.sh; curl_fetch "{url}" "{(tmp_path / "out").as_posix()}"; '
              'echo after', env)
    assert not (log / "args").exists(), "curl ran with no credential"
    return run


@needs_sh
@pytest.mark.parametrize("tokens", [{}, {"GH_TOKEN": 'a" b'}, {"GITHUB_TOKEN": "  "}])
def test_shell_refuses_a_github_host_when_no_token_resolves(tmp_path, tokens) -> None:
    run = _stubbed_refusal(tmp_path, "https://api.github.com/x", **tokens)
    assert run.returncode != 0 and "after" not in run.stdout
    assert "no GitHub credential for api.github.com" in run.stderr
    assert "GH_TOKEN" in run.stderr and "gh auth login" in run.stderr
    assert 'a" b' not in run.stderr


@needs_sh
def test_shell_fetch_verified_stops_at_once_without_a_credential(tmp_path) -> None:
    stubs = _stub_dir(tmp_path, None)
    log = tmp_path / "log"
    log.mkdir()
    (stubs / "sleep").write_bytes(b'#!/bin/sh\ntouch "$STUB_LOG/slept"\n')
    (stubs / "sleep").chmod(0o755)
    env = _clean_env(STUB_LOG=log.as_posix(), SPECTRA_FETCH_CACHE=(tmp_path / "cache").as_posix())
    env["PATH"] = str(stubs) + os.pathsep + env["PATH"]
    run = _sh('. scripts/posix-common.sh; fetch_verified "https://github.com/o/r/a.tar" '
              f'{"0" * 64} a.tar', env)
    assert run.returncode != 0 and "no GitHub credential" in run.stderr
    assert not (log / "args").exists() and not (log / "slept").exists()


HOST_CASES = [
    "https://api.github.com/x", "https://github.com/x", "https://raw.githubusercontent.com/x",
    "https://objects.githubusercontent.com/x", "https://codeload.github.com/x",
    "https://release-assets.githubusercontent.com/x", "https://API.GitHub.com/x",
    "HTTPS://github.com/x", "https://github.com:443/x", "https://user@github.com/x",
    "http://api.github.com/x", "https://github.com.example.invalid/x", "https://notgithub.com/x",
    "https://github.com@example.invalid/x", "https://github.com:443@example.invalid/x",
    "https://example.invalid/?u=https://github.com/", "https://example.invalid#@github.com/",
    "ftp://github.com/x", "https://www.python.org/ftp/python/",
    "https://github.com:8443/x", "https://api.github.com:80/x",
]


@needs_sh
def test_shell_and_python_name_the_same_github_urls() -> None:
    script = ". scripts/posix-common.sh\n" + "".join(
        f'github_host "{url}" && echo yes || echo no\n' for url in HOST_CASES)
    run = _sh(script, _clean_env())
    assert run.returncode == 0, run.stderr
    shell = [answer == "yes" for answer in run.stdout.split()]
    assert shell == [github_auth.is_github(url) for url in HOST_CASES]
    assert shell[:10] == [True] * 10 and not any(shell[10:])


def test_powershell_and_python_name_the_same_github_urls() -> None:
    shells = [name for name in ("pwsh", "powershell") if shutil.which(name)]
    if not shells:
        pytest.skip("no PowerShell")
    script = (f". '{(SCRIPTS / 'download-retry.ps1').as_posix()}'\n"
              + "\n".join(f"Write-Output (Test-GitHubUri '{u}')" for u in HOST_CASES))
    for shell in shells:
        run = subprocess.run([shell, "-NoProfile", "-NonInteractive", "-Command", script],
                             capture_output=True, text=True, timeout=120)
        assert run.returncode == 0, run.stderr
        assert [answer == "True" for answer in run.stdout.split()] == [
            github_auth.is_github(url) for url in HOST_CASES], shell


RESOLVE_CASES = [
    ({"GH_TOKEN": "first", "GITHUB_TOKEN": "second"}, "first"),
    ({"GITHUB_TOKEN": "second"}, "second"),
    ({"GH_TOKEN": " first\t"}, "first"),
    ({"GH_TOKEN": "  ", "GITHUB_TOKEN": "second"}, "second"),
    ({"GH_TOKEN": "a b", "GITHUB_TOKEN": "second"}, ""),
    ({"GITHUB_TOKEN": "\tsecond\n"}, "second"),
    ({}, ""),
]


@needs_sh
@pytest.mark.parametrize("tokens,expected", RESOLVE_CASES)
def test_shell_resolves_the_token_as_python_does(tmp_path, monkeypatch, tokens, expected) -> None:
    stubs = _stub_dir(tmp_path, None)
    env = _clean_env(**tokens)
    env["PATH"] = str(stubs) + os.pathsep + env["PATH"]
    run = _sh('. scripts/posix-common.sh; github_token_resolve; printf "[%s]" "$_gh_token"', env)
    assert run.stdout == f"[{expected}]", run.stderr
    monkeypatch.delenv("GH_TOKEN", raising=False)
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    for name, value in tokens.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setattr(github_auth.shutil, "which", lambda _name: None)
    monkeypatch.setattr(github_auth, "_token", [])
    assert github_auth.token() == expected


def test_powershell_resolves_the_token_as_python_does() -> None:
    shells = [name for name in ("pwsh", "powershell") if shutil.which(name)]
    if not shells:
        pytest.skip("no PowerShell")
    script = (f". '{(SCRIPTS / 'download-retry.ps1').as_posix()}'\n"
              "function Get-GitHubTokenFromGh { return '' }\n"
              "Write-Output ('[' + (Get-GitHubToken) + ']')")
    for shell in shells:
        for tokens, expected in RESOLVE_CASES:
            run = subprocess.run([shell, "-NoProfile", "-NonInteractive", "-Command", script],
                                 capture_output=True, text=True, env=_clean_env(**tokens),
                                 timeout=120)
            assert run.stdout.strip() == f"[{expected}]", (shell, tokens, run.stderr)


@needs_sh
def test_shell_unexport_keeps_the_token_for_its_own_fetch_and_hides_it_from_children(
        tmp_path) -> None:
    stubs = _stub_dir(tmp_path, None)
    log = tmp_path / "log"
    log.mkdir()
    env = _clean_env(STUB_LOG=log.as_posix(), GH_TOKEN=TOKEN, GITHUB_TOKEN=TOKEN)
    env["PATH"] = str(stubs) + os.pathsep + env["PATH"]
    run = _sh('. scripts/posix-common.sh; set -x; github_token_unexport; '
              'env > "$STUB_LOG/child-env"; '
              f'curl_fetch "https://api.github.com/x" "{(tmp_path / "out").as_posix()}"', env)
    assert run.returncode == 0, run.stderr
    child = (log / "child-env").read_text()
    assert "GH_TOKEN=" not in child and "GITHUB_TOKEN=" not in child
    assert (log / "stdin").read_text() == f'header = "Authorization: Bearer {TOKEN}"\n'
    assert "github_token_unexport" in run.stderr, "the trace ran"
    assert TOKEN not in run.stderr and TOKEN not in run.stdout


@needs_sh
def test_shell_tracing_never_prints_the_token(tmp_path) -> None:
    _args, stdin, run = _stubbed(tmp_path, "https://api.github.com/x", trace=True, GH_TOKEN=TOKEN)
    assert TOKEN in stdin
    assert "curl" in run.stderr, "the trace ran"
    assert TOKEN not in run.stderr and TOKEN not in run.stdout


@needs_sh
def test_shell_curl_drops_the_token_on_a_cross_host_redirect(tmp_path, server, seen) -> None:
    if shutil.which("curl") is None:
        pytest.skip("no curl")
    script = ('. scripts/posix-common.sh; github_host() { case "$1" in http://127.0.0.1:*) return 0;; esac; '
              'return 1; }; curl_fetch "$1" "$2"')
    env = _clean_env(GH_TOKEN=TOKEN)
    for path, expected in (
        ("/cross", [("/cross", f"Bearer {TOKEN}"), ("/final", None)]),
        ("/same", [("/same", f"Bearer {TOKEN}"), ("/final", f"Bearer {TOKEN}")]),
    ):
        seen.clear()
        run = subprocess.run(["sh", "-c", script, "sh", f"http://127.0.0.1:{server}{path}",
                              (tmp_path / "out").as_posix()],
                             capture_output=True, text=True, stdin=subprocess.DEVNULL,
                             env=env, cwd=ROOT, timeout=120)
        assert run.returncode == 0, run.stderr
        assert seen == expected, path
        assert TOKEN not in run.stderr


# ── PowerShell ───────────────────────────────────────────────────────────────

POWERSHELLS = [name for name in ("pwsh", "powershell") if shutil.which(name)]
PS_PROBE = r"""
$ErrorActionPreference = 'Stop'
. '{helper}'
function Test-GitHubUri {{ param([string]$Uri) return ([Uri]$Uri).Host -eq '127.0.0.1' }}
function Get-GitHubTokenFromGh {{ return '{gh}' }}
try {{
    Invoke-DownloadWithRetry -Uri '{url}' -OutFile '{out}' -Description probe -Attempts 1 -TimeoutSec 30
    Write-Output 'fetched'
}} catch {{
    Write-Output ('failed: ' + $_.Exception.Message)
}}
"""


def _ps(shell: str, url: str, out: Path, gh: str = "", **tokens: str) -> subprocess.CompletedProcess:
    script = PS_PROBE.format(helper=(SCRIPTS / "download-retry.ps1").as_posix(), url=url,
                             out=out.as_posix(), gh=gh)
    return subprocess.run([shell, "-NoProfile", "-NonInteractive", "-Command", script],
                          capture_output=True, text=True, env=_clean_env(**tokens), timeout=180)


@pytest.mark.skipif(not POWERSHELLS, reason="no PowerShell")
@pytest.mark.parametrize("shell", POWERSHELLS)
def test_powershell_sends_the_token_only_where_it_belongs(shell, tmp_path, server, seen) -> None:
    out = tmp_path / "out"
    cases = (
        (f"http://127.0.0.1:{server}/ok", {"GH_TOKEN": TOKEN}, "", [("/ok", f"Bearer {TOKEN}")]),
        (f"http://127.0.0.1:{server}/ok", {"GITHUB_TOKEN": TOKEN}, "", [("/ok", f"Bearer {TOKEN}")]),
        (f"http://127.0.0.1:{server}/ok", {}, TOKEN, [("/ok", f"Bearer {TOKEN}")]),
        (f"http://localhost:{server}/ok", {"GH_TOKEN": TOKEN}, "", [("/ok", None)]),
        (f"http://localhost:{server}/ok", {}, "", [("/ok", None)]),
        (f"http://127.0.0.1:{server}/cross", {"GH_TOKEN": TOKEN}, "",
         [("/cross", f"Bearer {TOKEN}"), ("/final", None)]),
        (f"http://127.0.0.1:{server}/same", {"GH_TOKEN": TOKEN}, "",
         [("/same", f"Bearer {TOKEN}"), ("/final", f"Bearer {TOKEN}")]),
    )
    for url, tokens, gh, expected in cases:
        seen.clear()
        run = _ps(shell, url, out, gh, **tokens)
        assert "fetched" in run.stdout, (url, tokens, run.stdout, run.stderr)
        assert seen == expected, (url, tokens, gh)
        assert TOKEN not in run.stdout + run.stderr


@pytest.mark.skipif(not POWERSHELLS, reason="no PowerShell")
@pytest.mark.parametrize("shell", POWERSHELLS)
@pytest.mark.parametrize("tokens", [{}, {"GH_TOKEN": "two words"}, {"GITHUB_TOKEN": "  "}])
def test_powershell_refuses_a_github_host_when_no_token_resolves(shell, tokens, tmp_path, server,
                                                                 seen) -> None:
    run = _ps(shell, f"http://127.0.0.1:{server}/ok", tmp_path / "out", **tokens)
    assert "failed: no GitHub credential for 127.0.0.1" in run.stdout, run.stdout + run.stderr
    assert "GH_TOKEN" in run.stdout and "gh auth login" in run.stdout
    assert "two words" not in run.stdout + run.stderr
    assert seen == [], "no anonymous request reaches the GitHub host"


PS_SCRUB_PROBE = r"""
$ErrorActionPreference = 'Stop'
. '{helper}'
function Test-GitHubUri {{ param([string]$Uri) return ([Uri]$Uri).Host -eq '127.0.0.1' }}
function Get-GitHubTokenFromGh {{ [Console]::Out.WriteLine('gh-started'); return '{gh}' }}
Remove-GitHubTokenFromEnvironment
[Console]::Out.WriteLine('scrubbed')
& '{python}' -c "import os; print('child', 'GH_TOKEN' in os.environ, 'GITHUB_TOKEN' in os.environ)"
Invoke-DownloadWithRetry -Uri '{url}' -OutFile '{out}' -Description probe -Attempts 1 -TimeoutSec 30
Write-Output 'fetched'
"""


@pytest.mark.skipif(not POWERSHELLS, reason="no PowerShell")
@pytest.mark.parametrize("shell", POWERSHELLS)
@pytest.mark.parametrize("tokens,gh", [
    ({"GH_TOKEN": TOKEN, "GITHUB_TOKEN": TOKEN}, ""),
    ({"GH_TOKEN": TOKEN}, ""),
    ({"GITHUB_TOKEN": f" {TOKEN} "}, ""),
    ({}, TOKEN),
])
def test_powershell_scrub_keeps_the_token_for_its_own_fetch_and_hides_it_from_children(
        shell, tokens, gh, tmp_path, server, seen) -> None:
    script = PS_SCRUB_PROBE.format(helper=(SCRIPTS / "download-retry.ps1").as_posix(),
                                   python=Path(sys.executable).as_posix(), gh=gh,
                                   url=f"http://127.0.0.1:{server}/ok",
                                   out=(tmp_path / "out").as_posix())
    run = subprocess.run([shell, "-NoProfile", "-NonInteractive", "-Command", script],
                         capture_output=True, text=True, timeout=180, env=_clean_env(**tokens))
    lines = run.stdout.split()
    assert "child False False" in run.stdout and "fetched" in run.stdout, run.stdout + run.stderr
    assert seen == [("/ok", f"Bearer {TOKEN}")]
    assert TOKEN not in run.stdout + run.stderr
    assert "gh-started" not in lines[:lines.index("scrubbed")], "the scrub starts no program"
    assert ("gh-started" in lines) == (not tokens), "gh runs only when no variable was set"


#: Start-HeldProgram is the one launcher of the bundled Ghostscript. It is
#: loaded from the script's own syntax tree and runs a native child through
#: the held-program DLL-load gate with the same ProcessStartInfo environment.
PS_HELD_LAUNCH_PROBE = r"""
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('{script}', [ref]$tokens, [ref]$errors)
foreach ($name in @('ConvertTo-CommandLineArgument', 'Start-HeldProgram')) {{
    $definition = $ast.Find({{ param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }}, $true)
    . ([scriptblock]::Create($definition.Extent.Text))
}}
$BundledGsLib = '%rom%Resource/Init/;%rom%lib/'
$HeldProgramSource = '{held_source}'
$code = 'if defined GH_TOKEN (echo leak) else (echo clean) & if defined GITHUB_TOKEN (echo leak) else (echo clean) & echo %GS_LIB%'
$run = Start-HeldProgram $env:ComSpec $env:SystemRoot\System32 @('/d', '/c', $code)
if ($run.Code -ne 0) {{ throw "held child exited $($run.Code): $($run.Errors)" }}
Write-Output $run.Output
"""


@pytest.mark.skipif(not POWERSHELLS, reason="no PowerShell")
@pytest.mark.parametrize("shell", POWERSHELLS)
def test_the_held_launcher_scrubs_credentials_from_child(shell, tmp_path) -> None:
    directory = ROOT / "resources" / "ghostscript"
    if not (directory / "gswin64c.exe").is_file():
        pytest.skip("no bundled Windows Ghostscript")
    script = PS_HELD_LAUNCH_PROBE.format(
        script=(SCRIPTS / "bundle-ghostscript.ps1").as_posix(),
        held_source=(SCRIPTS / "held-program.cs").as_posix(),
        exe=str(directory / "gswin64c.exe"), directory=str(directory))
    run = subprocess.run([shell, "-NoProfile", "-NonInteractive", "-Command", script],
                         capture_output=True, text=True, timeout=180,
                         env=_clean_env(GH_TOKEN=TOKEN, GITHUB_TOKEN=TOKEN))
    assert run.stdout.splitlines()[:2] == ["clean", "clean"], run.stdout + run.stderr
    assert "%rom%Resource/Init/;%rom%lib/" in run.stdout, run.stdout + run.stderr
    assert TOKEN not in run.stdout + run.stderr


def test_every_bundled_ghostscript_start_goes_through_the_held_launcher() -> None:
    code = "\n".join(line for line in (SCRIPTS / "bundle-ghostscript.ps1").read_text(
        encoding="utf-8-sig").splitlines() if not line.lstrip().startswith("#"))
    starts = re.findall(r"Process\]::Start\(|Start-Process\b|&\s*\$gs|&\s*\$exe", code, re.I)
    assert starts == [], starts
    launcher = code[code.index("function Start-HeldProgram"):code.index("function Invoke-BundledGs")]
    assert "[SpectraHeldProgram]::Run(" in launcher


@pytest.mark.skipif(not POWERSHELLS, reason="no PowerShell")
@pytest.mark.parametrize("shell", POWERSHELLS)
def test_powershell_error_text_never_carries_the_token(shell, tmp_path, server, seen) -> None:
    run = _ps(shell, f"http://127.0.0.1:{server}/forbidden", tmp_path / "out", GH_TOKEN=TOKEN)
    assert "failed:" in run.stdout and "403" in run.stdout, run.stdout + run.stderr
    assert seen == [("/forbidden", f"Bearer {TOKEN}")]
    assert TOKEN not in run.stdout + run.stderr


PS_CURL_PROBE = r"""
$ErrorActionPreference = 'Stop'
. '{helper}'
function Test-GitHubUri {{ param([string]$Uri) return ([Uri]$Uri).Host -eq '127.0.0.1' }}
Get-GitHubCurlConfig -Uri '{url}' |
    & curl.exe --fail --silent --show-error --location -K - -o '{out}' '{url}'
Write-Output "curl exit $LASTEXITCODE"
"""


@pytest.mark.skipif(not POWERSHELLS or shutil.which("curl.exe") is None,
                    reason="no PowerShell or curl.exe")
@pytest.mark.parametrize("shell", POWERSHELLS)
def test_powershell_passes_curl_the_token_on_stdin(shell, tmp_path, server, seen) -> None:
    for path, expected in (
        ("/ok", [("/ok", f"Bearer {TOKEN}")]),
        ("/cross", [("/cross", f"Bearer {TOKEN}"), ("/final", None)]),
    ):
        seen.clear()
        script = PS_CURL_PROBE.format(helper=(SCRIPTS / "download-retry.ps1").as_posix(),
                                      url=f"http://127.0.0.1:{server}{path}",
                                      out=(tmp_path / "out").as_posix())
        run = subprocess.run([shell, "-NoProfile", "-NonInteractive", "-Command", script],
                             capture_output=True, text=True, env=_clean_env(GH_TOKEN=TOKEN),
                             timeout=180)
        assert "curl exit 0" in run.stdout, run.stdout + run.stderr
        assert seen == expected, path
        assert TOKEN not in run.stdout + run.stderr


@pytest.mark.parametrize("name", ["verify-release-draft.ps1", "add-linux-updater-entry.ps1"])
def test_no_release_script_puts_the_token_on_a_curl_command_line(name: str) -> None:
    text = (SCRIPTS / name).read_text(encoding="utf-8").replace("`\n", " ")
    statements = [line for line in text.splitlines()
                  if "curl" in line and not line.lstrip().startswith("#")]
    assert statements, name + " runs no curl"
    for statement in statements:
        arguments = statement.split("curl", 1)[1]
        for needle in ("Authorization", "GH_TOKEN", "GITHUB_TOKEN", "$token", "Bearer"):
            assert needle not in arguments, (name, statement)
        assert "-K -" in arguments and "Get-GitHubCurlConfig" in text, (name, statement)


@pytest.mark.skipif(not POWERSHELLS, reason="no PowerShell")
def test_powershell_names_only_the_github_hosts_over_https() -> None:
    urls = [
        "https://api.github.com/x", "https://github.com/x", "https://raw.githubusercontent.com/x",
        "https://objects.githubusercontent.com/x", "https://codeload.github.com/x",
        "https://release-assets.githubusercontent.com/x", "https://API.GitHub.com/x",
        "http://api.github.com/x", "https://github.com.example.invalid/x",
        "https://example.invalid/?u=https://github.com/", "not a url",
    ]
    script = (f". '{(SCRIPTS / 'download-retry.ps1').as_posix()}'\n"
              + "\n".join(f"Write-Output (Test-GitHubUri '{u}')" for u in urls))
    run = subprocess.run([POWERSHELLS[0], "-NoProfile", "-NonInteractive", "-Command", script],
                         capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stderr
    assert run.stdout.split() == ["True"] * 7 + ["False"] * 4


def test_the_three_helpers_name_one_host_list() -> None:
    import re

    shell = (SCRIPTS / "posix-common.sh").read_text(encoding="utf-8")
    shell_hosts = set(re.search(r'^GITHUB_HOSTS="([^"]+)"', shell, re.M).group(1).split())
    ps = (SCRIPTS / "download-retry.ps1").read_text(encoding="utf-8")
    ps_block = re.search(r"\$GitHubHosts = @\((.*?)\)", ps, re.S).group(1)
    ps_hosts = set(re.findall(r"'([^']+)'", ps_block))
    assert shell_hosts == ps_hosts == set(github_auth.GITHUB_HOSTS)


# ── Credential scope ─────────────────────────────────────────────────────────

#: (script, the call that ends its GitHub fetches, the first command after it
#: that runs a build, a package manager or vendored code)
UNEXPORT_BOUNDARIES = [
    ("linux-release-build.sh", "github_token_unexport", "npx tauri build"),
    ("ci-parity-linux.sh", "github_token_unexport", "cargo check"),
    ("build-appimage.sh", "github_token_unexport", "pacman -Syu"),
    ("build-appimage.sh", "github_token_unexport", "appimage-extract"),
    ("appimage-catalog-gate.sh", "github_token_unexport", "apt-get install"),
    ("cargo-audit.sh", "github_token_unexport", "exec cargo audit"),
    ("cargo-audit.sh", "unset GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0",
     "exec cargo audit"),
    ("setup-python-embed.sh", "github_token_unexport", '"$PY" -B'),
    ("bundle-voikko.sh", "github_token_unexport", '"$PY"'),
    ("bundle-icc.sh", "github_token_unexport", "python3 -"),
    ("bundle-tesseract.sh", "github_token_unexport", '"$DEST/bin/tesseract"'),
    ("bundle-jbig2enc.sh", "github_token_unexport", '"$DEST/bin/jbig2"'),
    ("bundle-libreoffice.sh", "github_token_unexport", 'tar -xzf "$archive"'),
    ("sync-edit-fonts.sh", "github_token_unexport", 'tar -xzf'),
    ("sync-signature-fonts.sh", "github_token_unexport", "fetch_verified"),
    ("lock-python-deps.sh", "github_token_unexport", '"$PY"'),
    ("install-vendored-wheels.sh", "github_token_unexport", '"$PY"'),
    ("bundle-ghostscript.ps1", "Remove-GitHubTokenFromEnvironment", "& $SevenZip x $Installer"),
]


@pytest.mark.parametrize("name,boundary,later", UNEXPORT_BOUNDARIES)
def test_no_build_or_vendored_program_inherits_the_credential(name, boundary, later) -> None:
    code = "\n".join(line for line in (SCRIPTS / name).read_text(encoding="utf-8-sig").splitlines()
                     if not line.lstrip().startswith("#"))
    assert boundary in code and later in code, name
    assert code.index(boundary) < code.index(later), (name, boundary, later)


def test_zstd_extraction_scrubs_before_archive_tools() -> None:
    code = (SCRIPTS / "posix-common.sh").read_text(encoding="utf-8")
    body = code.split("unpack_tar_zst() {", 1)[1].split("\n}", 1)[0]
    scrub = body.index("github_token_unexport")
    for command in ("zstd -dc", "tar -x -C", '"$py" -'):
        assert scrub < body.index(command), command


@needs_sh
def test_posix_runtime_setup_scrubs_before_running_existing_python(tmp_path) -> None:
    resources = tmp_path / "resources"
    runtime = resources / "linux-x86_64" / "python" / "bin" / "python3"
    runtime.parent.mkdir(parents=True)
    version = re.search(r'PBS_PINNED_VERSION="([^"]+)"',
                        (SCRIPTS / "setup-python-embed.sh").read_text()).group(1)
    log = tmp_path / "runtime-env"
    runtime.write_text(
        '#!/bin/sh\n'
        'printf "%s %s\\n" "${GH_TOKEN+present}" "${GITHUB_TOKEN+present}" >> "$PROBE_ENV_LOG"\n'
        f'if [ "$1" = "-B" ]; then printf "%s\\n" "{version}"; exit 0; fi\n'
        'exit 94\n', encoding="utf-8", newline="\n")
    runtime.chmod(0o755)
    run = _sh('sh scripts/setup-python-embed.sh',
              _clean_env(GH_TOKEN=TOKEN, GITHUB_TOKEN=TOKEN,
                         SPECTRA_RESOURCES=resources.as_posix(), PROBE_ENV_LOG=log.as_posix()))
    assert run.returncode != 0, "the stub deliberately stops provisioning after the launch"
    assert log.exists(), run.stdout + run.stderr
    assert "present" not in log.read_text(), "the runtime inherited a credential"


def test_the_parity_gates_hand_no_credential_to_every_gate() -> None:
    code = (SCRIPTS / "ci-parity-gates.sh").read_text(encoding="utf-8")
    assert "GH_TOKEN" not in code and "gh auth token" not in code


#: Scripts that start a program: an archive tool, an installer, a build shell,
#: a downloaded or vendored binary. Each removes the credential from its
#: environment before the first start.
PROGRAM_STARTING_PS = [
    ("bundle-tesseract.ps1", "Remove-GitHubTokenFromEnvironment"),
    ("bundle-jbig2enc.ps1", "Remove-GitHubTokenFromEnvironment"),
    ("build-libtiff-nojbig.ps1", "Remove-GitHubTokenFromEnvironment"),
    ("bundle-voikko.ps1", "Remove-GitHubTokenFromEnvironment"),
    ("setup-python-embed.ps1", "Remove-GitHubTokenFromEnvironment"),
    ("sync-edit-fonts.ps1", "Remove-GitHubTokenFromEnvironment"),
    ("lock-python-deps.ps1", "Remove-GitHubTokenFromEnvironment"),
    ("bundle-libreoffice.ps1", "Remove-Item -Path Env:GH_TOKEN, Env:GITHUB_TOKEN"),
]
PROGRAM_START = re.compile(r"(?m)(?:^|[=(|]\s*|@\()\s*&\s*[\$(]|Start-Process\b|Process\]::Start\(")


@pytest.mark.parametrize("name,scrub", PROGRAM_STARTING_PS)
def test_a_script_scrubs_the_credential_before_its_first_program(name, scrub) -> None:
    code = "\n".join(line for line in (SCRIPTS / name).read_text(encoding="utf-8-sig").splitlines()
                     if not line.lstrip().startswith("#"))
    first = PROGRAM_START.search(code)
    assert first, name + " starts no program"
    assert scrub in code and code.index(scrub) < first.start(), (name, code[first.start():][:60])
