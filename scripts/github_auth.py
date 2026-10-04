"""A GitHub credential on every scripted request to a GitHub host.

GitHub answers 60 anonymous API requests per hour per network address; an
authenticated request draws on the account's own quota instead. The token
comes from GH_TOKEN, then GITHUB_TOKEN, then `gh auth token`, and is sent only
over HTTPS to the hosts in GITHUB_HOSTS. A redirect keeps it only when the
target has the same scheme, host and port: a release-asset download redirects
to a signed URL on another host, and that host refuses or records a request
that carries the header.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import urllib.request
from urllib.parse import urlsplit

GITHUB_HOSTS = frozenset({
    "api.github.com",
    "github.com",
    "raw.githubusercontent.com",
    "objects.githubusercontent.com",
    "codeload.github.com",
    "release-assets.githubusercontent.com",
})
SCHEMES = frozenset({"https"})
GH_TIMEOUT_SECONDS = 15
TOKEN_SHAPE = re.compile(r"[A-Za-z0-9_]+")

_token: list[str] = []
_opener: list[urllib.request.OpenerDirector] = []


def _from_gh() -> str:
    program = shutil.which("gh")
    if program is None:
        return ""
    try:
        done = subprocess.run(
            [program, "auth", "token"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=GH_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    if done.returncode != 0:
        return ""
    words = done.stdout.split()
    return words[0] if len(words) == 1 else ""


def token() -> str:
    """The credential, resolved once per process; "" when none resolves.

    A value holding any character outside [A-Za-z0-9_] counts as none:
    http.client refuses such a header value and quotes it in the error.
    """
    if not _token:
        found = ""
        for name in ("GH_TOKEN", "GITHUB_TOKEN"):
            found = os.environ.get(name, "").strip()
            if found:
                break
        found = found or _from_gh()
        _token.append(found if TOKEN_SHAPE.fullmatch(found) else "")
    return _token[0]


def _origin(url: str) -> tuple:
    parts = urlsplit(url)
    try:
        port = parts.port
    except ValueError:
        return ("", "", None)
    host = (parts.hostname or "").lower()
    return (parts.scheme.lower(), host, port)


def is_github(url: str) -> bool:
    scheme, host, _port = _origin(url)
    return scheme in SCHEMES and host in GITHUB_HOSTS


def _authorize(request: urllib.request.Request) -> bool:
    # An unredirected header never reaches a Request built by a redirect
    # handler; _SameOriginRedirect alone puts it back.
    credential = token() if is_github(request.full_url) else ""
    if credential:
        request.add_unredirected_header("Authorization", f"Bearer {credential}")
    return bool(credential)


class _SameOriginRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        follow = super().redirect_request(req, fp, code, msg, headers, newurl)
        if (follow is not None and req.unredirected_hdrs.get("Authorization")
                and _origin(follow.full_url) == _origin(req.full_url)):
            _authorize(follow)
        return follow


class MissingCredential(RuntimeError):
    """A GitHub host was asked for while no credential resolves."""


MISSING_CREDENTIAL = ("no GitHub credential for {host}: set GH_TOKEN or GITHUB_TOKEN to a "
                      "GitHub token, or sign in with `gh auth login`")


def urlopen(request: urllib.request.Request | str, *, timeout: float):
    """`urllib.request.urlopen`, carrying the credential to GitHub hosts.

    Raises MissingCredential, before any request, for a GitHub host when no
    credential resolves.
    """
    if isinstance(request, str):
        request = urllib.request.Request(request)
    if not _authorize(request):
        if is_github(request.full_url):
            raise MissingCredential(MISSING_CREDENTIAL.format(host=_origin(request.full_url)[1]))
        return urllib.request.urlopen(request, timeout=timeout)
    if not _opener:
        _opener.append(urllib.request.build_opener(_SameOriginRedirect))
    return _opener[0].open(request, timeout=timeout)
