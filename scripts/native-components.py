"""Inventory of the native components shipped inside the vendored resource trees.

A version-based scanner flags a shipped binary by the version it carries,
whether or not the vulnerable code is reachable, and a package-name audit
never sees a library compiled into a wheel or an MSYS2 DLL. This script reads
the versions physically present in resources/{python,tesseract,libreoffice,
jbig2enc} and pins them in scripts/native-components.tsv.

    python scripts/native-components.py --write   regenerate the pin
    python scripts/native-components.py [--check] regenerate in memory, diff
                                                  against the pin, and refuse
                                                  any version below its floor
                                                  in scripts/native-advisories.tsv

Probes, in the order a row's `source` names them:
  runtime      a shipped executable reports the value (the embedded Python
               runtime imports only what it ships; tesseract/jbig2 --version)
  pe-version   the VS_VERSIONINFO resource of the file
  strings      a documented byte pattern in the file (the evidence names it)
  manifest:F   a file inside the tree that states the version

`unknown` is recorded when no probe reads a value; it is never guessed. No
network is used. Standard library only: the release runner runs it on the
Python that setup-python provides.
"""

from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import re
import struct
import subprocess
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pe_imports  # noqa: E402

REPO = Path(__file__).resolve().parents[1]
PIN = REPO / "scripts" / "native-components.tsv"
ADVISORIES = REPO / "scripts" / "native-advisories.tsv"
EVIDENCE = REPO / "scripts" / "native-components-evidence.tsv"
EVIDENCE_HEADER = ("tree", "container", "sha256", "component", "version", "evidence")
TESSERACT_MANIFEST = "scripts/tesseract-licenses.tsv"

HEADER = ("tree", "container", "component", "version", "source", "evidence")
ADVISORY_HEADER = ("component", "floor", "advisory", "disposition")
TREES = ("python", "tesseract", "libreoffice", "jbig2enc")
PE_SUFFIXES = (".dll", ".pyd", ".exe")
UNKNOWN = "unknown"


# --------------------------------------------------------------------------
# Version comparison
# --------------------------------------------------------------------------

_PRE = {"dev": -4, "a": -3, "alpha": -3, "b": -2, "beta": -2, "pre": -2, "rc": -1, "c": -1}
_RELEASE = re.compile(r"\d+(?:\.\d+)*")


def version_key(text: str) -> tuple | None:
    """Sortable key for a version string as upstreams actually print them.

    The leading dotted numeric run is the release. What follows refines it:
    a letter glued to the last number (OpenSSL 1.1.1w) ranks after the bare
    number; a pre-release tag (rc1, a2, beta) ranks before it; a post-release
    count (`+1`, `-3-g<hash>` from git describe) ranks after it; any other
    suffix (a local label such as `+decode.1`, `.zlib-ng`, a build date in
    words) is ignored. None when the text holds no number at all.
    """
    text = text.strip().replace(", ", ".").replace(",", ".")
    m = _RELEASE.search(text)
    if not m:
        return None
    release = [int(p) for p in m.group().split(".")]
    while len(release) > 1 and release[-1] == 0:
        release.pop()
    rest = text[m.end() :]
    letter = 0
    pre: tuple[int, int] = (0, 0)
    post = 0
    lm = re.match(r"([a-z])(?![a-z0-9])", rest)
    if lm:
        letter = ord(lm.group(1)) - ord("a") + 1
        rest = rest[1:]
    pm = re.match(r"[-._]?(dev|alpha|beta|pre|rc|a|b|c)\.?(\d*)(?![a-z])", rest, re.IGNORECASE)
    if pm and not lm:
        pre = (_PRE[pm.group(1).lower()], int(pm.group(2) or 0))
    else:
        qm = re.match(r"(?:\+|-)(\d+)(?:-g[0-9a-f]+|-[0-9a-f]{6,}|$|[^.\d])", rest)
        if qm:
            post = int(qm.group(1))
    return (tuple(release), letter, pre, post)


def compare_versions(a: str, b: str) -> int | None:
    """-1, 0 or 1 as a < b, a == b, a > b; None when either is unparseable."""
    ka, kb = version_key(a), version_key(b)
    if ka is None or kb is None:
        return None
    ra, rb = list(ka[0]), list(kb[0])
    width = max(len(ra), len(rb))
    ra += [0] * (width - len(ra))
    rb += [0] * (width - len(rb))
    left = (ra, ka[1], ka[2], ka[3])
    right = (rb, kb[1], kb[2], kb[3])
    return (left > right) - (left < right)


def _token(text: str) -> str | None:
    """The version token inside a reported string ('OpenSSL 3.5.7 1 Jul 2026' -> '3.5.7')."""
    m = re.search(r"\d+(?:(?:\.|, )\d+)*(?:[a-z](?![a-z]))?(?:[-+.][0-9A-Za-z][0-9A-Za-z.+-]*)?", text)
    if not m:
        return None
    return m.group().replace(", ", ".")


# --------------------------------------------------------------------------
# Byte-pattern probes
# --------------------------------------------------------------------------

_V = rb"(\d+\.\d+(?:\.\d+)*)"
_V16 = rb"((?:\d\x00)+(?:\.\x00(?:\d\x00)+)+)"

