"""Separation preview — the ink inventory and the separation raster.

Three capabilities, in the order the preview uses them.

`list_inks` enumerates the `/Separation` and `/DeviceN` colorants a page can
paint with, resolving each to a display colour through `color_spaces`. It
reports what it could NOT read beside what it found: a resource branch the
walk skipped may hold an ink, and a plate inventory that answered only with
what it reached would hide one.

`render_separations` rasterizes one page to one 8-bit grayscale plate per
separation through Ghostscript's `tiffsep` device. **Plate polarity is
inverted: 0 is FULL ink and 255 is no ink.** The 4-channel composite the
device writes alongside the plates folds spots into process and therefore
cannot drive a spot toggle — the preview composites from the individual
plates instead.

`composite_separations` turns a chosen subset of those plates into an RGB PNG
plus the total-ink statistics, in numpy, so toggling an ink never re-runs
Ghostscript.

**Overprint can only be simulated by the separation device.** Every RGB device
renders an overprinting fill identically to a knocking-out one, so no RGB
raster — including the viewer's own — can show overprint. `-dOverprint=/disable`
turns the simulation off; nothing turns it on, because it is the default.

**`inkcov` is a page average, not an alarm.** On a page whose true maximum
total ink is 340 %, its four fractions sum to 200 %. It ships as what it is —
per-ink page coverage — and the over-limit alarm reads the per-pixel maximum
off the plates.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import tempfile
from pathlib import Path

import pikepdf

from . import budget
from .color_spaces import build_resolver
from .preflight import COLORSPACE, walk_page_resources
from .validate import validate_pdf

# The four exact spellings the separation device uses for process inks. A
# colorant named anything else is a spot.
PROCESS_INKS = ("Cyan", "Magenta", "Yellow", "Black")

# The device's own spot ceiling. Past it, spots fold silently into process.
MAX_SPOTS_CEILING = 60
_MIN_SPOT_REQUEST = 10

# Printed on stdout when the device folds spots it could not keep.
_FOLD_MARKER = "Max spot colorants reached"

# Bytes the plate-filename escape replaces: the escape marker itself, plus
# every character a Windows path forbids. Everything else printable passes
# through verbatim.
_ESCAPED_BYTES = frozenset(b'%/\\:*?"<>|')

_PREVIEW_DIR_NAME = "separation-preview"
# Plate sets left by earlier previews are evicted oldest-first past this many.
_MAX_CACHED_SETS = 24


def plate_name_escape(name: str) -> str:
    """The device's plate-filename spelling of an ink name.

    Every byte outside printable ASCII, and every byte in the reserved set, is
    written `%XX`; the rest pass through. Measured over an adversarial name
    set against the bundled device — and used to PREDICT the filename, never
    to parse an ink name back out of one, because the convention is the
    device's internal business and can move between versions.
    """
    out: list[str] = []
    for byte in name.encode("utf-8"):
        if 32 <= byte <= 126 and byte not in _ESCAPED_BYTES:
            out.append(chr(byte))
        else:
            out.append(f"%{byte:02X}")
    return "".join(out)


def ink_kind(name: str) -> str:
    """`process`, `all`, `none` or `spot`.

    `/All` and `/None` are not inks: `/All` paints every plate and has none of
    its own, `/None` paints nothing. Neither is ever offered as a toggle.
    """
    if name == "All":
        return "all"
    if name == "None":
        return "none"
    if name in PROCESS_INKS:
        return "process"
    return "spot"


def refuse_unknown_colorants(page: int, detail: str) -> None:
    """State that a page's inks could not all be established, as a refusal.

    The one place the sentence exists. The inventory REPORTS it (a read may
    still return the inks it did reach) and the printer-mark colour bar
    RAISES it (a write over an unknown colorant would print a bar missing a
    patch, with nothing on the sheet to say so), so both consumers make one
    claim about one document.
    """
    raise ValueError(
        f"Page {page} uses a colour space this engine cannot read, so the "
        f"inks on it cannot all be established: {detail}"
    )


def unknown_colorant_message(page: int, detail: str) -> str:
    """The sentence the refusal carries, for the report that must not raise.

    Asking the refusal itself keeps one wording: an inventory that described
    an unreadable colorant branch differently from the refusal it predicts
    would be two claims about one document.
    """
    try:
        refuse_unknown_colorants(page, detail)
    except ValueError as exc:
        return str(exc)
    return ""


def _name_text(obj) -> str:
    text = str(obj)
    return text[1:] if text.startswith("/") else text


def _rgb255(rgb) -> list[int]:
    return [max(0, min(255, int(round(float(c) * 255.0)))) for c in rgb]


def _separation_display(cs, resources) -> list[int] | None:
    resolver = build_resolver(cs, resources)
    if resolver is None:
        return None
    try:
        rgb = resolver([1.0])
    except Exception:
        return None
    return _rgb255(rgb) if rgb is not None and len(rgb) == 3 else None


def _devicen_component_display(cs, resources, index: int, count: int) -> list[int] | None:
    """The display colour of ONE component of a DeviceN space.

    `/Attributes /Colorants` names each component's own Separation space when
    the document supplies one; without it the component is evaluated through
    the DeviceN tint transform alone, at full tint with every sibling at zero.
    """
    try:
        attrs = cs[4] if len(cs) >= 5 else None
        colorants = attrs.get("/Colorants") if attrs is not None else None
    except Exception:
        colorants = None
    if colorants is not None:
        try:
            name = _name_text(cs[1][index])
            own = colorants.get(pikepdf.Name("/" + name))
        except Exception:
            own = None
        if own is not None:
            rgb = _separation_display(own, resources)
            if rgb is not None:
                return rgb
    resolver = build_resolver(cs, resources)
    if resolver is None:
        return None
    comps = [0.0] * count
    comps[index] = 1.0
    try:
        rgb = resolver(comps)
    except Exception:
        return None
    return _rgb255(rgb) if rgb is not None and len(rgb) == 3 else None


def _alternate_label(cs) -> str:
    try:
        alt = cs[2]
    except Exception:
        return ""
    if isinstance(alt, pikepdf.Array) and len(alt) > 0:
        return _name_text(alt[0])
    return _name_text(alt)


def _page_numbers(pdf, pages) -> list[int]:
    total = len(pdf.pages)
    if pages is None:
        return list(range(1, total + 1))
    if isinstance(pages, int):
        pages = [pages]
    wanted = []
    for value in pages:
        number = int(value)
        if number < 1 or number > total:
            raise ValueError(f"Page {number} is not in this document.")
        if number not in wanted:
            wanted.append(number)
    return wanted


def list_inks(file: str, pages=None) -> dict:
    """The `/Separation` and `/DeviceN` colorants each page can paint with.

    Args:
        file: Input PDF path.
        pages: 1-based page numbers, or None for the whole document.

    Each entry carries the colorant name verbatim (an ink name is document
    content and is never translated), its kind, its alternate space, an sRGB
    display colour taken at full tint, the pages it appears on, and the
    resource categories it was reached through.

    `unknown` is the other half of the answer. A resource branch the walk
    could not read may hold a colorant, so an inventory that reported only
    what it reached would present a plate list it has not earned — the ink
    would be missing from the plate inventory and from every total-ink figure
    measured over it, with nothing saying so. The list is empty on a document
    the walk read whole, and a caller must not read a non-empty one as
    "nothing else there".
    """
    validate_pdf(file)
    found: dict[str, dict] = {}
    unknown: list[str] = []

    with pikepdf.open(file) as pdf:
        numbers = _page_numbers(pdf, pages)
        for number in numbers:
            page = pdf.pages[number - 1]
            resources = page.obj.get("/Resources")

            def on_unreadable(facts, reason: str, _n=number) -> None:
                # Only a branch that could have held a COLORANT clouds an ink
                # inventory: an unreadable font table hides no plate.
                if COLORSPACE not in facts:
                    return
                message = unknown_colorant_message(_n, reason)
                if message not in unknown:
                    unknown.append(message)

            def record(name: str, kind: str, alternate: str, rgb, category: str) -> None:
                entry = found.get(name)
                if entry is None:
                    entry = {
                        "name": name,
                        "kind": kind,
                        "alternate": alternate,
                        "display_rgb": rgb,
                        "pages": [],
                        "used_in": [],
                    }
                    found[name] = entry
                if entry["display_rgb"] is None and rgb is not None:
                    entry["display_rgb"] = rgb
                if number not in entry["pages"]:
                    entry["pages"].append(number)
                if category not in entry["used_in"]:
                    entry["used_in"].append(category)

            def on_colorspace(cs, category, _res=resources) -> None:
                if not isinstance(cs, pikepdf.Array) or len(cs) < 2:
                    return
                family = _name_text(cs[0])
                if family == "Separation" and len(cs) >= 4:
                    name = _name_text(cs[1])
                    record(name, ink_kind(name), _alternate_label(cs),
                           _separation_display(cs, _res), category)
                elif family == "DeviceN" and len(cs) >= 4:
                    try:
                        names = [_name_text(n) for n in cs[1]]
                    except Exception:
                        return
                    for index, name in enumerate(names):
                        record(name, ink_kind(name), _alternate_label(cs),
                               _devicen_component_display(cs, _res, index, len(names)),
                               category)

            walk_page_resources(page, on_colorspace=on_colorspace,
                                on_unreadable=on_unreadable)

    inks = sorted(
        found.values(),
        key=lambda e: (("process", "spot", "all", "none").index(e["kind"]),
                       PROCESS_INKS.index(e["name"]) if e["kind"] == "process" else 0,
                       e["name"]),
    )
    spots = [e for e in inks if e["kind"] == "spot"]
    return {
        "inks": inks,
        "spot_count": len(spots),
        "pages": numbers,
        "unknown": unknown,
    }


# ── the separation raster ──────────────────────────────────────────────────


def _cache_root() -> Path:
    root = Path(tempfile.gettempdir()) / "spectrapdf" / _PREVIEW_DIR_NAME
    root.mkdir(parents=True, exist_ok=True)
    return root


def _evict_old_sets(root: Path) -> None:
    """Keep the plate cache bounded. A plate set is whole or absent — eviction
    removes the directory, never a plate out of a live set."""
    try:
        sets = [d for d in root.iterdir() if d.is_dir()]
    except OSError:
        return
    if len(sets) <= _MAX_CACHED_SETS:
        return
    sets.sort(key=lambda d: d.stat().st_mtime)
    for stale in sets[: len(sets) - _MAX_CACHED_SETS]:
        shutil.rmtree(stale, ignore_errors=True)


def _set_key(file: str, page: int, dpi: int, overprint: bool) -> str:
    source = Path(file)
    try:
        stamp = f"{source.stat().st_mtime_ns}:{source.stat().st_size}"
    except OSError:
        stamp = "0:0"
    digest = hashlib.sha256(
        f"{source}\0{stamp}\0{page}\0{dpi}\0{int(overprint)}".encode("utf-8")
    ).hexdigest()
    return digest[:24]


def render_separations(
    file: str,
    page: int = 1,
    dpi: int = 150,
    gs_path: str = "gs",
    overprint: bool = True,
    reuse: bool = True,
) -> dict:
    """Rasterize one page to one grayscale plate per separation.

    Args:
        file: Input PDF path.
        page: 1-based page number.
        dpi: Raster resolution. The preview caps this at display resolution;
            the plate arithmetic is resolution-independent, so a higher number
            buys nothing but time.
        gs_path: Path to the Ghostscript executable.
        overprint: False renders with overprint simulation disabled.
        reuse: False re-runs the device even when the plate set is cached.

    The plate set is cached on disk keyed by file identity, page, resolution
    and overprint, so an ink toggle re-composites without another device run.
    """
    validate_pdf(file)
    page = int(page)
    dpi = max(1, int(dpi))

    inventory = list_inks(file, pages=[page])
    inks = inventory["inks"]
    spots = [e["name"] for e in inks if e["kind"] == "spot"]
    n = len(spots)
    limit = MAX_SPOTS_CEILING
    if n > limit:
        raise ValueError(
            f"This page uses {n} spot colours; separation preview supports {limit}."
        )

    root = _cache_root()
    out_dir = root / _set_key(file, page, dpi, overprint)
    marker = out_dir / "plates.done"
    if reuse and marker.is_file():
        os.utime(out_dir, None)
        return _describe_set(out_dir, inks, file, page, dpi, gs_path, overprint)

    shutil.rmtree(out_dir, ignore_errors=True)
    out_dir.mkdir(parents=True, exist_ok=True)

    max_spots = min(MAX_SPOTS_CEILING, max(_MIN_SPOT_REQUEST, len(spots)))
    cmd = [
        gs_path, "-dNOPAUSE", "-dBATCH", "-dSAFER", "-q",
        "-sDEVICE=tiffsep", f"-r{dpi}",
        f"-dFirstPage={page}", f"-dLastPage={page}",
        f"-dMaxSpots={max_spots}",
    ]
    if not overprint:
        cmd.append("-dOverprint=/disable")
    cmd += ["-o", str(out_dir / "s%d.tif"), str(file)]

    result = budget.gs(cmd, what="Separation render", path=file, pages=1)
    stdout = result.stdout or ""
    stderr = result.stderr or ""
    if _FOLD_MARKER in stdout or _FOLD_MARKER in stderr:
        shutil.rmtree(out_dir, ignore_errors=True)
        raise ValueError(
            f"Ghostscript folded {n} spot colours into process; "
            "raise the spot limit or reduce the document's spots."
        )
    if result.returncode != 0:
        shutil.rmtree(out_dir, ignore_errors=True)
        raise RuntimeError(f"Ghostscript separation render failed: {stderr or stdout}")

    described = _describe_set(out_dir, inks, file, page, dpi, gs_path, overprint)
    marker.write_text("", encoding="ascii")
    _evict_old_sets(root)
    return described


def _describe_set(out_dir: Path, inks: list[dict], file: str, page: int,
                  dpi: int, gs_path: str, overprint: bool) -> dict:
    """Pair the written plate files with the inventory, or refuse.

    The device names each plate by the ink it separates, so the pairing is a
    PREDICTION from the inventory: an ink the inventory does not know cannot
    be labelled, and a preview that mislabels a plate is worse than no
    preview. An expected plate that never appeared is the other case and is
    NOT a refusal — a colorant a page declares but never paints has no plate
    by construction, and the fold that would drop a painted one is caught by
    its own marker before this runs.
    """
    written = {p.name: p for p in out_dir.glob("s1(*).tif")}
    expected: dict[str, dict] = {}
    for entry in inks:
        if entry["kind"] in ("all", "none"):
            continue
        expected[f"s1({plate_name_escape(entry['name'])}).tif"] = entry
    for name in PROCESS_INKS:
        filename = f"s1({name}).tif"
        expected.setdefault(filename, {
            "name": name, "kind": "process", "alternate": "DeviceCMYK",
            "display_rgb": None, "pages": [page], "used_in": [],
        })

    unexpected = sorted(set(written) - set(expected))
    if unexpected:
        raise ValueError(
            "Separation output did not match the document's inks — "
            "the preview cannot be trusted."
        )

    plates = []
    for filename, entry in expected.items():
        path = written.get(filename)
        if path is None:
            continue
        plates.append({
            "name": entry["name"],
            "kind": entry["kind"],
            "display_rgb": entry["display_rgb"] or _default_display(entry["name"]),
            "file": str(path),
        })
    plates.sort(key=lambda p: (
        0 if p["kind"] == "process" else 1,
        PROCESS_INKS.index(p["name"]) if p["kind"] == "process" else 0,
        p["name"],
    ))
    if not plates:
        raise ValueError(
            "Separation output did not match the document's inks — "
            "the preview cannot be trusted."
        )

    width, height = _plate_extent(plates[0]["file"])
    return {
        "dir": str(out_dir),
        "plates": plates,
        "width": width,
        "height": height,
        "dpi": dpi,
        "page": page,
        "overprint": bool(overprint),
        "coverage": _cached_coverage(out_dir, file, page, gs_path),
    }


def _cached_coverage(out_dir: Path, file: str, page: int, gs_path: str) -> dict:
    """Page coverage is a property of the plate set, so it is measured once
    per set — a cache hit must not re-run the device."""
    store = out_dir / "coverage.json"
    if store.is_file():
        try:
            return json.loads(store.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            pass
    coverage = _ink_coverage(file, page, gs_path)
    try:
        store.write_text(json.dumps(coverage), encoding="utf-8")
    except OSError:
        pass
    return coverage


def _default_display(name: str) -> list[int]:
    """The display colour of a plate the inventory could not resolve.

    Only the process inks reach this: their plate always exists, whether or
    not the page declares a named colour space for them.
    """
    return {
        "Cyan": [0, 174, 239],
        "Magenta": [236, 0, 140],
        "Yellow": [255, 241, 0],
        "Black": [35, 31, 32],
    }.get(name, [128, 128, 128])


def _plate_extent(path: str) -> tuple[int, int]:
    from PIL import Image

    with Image.open(path) as im:
        return int(im.size[0]), int(im.size[1])


_INKCOV_LINE = re.compile(
    r"([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s+CMYK"
)


def _ink_coverage(file: str, page: int, gs_path: str) -> dict:
    """Per-ink page coverage, as fractions of the page area.

    This is the device's own page AVERAGE and it is reported as one. It
    cannot drive the over-limit alarm: on a page whose true maximum total ink
    is 340 %, these four sum to 200 %.
    """
    cmd = [
        gs_path, "-dNOPAUSE", "-dBATCH", "-dSAFER", "-q",
        "-sDEVICE=inkcov", "-r72",
        f"-dFirstPage={page}", f"-dLastPage={page}",
        "-o", "-", str(file),
    ]
    try:
        result = budget.gs(cmd, what="Ink coverage", path=file, pages=1)
    except RuntimeError:
        return {}
    match = _INKCOV_LINE.search(result.stdout or "")
    if match is None:
        return {}
    values = [float(v) for v in match.groups()]
    return dict(zip(PROCESS_INKS, values))


# ── ink arithmetic ─────────────────────────────────────────────────────────


def _load_ink_layers(plate_files) -> list:
    """Each plate as ink coverage in 0…1. Plate polarity is inverted, so ink
    is `255 - value`."""
    import numpy as np
    from PIL import Image

    layers = []
    for path in plate_files:
        with Image.open(path) as im:
            layers.append((255.0 - np.asarray(im.convert("L")).astype(np.float32)) / 255.0)
    return layers


def ink_statistics(plate_files, limit_pct: float = 300.0) -> dict:
    """Per-pixel total ink over a set of plates.

    Returns the maximum total and how much of the page exceeds `limit_pct`.
    The maximum is the alarm's input; the device's own `inkcov` average
    cannot serve, because it reports 200 % on a page whose true maximum is
    340 %.
    """
    import numpy as np

    layers = _load_ink_layers(plate_files)
    if not layers:
        return {"max_tac": 0.0, "over_pixels": 0, "total_pixels": 0, "over_fraction": 0.0}
    total = np.sum(np.stack(layers), axis=0) * 100.0
    return _statistics_of(total, limit_pct)


def _statistics_of(total, limit_pct: float) -> dict:
    over = total > float(limit_pct)
    over_pixels = int(over.sum())
    return {
        "max_tac": float(total.max()),
        "over_pixels": over_pixels,
        "total_pixels": int(total.size),
        "over_fraction": over_pixels / float(total.size),
    }


def _ink_spec(entry) -> tuple[str, list[int] | None, float]:
    """A requested ink as (name, display colour, density multiplier)."""
    if isinstance(entry, str):
        return entry, None, 1.0
    name = str(entry.get("name", ""))
    rgb = entry.get("display_rgb")
    if rgb is not None:
        try:
            rgb = [max(0, min(255, int(c))) for c in rgb][:3]
        except (TypeError, ValueError):
            rgb = None
        if rgb is not None and len(rgb) != 3:
            rgb = None
    try:
        density = float(entry.get("density", 1.0))
    except (TypeError, ValueError):
        density = 1.0
    return name, rgb, max(0.0, min(4.0, density))


def composite_separations(
    dir: str,
    inks: list | None = None,
    limit_pct: float = 300.0,
    alarm: bool = False,
    output: str = "",
) -> dict:
    """Composite the chosen plates into an RGB PNG, with the ink statistics.

    Args:
        dir: A plate-set directory `render_separations` produced.
        inks: The inks to show — names, or entries carrying `name`,
            `display_rgb` and `density`. None shows every plate in the set.
        limit_pct: Total-ink limit the alarm measures against.
        alarm: True tints the over-limit pixels in the composite.
        output: PNG path to write. Empty writes `composite.png` beside the
            plates.

    Each visible ink multiplies its display colour down, scaled by its
    density, so an ink switched off leaves the page exactly as if it had never
    printed. The statistics are measured over the SAME plate subset the image
    shows — a coverage figure counting a hidden ink would describe a different
    page.
    """
    import numpy as np
    from PIL import Image

    plate_dir = Path(dir)
    if not plate_dir.is_dir():
        raise ValueError("The separation plates for this page are no longer available.")

    available: dict[str, Path] = {}
    for path in plate_dir.glob("s1(*).tif"):
        available[path.name[len("s1("):-len(").tif")]] = path

    requested = inks if inks is not None else sorted(available)
    chosen: list[tuple[str, Path, list[int], float]] = []
    for entry in requested:
        name, rgb, density = _ink_spec(entry)
        path = available.get(plate_name_escape(name)) or available.get(name)
        if path is not None:
            chosen.append((name, path, rgb or _default_display(name), density))

    target = Path(output) if output else plate_dir / "composite.png"
    if not chosen:
        Image.fromarray(np.full((1, 1, 3), 255, dtype=np.uint8)).save(target, "PNG")
        return {"png": str(target), "width": 1, "height": 1, "inks": [],
                "max_tac": 0.0, "over_pixels": 0, "total_pixels": 0, "over_fraction": 0.0}

    layers = _load_ink_layers([p for _, p, _, _ in chosen])
    height, width = layers[0].shape
    rgb_out = np.ones((height, width, 3), dtype=np.float32)
    for layer, (_name, _path, color, density) in zip(layers, chosen):
        absorb = 1.0 - (np.asarray(color, dtype=np.float32) / 255.0)
        rgb_out *= np.clip(1.0 - layer[..., None] * density * absorb[None, None, :], 0.0, 1.0)

    total = np.sum(np.stack(layers), axis=0) * 100.0
    stats = _statistics_of(total, limit_pct)
    if alarm and stats["over_pixels"] > 0:
        over = total > float(limit_pct)
        rgb_out[over] = (rgb_out[over] * 0.25
                         + np.array([1.0, 0.0, 0.35], dtype=np.float32) * 0.75)

    Image.fromarray((rgb_out * 255.0).astype(np.uint8)).save(target, "PNG")
    return {
        "png": str(target),
        "width": int(width),
        "height": int(height),
        "inks": [name for name, _, _, _ in chosen],
        **stats,
    }