# (component, label written to the evidence column, pattern with one group)
SIGNATURES: list[tuple[str, str, re.Pattern]] = [
    ("zlib", 'strings: "deflate <v> Copyright"', re.compile(rb" deflate (\d+\.\d+(?:\.\d+)*(?:\.zlib-ng)?) Copyright")),
    ("zlib", 'strings: "inflate <v> Copyright"', re.compile(rb" inflate (\d+\.\d+(?:\.\d+)*(?:\.zlib-ng)?) Copyright")),
    ("libpng", 'strings: "libpng version <v>"', re.compile(rb"libpng version " + _V)),
    ("libjpeg-turbo", 'strings: "libjpeg-turbo version <v>"', re.compile(rb"libjpeg-turbo version " + _V)),
    ("libtiff", 'strings: "LIBTIFF, Version <v>"', re.compile(rb"LIBTIFF, Version " + _V)),
    ("expat", 'strings: "expat_<v>"', re.compile(rb"expat_" + _V)),
    ("bzip2", 'strings: "<v>, <dd-Mon-yyyy>"', re.compile(rb"\x00" + _V + rb", \d{1,2}-[A-Z][a-z]{2}-\d{4}\x00")),
    ("openssl", 'strings: "OpenSSL <v> <date>"', re.compile(rb"OpenSSL (\d+\.\d+\.\d+[a-z]?) {1,2}\d{1,2} [A-Z][a-z]{2} \d{4}")),
    ("libarchive", 'strings: "libarchive <v>"', re.compile(rb"libarchive " + _V)),
    ("fribidi", 'strings: "(GNU FriBidi) <v>"', re.compile(rb"\(GNU FriBidi\) " + _V)),
    ("gpgme", 'strings: "This is GPGME <v>"', re.compile(rb"This is GPGME " + _V)),
    ("curl", 'strings: "libcurl/<v>"', re.compile(rb"libcurl/" + _V)),
    ("tesseract", 'strings: "tesseract v<v>"', re.compile(rb"tesseract v" + _V)),
    ("firebird", 'strings: "-V<v> Firebird <major.minor>"', re.compile(rb"-V((\d+\.\d+)\.\d+\.\d+) Firebird \2\b")),
    ("libffi", 'strings: UTF-16 "libffi-<v>" (Authenticode program name)', re.compile(re.escape("libffi-".encode("utf-16-le")) + _V16)),
]

# Build-tree paths compiled into assertion messages: "../cairo-1.18.0/src/...".
_PATH_COMPONENTS = {
    "cairo": "cairo",
    "fontconfig": "fontconfig",
    "harfbuzz": "harfbuzz",
    "pixman": "pixman",
    "expat": "expat",
    "gcc": "gcc-runtime",
    "tiff": "libtiff",
    "libpsl": "libpsl",
}
_BUILD_PATH = re.compile(rb"[/\\](" + b"|".join(k.encode() for k in _PATH_COMPONENTS) + rb")-(\d+(?:\.\d+)+)[/\\]")
_STRING = re.compile(rb"[\x20-\x7e]{3,}")
_BARE = {"bare": re.compile(r"\d+\.\d+\.\d+(?:\.\d+)?"), "bare2": re.compile(r"\d+\.\d+(?:\.\d+){0,2}")}
_GCC_IDENT = re.compile(rb"GCC: \([^)]*\) (\d+\.\d+\.\d+)")


def _decode(raw: bytes) -> str:
    return raw.replace(b"\x00", b"").decode("ascii", "replace")


def signature_hits(data: bytes) -> dict[tuple[str, str], str]:
    """{(component, version): evidence} for every self-identifying string."""
    out: dict[tuple[str, str], str] = {}
    for component, label, pattern in SIGNATURES:
        for m in pattern.finditer(data):
            out.setdefault((component, _decode(m.group(1))), label)
    for m in _BUILD_PATH.finditer(data):
        component = _PATH_COMPONENTS[m.group(1).decode()]
        out.setdefault((component, m.group(2).decode()), f'strings: build path "{m.group(1).decode()}-<v>/"')
    return out


def bare_version(data: bytes, claimed: set[str], kind: str = "bare") -> str | None:
    """The one NUL-terminated dotted version literal no signature claims.

    `bare` counts three- and four-part literals only; two-part literals
    ("1.0", "1.1") are namespace and format versions in most binaries.
    `bare2` also counts two-part literals, for a file known to print one.
    """
    found = set()
    for m in _STRING.finditer(data):
        if m.end() < len(data) and data[m.end()] == 0:
            text = m.group().decode()
            if _BARE[kind].fullmatch(text) and text not in claimed:
                found.add(text)
    return found.pop() if len(found) == 1 else None


def gcc_ident(data: bytes) -> str | None:
    """The dominant `GCC: (...) X.Y.Z` ident: the GCC that built the runtime is the runtime."""
    counts = Counter(m.group(1).decode() for m in _GCC_IDENT.finditer(data))
    return counts.most_common(1)[0][0] if counts else None


# --------------------------------------------------------------------------
# Rows
# --------------------------------------------------------------------------

Row = tuple[str, str, str, str, str, str]


def _clean(text: str) -> str:
    return " ".join(str(text).replace("\t", " ").split())


def row(tree: str, container: str, component: str, version: str | None, source: str, evidence: str) -> Row:
    return (tree, container, component, _clean(version) if version else UNKNOWN, source, _clean(evidence))


def _rel(path: Path, root: Path) -> str:
    return path.relative_to(root).as_posix()


def _pe_files(root: Path) -> list[Path]:
    return sorted(
        (p for p in root.rglob("*") if p.suffix.lower() in PE_SUFFIXES and p.is_file()),
        key=lambda p: p.as_posix().lower(),
    )


def _stated(value: str | None) -> str | None:
    """The version token of a resource field, None when it states nothing (0.0.0.0)."""
    token = _token(value) if value else None
    if token and any(ch not in "0.," for ch in token):
        return token
    return None


def _pe_version(path: Path) -> tuple[str | None, dict[str, str]]:
    """(version, resource strings); version prefers the ProductVersion string."""
    try:
        info = pe_imports.version_info(path) or {}
    except (pe_imports.NotPE, ValueError, IndexError, struct.error):
        return None, {}
    for key in ("ProductVersion", "FileVersion", "ProductVersion#", "FileVersion#"):
        token = _stated(info.get(key))
        if token:
            return token, info
    return None, info


def _pe_evidence(info: dict[str, str]) -> str:
    for key in ("ProductVersion", "FileVersion"):
        if _stated(info.get(key)):
            return f"VS_VERSIONINFO {key}"
    return "VS_VERSIONINFO fixed ProductVersion"


def load_evidence(path: Path = EVIDENCE) -> dict[tuple[str, str], tuple[str, str, str, str]]:
    """{(tree, container): (sha256, component, version, evidence)} from the pinned evidence file.

    Each row records a version established off-line for exact bytes (an
    upstream package whose copy of the file has this SHA-256). The row
    applies only while the shipped file still hashes to it.
    """
    if not path.is_file():
        return {}
    out = {}
    for tree, container, sha, component, version, evidence in parse_tsv(
            path.read_text(encoding="utf-8"), EVIDENCE_HEADER, path.name):
        out[(tree, container)] = (sha.lower(), component, version, evidence)
    return out


class Inventory:
    def __init__(self, resources: Path, evidence: dict | None = None):
        self.resources = resources
        self.rows: list[Row] = []
        self.data_cache: dict[Path, bytes] = {}
        self.evidence = load_evidence() if evidence is None else evidence

    def data(self, path: Path) -> bytes:
        if path not in self.data_cache:
            self.data_cache[path] = path.read_bytes()
        return self.data_cache[path]

    def add(self, *fields) -> None:
        self.rows.append(row(*fields))

    def embedded(self, tree: str, root: Path, path: Path, own: set[str]) -> dict[tuple[str, str], str]:
        """Rows for libraries compiled into `path`; returns every hit, own included."""
        hits = signature_hits(self.data(path))
        for (component, version), evidence in sorted(hits.items()):
            if component not in own:
                self.add(tree, _rel(path, root), component, version, "strings", evidence)
        return hits

    def primary(self, tree: str, root: Path, path: Path, component: str, fallback: str | None = None,
                stamped_by: str | None = None) -> None:
        """One row for the component `path` itself is a build of, plus embedded rows."""
        container = _rel(path, root)
        hits = self.embedded(tree, root, path, {component})
        version, info = _pe_version(path)
        product = info.get("ProductName", "")
        if version and not (stamped_by and product == stamped_by):
            self.add(tree, container, component, version, "pe-version", _pe_evidence(info))
            return
        own = sorted((v, e) for (c, v), e in hits.items() if c == component)
        if own:
            for v, e in own:
                self.add(tree, container, component, v, "strings", e)
            return
        if version:
            why = f"VS_VERSIONINFO carries the {stamped_by} release"
        else:
            why = "VS_VERSIONINFO states no version" if info else "no version resource"
        data = self.data(path)
        pinned = self.evidence.get((tree, container))
        if pinned and pinned[1] == component:
            sha = hashlib.sha256(data).hexdigest()
            if sha == pinned[0]:
                self.add(tree, container, component, pinned[2], f"manifest:{EVIDENCE.relative_to(REPO).as_posix()}",
                         f"sha256 {sha[:16]}: {pinned[3]}")
                return
            why += f"; evidence row is for sha256 {pinned[0][:16]}, shipped {sha[:16]}"
        if fallback in _BARE:
            value = bare_version(data, {v for (_c, v) in hits}, fallback)
            if value:
                self.add(tree, container, component, value, "strings", f"{why}; strings: sole standalone version literal")
                return
        elif fallback == "gcc-ident":
            value = gcc_ident(data)
            if value:
                self.add(tree, container, component, value, "strings", f'{why}; strings: dominant "GCC: (...) <v>" ident')
                return
        tried = {"bare": "; no sole standalone version literal", "bare2": "; no sole standalone version literal",
                 "gcc-ident": "; no GCC ident"}.get(fallback or "", "")
        self.add(tree, container, component, None, "strings", f"{why}; no identifying string{tried}")


# --------------------------------------------------------------------------
# Runtime probes
# --------------------------------------------------------------------------

def _run(argv: list[str], cwd: Path) -> str:
    done = subprocess.run(argv, cwd=cwd, capture_output=True, text=True, timeout=300)
    if done.returncode != 0:
        raise RuntimeError(f"{' '.join(argv[:2])} exited {done.returncode}: {done.stderr.strip()[-400:]}")
    return done.stdout + done.stderr


# Imports only what the embedded runtime ships; prints [container, component, raw, expression] rows.
PYTHON_PROBE = r"""
import importlib, json, platform, sys
out = []
def origin(mod):
    return getattr(importlib.import_module(mod), "__file__", None)
def add(container, component, raw, expr):
    if raw is not None and raw != "":
        out.append([container, component, str(raw), expr])
add("python.exe", "cpython", platform.python_version(), "platform.python_version()")
import ssl, sqlite3, pyexpat, zlib, decimal
add("libssl-3.dll", "openssl", ssl.OPENSSL_VERSION, "ssl.OPENSSL_VERSION")
add("sqlite3.dll", "sqlite", sqlite3.sqlite_version, "sqlite3.sqlite_version")
add(origin("pyexpat"), "expat", pyexpat.EXPAT_VERSION, "pyexpat.EXPAT_VERSION")
zc = origin("zlib") or "python314.dll"
if hasattr(zlib, "ZLIBNG_VERSION"):
    add(zc, "zlib-ng", zlib.ZLIBNG_VERSION, "zlib.ZLIBNG_VERSION")
add(zc, "zlib", zlib.ZLIB_RUNTIME_VERSION, "zlib.ZLIB_RUNTIME_VERSION")
add(origin("_decimal"), "mpdecimal", decimal.__libmpdec_version__, "decimal.__libmpdec_version__")
try:
    from compression import zstd
    add(origin("_zstd"), "zstd", zstd.zstd_version, "compression.zstd.zstd_version")
except ImportError:
    pass
if SITE:
    from PIL import features
    names = {"freetype2": "freetype", "littlecms2": "littlecms", "webp": "libwebp", "avif": "libavif",
             "jpg_2000": "openjpeg", "zlib": "zlib", "libtiff": "libtiff", "raqm": "raqm",
             "fribidi": "fribidi", "harfbuzz": "harfbuzz", "libjpeg_turbo": "libjpeg-turbo",
             "mozjpeg": "mozjpeg", "zlib_ng": "zlib-ng", "libimagequant": "libimagequant", "xcb": "libxcb"}
    for name, component in names.items():
        if name in features.modules:
            mod = features.modules[name][0]
        elif name in features.features:
            mod = features.features[name][0]
        else:
            mod = "PIL._imaging"
        value = features.version(name)
        if name == "zlib" and value and "zlib-ng" in value:
            component = "zlib-ng-compat"
        add(origin(mod), component, value, f"PIL.features.version({name!r})")
    from PIL import _avif
    for codec, ver in __import__("re").findall(r"(\w+) \[[^\]]*\]:([^,\s]+)", _avif.codec_versions()):
        add(origin("PIL._avif"), codec, ver, "PIL._avif.codec_versions()")
    from lxml import etree
    add(origin("lxml.etree"), "libxml2", ".".join(map(str, etree.LIBXML_VERSION)), "lxml.etree.LIBXML_VERSION")
    add(origin("lxml.etree"), "libxslt", ".".join(map(str, etree.LIBXSLT_VERSION)), "lxml.etree.LIBXSLT_VERSION")
    from cryptography.hazmat.backends.openssl import backend
    add(origin("cryptography.hazmat.bindings._rust"), "openssl", backend.openssl_version_text(),
        "cryptography backend.openssl_version_text()")
    import pikepdf
    add("glob:pikepdf.libs/qpdf*.dll", "qpdf", pikepdf.__libqpdf_version__, "pikepdf.__libqpdf_version__")
    import numpy
    blas = numpy.show_config(mode="dicts")["Build Dependencies"]["blas"]
    add("glob:numpy.libs/libscipy_openblas*.dll", "openblas", blas.get("version"),
        "numpy.show_config(mode='dicts') Build Dependencies blas.version")
    import uharfbuzz
    add(origin("uharfbuzz._harfbuzz"), "harfbuzz", uharfbuzz.version_string(), "uharfbuzz.version_string()")
    import pillow_heif
    info = pillow_heif.libheif_info()
    add("glob:heif-*.dll", "libheif", info.get("libheif"), "pillow_heif.libheif_info()['libheif']")
    for name, text in (info.get("decoders") or {}).items():
        m = __import__("re").search(r"version (\S+)", text)
        add("glob:" + name + "-*.dll", name, m.group(1) if m else None,
            f"pillow_heif.libheif_info()['decoders'][{name!r}]")
print(json.dumps(out))
"""

LO_PYTHON_PROBE = r"""
import json, platform, ssl, sqlite3, pyexpat, zlib, decimal
out = [["cpython", platform.python_version(), "platform.python_version()"],
       ["openssl", ssl.OPENSSL_VERSION, "ssl.OPENSSL_VERSION"],
       ["sqlite", sqlite3.sqlite_version, "sqlite3.sqlite_version"],
       ["expat", pyexpat.EXPAT_VERSION, "pyexpat.EXPAT_VERSION"],
       ["zlib", zlib.ZLIB_RUNTIME_VERSION, "zlib.ZLIB_RUNTIME_VERSION"],
       ["mpdecimal", decimal.__libmpdec_version__, "decimal.__libmpdec_version__"]]
import ctypes, glob, os
os.add_dll_directory(os.getcwd())
for dll in sorted(glob.glob("sqlite3.dll") + glob.glob("python-core-*/lib/sqlite3.dll")):
    lib = ctypes.CDLL(os.path.abspath(dll))
    lib.sqlite3_libversion.restype = ctypes.c_char_p
    out.append(["sqlite", lib.sqlite3_libversion().decode(), "ctypes sqlite3_libversion()", "program/" + dll.replace(chr(92), "/")])
print(json.dumps(out))
"""

# `--version` lines of tesseract and jbig2enc (both print leptonica's report).
VERSION_TOKENS: list[tuple[str, re.Pattern]] = [
    ("tesseract", re.compile(r"^tesseract v(\S+)", re.M)),
    ("jbig2enc", re.compile(r"^jbig2enc (\S+)", re.M)),
    ("leptonica", re.compile(r"leptonica-(\d\S*)")),
    ("giflib", re.compile(r"libgif (\S+)")),
    ("libjpeg-turbo", re.compile(r"libjpeg-turbo (\d[^)\s]*)")),
    ("libpng", re.compile(r"libpng (\S+)")),
    ("libtiff", re.compile(r"libtiff (\S+)")),
    ("zlib", re.compile(r"(?:^|: | )zlib (\S+)", re.M)),
    ("libwebp", re.compile(r"libwebp (\S+)")),
    ("openjpeg", re.compile(r"libopenjp2 (\S+)")),
    ("libarchive", re.compile(r"libarchive (\S+)")),
    ("zlib", re.compile(r"zlib/(\S+)")),
    ("xz", re.compile(r"liblzma/(\S+)")),
    ("bzip2", re.compile(r"bz2lib/(\S+)")),
    ("lz4", re.compile(r"liblz4/(\S+)")),
    ("zstd", re.compile(r"libzstd/(\S+)")),
]


def version_report_rows(text: str) -> list[tuple[str, str, str]]:
    """[(component, version, token)] from a leptonica-style --version report."""
    out = []
    for component, pattern in VERSION_TOKENS:
        for m in pattern.finditer(text):
            out.append((component, m.group(1).rstrip(":,"), m.group(0).strip(" :")))
    return out


# --------------------------------------------------------------------------
# Trees
# --------------------------------------------------------------------------

PYTHON_ROOT_FILES = {
    "python.exe": "cpython",
    "python3.dll": "cpython",
    "python314.dll": "cpython",
    "libcrypto-3.dll": "openssl",
    "libssl-3.dll": "openssl",
    "sqlite3.dll": "sqlite",
    "libffi-8.dll": "libffi",
    "libtommath.dll": "libtommath",
    "vcruntime140.dll": "msvc-runtime",
    "vcruntime140_1.dll": "msvc-runtime",
}

# Nested libraries a wheel vendors beside its extension modules.
SITE_NESTED = [
    ("heif-*.dll", "libheif"),
    ("libde265-*.dll", "libde265"),
    ("pikepdf.libs/qpdf*.dll", "qpdf"),
    ("numpy.libs/libscipy_openblas*.dll", "openblas"),
    ("*.libs/msvcp140*.dll", "msvc-runtime"),
    ("*.libs/vcruntime140*.dll", "msvc-runtime"),
    ("*.libs/concrt140*.dll", "msvc-runtime"),
]


def _dist_rows(inv: Inventory, root: Path, site: Path) -> None:
    for dist in sorted(site.glob("*.dist-info"), key=lambda p: p.name.lower()):
        record = dist / "RECORD"
        if not record.is_file():
            continue
        native = sorted(
            line.split(",", 1)[0]
            for line in record.read_text(encoding="utf-8").splitlines()
            if line.split(",", 1)[0].lower().endswith((".pyd", ".dll"))
        )
        if not native:
            continue
        meta = (dist / "METADATA").read_text(encoding="utf-8", errors="replace")
        name = re.search(r"^Name: *(.+)$", meta, re.M).group(1).strip()
        version = re.search(r"^Version: *(.+)$", meta, re.M).group(1).strip()
        inv.add("python", _rel(dist, root), re.sub(r"[-_.]+", "-", name).lower(), version,
                f"manifest:{_rel(dist, root)}/METADATA",
                f"METADATA Version; RECORD native files: {len(native)}")


def inventory_python(inv: Inventory, runtime: bool = True) -> None:
    root = inv.resources / "python"
    site = root / "Lib" / "site-packages"
    tree = "python"
    probe_rows: list[list[str]] = []
    if runtime:
        code = PYTHON_PROBE.replace("if SITE:", f"if {site.is_dir()!r}:")
        probe_rows = json.loads(_run([str(root / "python.exe"), "-I", "-c", code], root).strip().splitlines()[-1])
    covered: set[tuple[str, str]] = set()
    for container, component, raw, expr in probe_rows:
        if container.startswith("glob:"):
            matches = sorted(site.glob(container[5:]))
            if len(matches) != 1:
                raise RuntimeError(f"runtime probe {expr}: {container[5:]} matches {len(matches)} files")
            path = matches[0]
        else:
            path = Path(container) if Path(container).is_absolute() else root / container
        rel = _rel(path.resolve(), root.resolve())
        covered.add((rel, component))
        inv.add(tree, rel, component, _token(raw) or raw, "runtime", f"python.exe -I: {expr}")

    for path in _pe_files(root):
        rel = _rel(path, root)
        in_site = site in path.parents
        if not in_site and path.name in PYTHON_ROOT_FILES:
            component = PYTHON_ROOT_FILES[path.name]
            if (rel, component) in covered and not _pe_version(path)[0]:
                inv.embedded(tree, root, path, {component})
                continue
            inv.primary(tree, root, path, component)
            continue
        if in_site and path.suffix.lower() == ".dll":
            srel = _rel(path, site)
            component = next((c for pat, c in SITE_NESTED if fnmatch.fnmatch(srel, pat)), None)
            if component is None:
                version, info = _pe_version(path)
                component = info.get("ProductName") or path.name
                inv.add(tree, rel, _clean(component), version, "pe-version" if version else "strings",
                        _pe_evidence(info) if version else "unmapped nested library; no version resource")
                inv.embedded(tree, root, path, set())
                continue
            if (rel, component) in covered:
                version, info = _pe_version(path)
                if version:
                    inv.add(tree, rel, component, version, "pe-version", _pe_evidence(info))
                inv.embedded(tree, root, path, {component})
                continue
            inv.primary(tree, root, path, component)
            continue
        inv.embedded(tree, root, path, set())
    if site.is_dir():
        _dist_rows(inv, root, site)


# Canonical names for the upstream projects scripts/tesseract-licenses.tsv names.
TESSERACT_COMPONENTS = {
    "LERC": "lerc",
    "libarchive": "libarchive",
    "libb2 (BLAKE2)": "libb2",
    "Brotli": "brotli",
    "bzip2": "bzip2",
    "Cairo": "cairo",
    "OpenSSL": "openssl",
    "libdatrie": "libdatrie",
    "libdeflate": "libdeflate",
    "Expat": "expat",
    "libffi": "libffi",
    "fontconfig": "fontconfig",
    "FreeType": "freetype",
    "GNU FriBidi": "fribidi",
    "GCC runtime library": "gcc-runtime",
    "giflib": "giflib",
    "GLib": "glib",
    "Graphite2": "graphite2",
    "HarfBuzz": "harfbuzz",
    "GNU libiconv": "libiconv",
    "ICU": "icu",
    "GNU gettext (libintl)": "gettext",
    "libjpeg-turbo": "libjpeg-turbo",
    "Leptonica": "leptonica",
    "LZ4": "lz4",
    "XZ Utils (liblzma)": "xz",
    "OpenJPEG": "openjpeg",
    "Pango": "pango",
    "PCRE2": "pcre2",
    "Pixman": "pixman",
    "libpng": "libpng",
    "libwebp": "libwebp",
    "libstdc++": "gcc-runtime",
    "Tesseract OCR": "tesseract",
    "libthai": "libthai",
    "libtiff (rebuilt without JBIG)": "libtiff",
    "mingw-w64 (winpthreads)": "mingw-w64-winpthreads",
    "Zstandard": "zstd",
    "zlib": "zlib",
    "curl (libcurl)": "curl",
    "libssh2": "libssh2",
    "GNU Libidn2": "libidn2",
    "GNU libunistring": "libunistring",
    "libpsl (with the built-in Public Suffix List)": "libpsl",
}

# Files whose component prints no self-identifying string but carries one literal.
TESSERACT_FALLBACK = {
    "libopenjp2-7.dll": "bare",
    "libzstd.dll": "bare",
    "libicuuc*.dll": "bare2",
    "libharfbuzz-0.dll": "bare",
    "libidn2-0.dll": "bare",
    "libgcc_s_seh-1.dll": "gcc-ident",
}


def _manifest_files(path: Path) -> dict[str, str]:
    out = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip() or line.startswith("#") or line.startswith("file\t"):
            continue
        cols = line.split("\t")
        out[cols[0]] = cols[1]
    return out


def inventory_tesseract(inv: Inventory, runtime: bool = True, manifest: Path | None = None) -> None:
    root = inv.resources / "tesseract"
    tree = "tesseract"
    files = _manifest_files(manifest or REPO / TESSERACT_MANIFEST)
    if runtime:
        report = _run([str(root / "tesseract.exe"), "--version"], root)
        for component, version, token in version_report_rows(report):
            inv.add(tree, "tesseract.exe", component, version, "runtime", f'tesseract.exe --version: "{token}"')
    for path in _pe_files(root):
        name = path.name
        if path.parent != root:
            inv.embedded(tree, root, path, set())
            continue
        if name not in files:
            raise RuntimeError(f"resources/tesseract/{name} has no row in {TESSERACT_MANIFEST}")
        upstream = files[name]
        if upstream not in TESSERACT_COMPONENTS:
            raise RuntimeError(f"{TESSERACT_MANIFEST} component {upstream!r} has no canonical name here")
        if runtime and name == "tesseract.exe":
            inv.embedded(tree, root, path, {"tesseract"})
            continue
        inv.primary(tree, root, path, TESSERACT_COMPONENTS[upstream], next((v for k, v in TESSERACT_FALLBACK.items() if fnmatch.fnmatch(name, k)), None))


# program/ files that are third-party builds. LibreOffice stamps its own
# release into the version resource of the ones it compiles itself, so the
# resource is read only when it names another product. None marks a file
# scanned for embedded libraries only.
LIBREOFFICE_THIRD_PARTY = {
    "Argon2OptDll.dll": "argon2",
    "CoinMP.dll": "coinmp",
    "Engine12.dll": "firebird",
    "ifbclient.dll": "firebird",
    "intl/fbintl.dll": "firebird",
    "clucene.dll": "clucene",
    "epoxy.dll": "libepoxy",
    "etonyek.dll": "libetonyek",
    "gpgmepp.dll": "gpgme",
    "gpgme-w32spawn.exe": "gpgme",
    "freebl3.dll": "nss",
    "nss3.dll": "nss",
    "nssckbi.dll": "nss-builtin-roots",
    "nssdbm3.dll": "nss",
    "nssutil3.dll": "nss",
    "smime3.dll": "nss",
    "softokn3.dll": "nss",
    "ssl3.dll": "nss",
    "nspr4.dll": "nspr",
    "plc4.dll": "nspr",
    "plds4.dll": "nspr",
    "icudt78.dll": "icu",
    "icuin78.dll": "icu",
    "icuuc78.dll": "icu",
    "lcms2.dll": "littlecms",
    "libcrypto-3.dll": "openssl",
    "libssl-3.dll": "openssl",
    "libcurl.dll": "curl",
    "libpq.dll": "postgresql-libpq",
    "libxml2.dll": "libxml2",
    "libxslt.dll": "libxslt",
    "libexslt.dll": "libxslt",
    "libxmlsec.dll": "xmlsec",
    "libxmlsec-mscng.dll": "xmlsec",
    "lpsolve55.dll": "lp_solve",
    "librdf.dll": "redland-librdf",
    "raptor2.dll": "raptor",
    "rasqal.dll": "rasqal",
    "mwaw.dll": "libmwaw",
    "odfgen.dll": "libodfgen",
    "orcus.dll": "liborcus",
    "orcus-parser.dll": "liborcus",
    "revenge.dll": "librevenge",
    "wpd.dll": "libwpd",
    "wpg.dll": "libwpg",
    "wps.dll": "libwps",
    "staroffice.dll": "libstaroffice",
    "pdfiumlo.dll": "pdfium",
    "skialo.dll": "skia",
    "xpdfimport.exe": "poppler",
    "sqlite3.dll": "sqlite",
    "python.exe": None,
    "python3.dll": "cpython",
    "python312.dll": "cpython",
    "python-core-*/bin/python.exe": "cpython",
    "python-core-*/bin/pythonw.exe": "cpython",
    "python-core-*/bin/venvlauncher.exe": "cpython",
    "python-core-*/lib/libcrypto-3.dll": "openssl",
    "python-core-*/lib/libssl-3.dll": "openssl",
    "python-core-*/lib/libffi-8.dll": "libffi",
    "python-core-*/lib/sqlite3.dll": "sqlite",
    "python-core-*/lib/*.pyd": None,
    "python-core-*/lib/pip/_vendor/distlib/*.exe": "distlib-launcher",
    "python-core-*/lib/setuptools/*.exe": "setuptools",
}

LIBREOFFICE_FALLBACK = {
    "librdf.dll": "bare",
    "raptor2.dll": "bare",
    "rasqal.dll": "bare",
    "odfgen.dll": "bare",
    "sqlite3.dll": "bare",
    "python-core-*/lib/libffi-8.dll": "bare",
}

LIBREOFFICE_PRODUCT = "LibreOffice"


def _lo_lookup(table: dict, rel: str):
    if rel in table:
        return rel, table[rel]
    for pattern, value in table.items():
        if "*" in pattern and fnmatch.fnmatch(rel, pattern):
            return pattern, value
    return None, None


def inventory_libreoffice(inv: Inventory, runtime: bool = True) -> None:
    root = inv.resources / "libreoffice"
    program = root / "program"
    tree = "libreoffice"
    ini = program / "version.ini"
    buildid = re.search(r"^buildid=(\S+)", ini.read_text(encoding="utf-8", errors="replace"), re.M)
    inv.add(tree, "program/version.ini", "libreoffice-buildid", buildid.group(1) if buildid else None,
            "manifest:program/version.ini", "version.ini buildid")
    soffice = program / "soffice.exe"
    version, info = _pe_version(soffice)
    inv.add(tree, "program/soffice.exe", "libreoffice", version, "pe-version", _pe_evidence(info))
    covered: set[tuple[str, str]] = set()
    if runtime:
        probe = json.loads(_run([str(program / "python.exe"), "-I", "-c", LO_PYTHON_PROBE], program)
                           .strip().splitlines()[-1])
        for component, raw, expr, *where in probe:
            container = where[0] if where else "program/python.exe"
            covered.add((container, component))
            inv.add(tree, container, component, _token(raw) or raw, "runtime", f"program/python.exe -I: {expr}")
    for path in _pe_files(program):
        rel = _rel(path, program)
        pattern, component = _lo_lookup(LIBREOFFICE_THIRD_PARTY, rel)
        if pattern is not None and component is None:
            inv.embedded(tree, root, path, set())
            continue
        if component is None:
            version, info = _pe_version(path)
            product = _clean(info.get("ProductName", ""))
            if version and product and product != LIBREOFFICE_PRODUCT:
                inv.add(tree, _rel(path, root), product, version, "pe-version", _pe_evidence(info))
            inv.embedded(tree, root, path, set())
            continue
        if (_rel(path, root), component) in covered:
            inv.embedded(tree, root, path, {component})
            continue
        _p, fallback = _lo_lookup(LIBREOFFICE_FALLBACK, rel)
        inv.primary(tree, root, path, component, fallback, stamped_by=LIBREOFFICE_PRODUCT)


def inventory_jbig2enc(inv: Inventory, runtime: bool = True) -> None:
    root = inv.resources / "jbig2enc"
    tree = "jbig2enc"
    if runtime:
        report = _run([str(root / "jbig2.exe"), "--version"], root)
        for component, version, token in version_report_rows(report):
            inv.add(tree, "jbig2.exe", component, version, "runtime", f'jbig2.exe --version: "{token}"')
    aliases = {"tiff": "libtiff", "openjp2": "openjpeg"}
    depmf = json.loads((root / "depmf.json").read_text(encoding="utf-8"))
    for name, project in sorted(depmf.get("projects", {}).items()):
        inv.add(tree, "depmf.json", aliases.get(name, name), project.get("version"), "manifest:depmf.json",
                f"depmf.json projects.{name}.version")
    for path in _pe_files(root):
        inv.embedded(tree, root, path, set())


def generate(resources: Path, runtime: bool = True) -> list[Row]:
    missing = [t for t in TREES if not (resources / t).is_dir()]
    if missing:
        raise RuntimeError("not provisioned: " + ", ".join(f"resources/{t}" for t in missing))
    inv = Inventory(resources)
    inventory_python(inv, runtime)
    inventory_tesseract(inv, runtime)
    inventory_libreoffice(inv, runtime)
    inventory_jbig2enc(inv, runtime)
    return sort_rows(inv.rows)


# --------------------------------------------------------------------------
# Pin, floors, report
# --------------------------------------------------------------------------

def sort_rows(rows) -> list[Row]:
    unique = set(rows)
    return sorted(unique, key=lambda r: (TREES.index(r[0]) if r[0] in TREES else 99, r[1].lower(), r[1],
                                         r[2], r[4], r[5], r[3]))


def render(rows: list[Row]) -> str:
    return "".join("\t".join(r) + "\n" for r in [HEADER, *sort_rows(rows)])


def parse_tsv(text: str, header: tuple[str, ...], what: str) -> list[tuple[str, ...]]:
    """Rows of a tab-separated file; `#` comment lines and CR line ends are ignored."""
    lines = [ln.rstrip("\r") for ln in text.splitlines() if ln.strip() and not ln.startswith("#")]
    if not lines or tuple(lines[0].split("\t")) != header:
        raise ValueError(f"{what}: header must be the tab-separated columns {', '.join(header)}")
    out = []
    for n, line in enumerate(lines[1:], start=2):
        cols = tuple(line.split("\t"))
        if len(cols) != len(header):
            raise ValueError(f"{what}: row {n}: expected {len(header)} columns, found {len(cols)}")
        out.append(cols)
    return out


def diff(pinned: list[Row], current: list[Row]) -> list[str]:
    """One line per difference, naming the component and container."""
    old, new = Counter(pinned), Counter(current)
    removed = sorted((old - new).elements())
    added = sorted((new - old).elements())
    out = []
    by_key = {}
    for r in removed:
        by_key.setdefault((r[0], r[1], r[2], r[4], r[5]), []).append(r)
    rest_added = []
    for r in added:
        key = (r[0], r[1], r[2], r[4], r[5])
        if by_key.get(key):
            was = by_key[key].pop(0)
            out.append(f"changed: {r[2]} in {r[0]}/{r[1]}: pinned {was[3]}, shipped {r[3]} ({r[4]})")
        else:
            rest_added.append(r)
    for rows in by_key.values():
        for r in rows:
            out.append(f"no longer shipped: {r[2]} {r[3]} in {r[0]}/{r[1]} ({r[4]})")
    for r in rest_added:
        out.append(f"not pinned: {r[2]} {r[3]} in {r[0]}/{r[1]} ({r[4]})")
    return out


# Advisory-file names that differ from the inventory's canonical names;
# every other name matches case-insensitively.
ADVISORY_ALIASES = {
    "xz utils": "xz",
    "liblzma": "xz",
    "zstandard": "zstd",
    "postgresql": "postgresql-libpq",
    "libpq": "postgresql-libpq",
    "little cms": "littlecms",
    "lcms2": "littlecms",
    "msvc runtime": "msvc-runtime",
    "gcc runtime": "gcc-runtime",
    "redland": "redland-librdf",
    "libaom": "aom",
}


def canonical(component: str) -> str:
    name = component.strip().lower()
    return ADVISORY_ALIASES.get(name, name)


def _branch(version: str) -> tuple[int, int] | None:
    key = version_key(version)
    if key is None:
        return None
    release = list(key[0]) + [0]
    return (release[0], release[1])


def floor_for(version: str, floors: list[str]) -> str:
    """The floor of the listed release branch `version` is on, else the lowest listed floor."""
    branch = _branch(version)
    for f in floors:
        if branch is not None and _branch(f) == branch:
            return f
    lowest = floors[0]
    for f in floors[1:]:
        if compare_versions(f, lowest) == -1:
            lowest = f
    return lowest


def breaches(rows: list[Row], advisories: list[tuple[str, ...]]) -> list[str]:
    """Every shipped version below a floor, every EXEMPT row, and every floor naming nothing shipped.

    A disposition starting `EXEMPT:` is an owner-ruled exemption: its lines
    start `EXEMPT:` and do not fail the gate.
    """
    out = []
    by_component: dict[str, list[Row]] = {}
    for r in rows:
        by_component.setdefault(canonical(r[2]), []).append(r)
    unmatched: Counter = Counter()
    for component, floor, advisory, disposition in advisories:
        floors = [f.strip() for f in floor.split(",") if f.strip() not in ("-", "")]
        if not floors:
            continue
        shipped = by_component.get(canonical(component), [])
        if not shipped:
            unmatched[component.strip()] += 1
            continue
        exempt = disposition.strip().startswith("EXEMPT:")
        for r in shipped:
            limit = floor_for(r[3] if r[3] != UNKNOWN else "", floors)
            cmp = compare_versions(r[3], limit) if r[3] != UNKNOWN else None
            if cmp is not None and cmp >= 0:
                continue
            if exempt:
                out.append(f"EXEMPT: {component} {r[3]} in {r[0]}/{r[1]} below {limit} ({advisory})")
            elif cmp is None:
                out.append(f"unverifiable: {component} in {r[0]}/{r[1]} reports {r[3]!r}, floor {limit} ({advisory})")
            else:
                out.append(f"below floor: {component} {r[3]} in {r[0]}/{r[1]} < {limit} ({advisory})")
    for name, count in sorted(unmatched.items()):
        out.append(f"floor names no shipped component: {name} ({count} advisories)")
    return out


def check(current: list[Row], pin_text: str | None, advisories_text: str | None) -> list[str]:
    problems = []
    if pin_text is None:
        problems.append(f"{PIN.relative_to(REPO).as_posix()} is missing; run --write")
    else:
        problems += diff(parse_tsv(pin_text, HEADER, "native-components.tsv"), current)
    if advisories_text is None:
        problems.append(f"{ADVISORIES.relative_to(REPO).as_posix()} is missing; floors cannot be checked")
    else:
        problems += breaches(current, parse_tsv(advisories_text, ADVISORY_HEADER, "native-advisories.tsv"))
    return problems


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--write", action="store_true")
    mode.add_argument("--check", action="store_true")
    ap.add_argument("--resources", type=Path, default=REPO / "resources")
    args = ap.parse_args(argv)
    try:
        current = generate(args.resources)
    except (RuntimeError, OSError, ValueError, subprocess.TimeoutExpired) as exc:
        print(f"native-components: {exc}", file=sys.stderr)
        return 1
    if args.write:
        PIN.write_text(render(current), encoding="utf-8", newline="\n")
        print(f"native-components: wrote {len(current)} rows to {PIN.relative_to(REPO).as_posix()}")
        return 0
    pin_text = PIN.read_text(encoding="utf-8") if PIN.is_file() else None
    adv_text = ADVISORIES.read_text(encoding="utf-8") if ADVISORIES.is_file() else None
    try:
        problems = check(current, pin_text, adv_text)
    except ValueError as exc:
        print(f"native-components: {exc}", file=sys.stderr)
        return 1
    for p in problems:
        print(f"native-components: {p}")
    failing = [p for p in problems if not p.startswith("EXEMPT: ")]
    if failing:
        print(f"native-components: FAIL ({len(failing)} problem(s), {len(current)} rows)")
        return 1
    print(f"native-components: OK ({len(current)} rows match the pin and clear every enforced floor)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
