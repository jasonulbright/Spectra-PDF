"""Print the engine's duplex and page-frame matrix through a file-port printer.

A printer on a file port writes the job its driver would send to a real
printer. The job bytes show what the driver was told; they do not show what a
printer does with it. Run this with the project's Python (it needs pikepdf and
Pillow) on Windows:

    python scripts/printer-lab/printer_lab.py setup  --name SpectraLabMfc --driver "<driver name>"
    python scripts/printer-lab/printer_lab.py matrix --name SpectraLabMfc
    python scripts/printer-lab/printer_lab.py frame  --name SpectraLabPdf
    python scripts/printer-lab/printer_lab.py teardown --name SpectraLabMfc

`matrix` exits 1 when a row failed, 2 when no row failed but a job was not fully
decoded, and 0 otherwise. `--dir` of `teardown` must be the `--dir` of `setup`.

`--repo` names the checkout under test (default: this one); the engine, the
bundled Ghostscript and the output all come from it. Every printer this tool
touches must be named SpectraLab* and sit on a file port.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import lab_decode  # noqa: E402

LAB_PREFIX = "SpectraLab"
SHEET = {"sheet_width": 595.0, "sheet_height": 842.0, "paper": 9}
LAYOUTS = {
    "single": {},
    "2x1 portrait": dict(layout="nup", nup_rows=2, nup_cols=1, orientation="portrait", **SHEET),
    "1x2 landscape": dict(layout="nup", nup_rows=1, nup_cols=2, orientation="landscape", **SHEET),
}
DUPLEX_MODES = ("printer", "simplex", "long", "short")
FRAME_CASES = {
    "single_landscape": dict(orientation="landscape"),
    "nup_1x2_landscape": LAYOUTS["1x2 landscape"],
    "nup_2x1_portrait": LAYOUTS["2x1 portrait"],
    "nup_1x2_landscape_short": dict(LAYOUTS["1x2 landscape"], duplex="short"),
}
FRAME_DPI = 200
FRAME_TOLERANCE_PX = 3
BASELINE = HERE / "baseline-frame.json"
JOB_TIMEOUT_S = 240


def require_lab_name(name: str) -> str:
    """Refuse any printer that is not a lab printer."""
    if not re.fullmatch(rf"{LAB_PREFIX}[A-Za-z0-9_-]*", name):
        raise SystemExit(
            f"Refused: '{name}' is not a lab printer "
            f"(the name is {LAB_PREFIX} followed by letters, digits, - or _)."
        )
    return name


def _powershell() -> str:
    msi = Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "PowerShell" / "7" / "pwsh.exe"
    return str(msi) if msi.exists() else "powershell.exe"


def _ps(command: str) -> str:
    result = subprocess.run(
        [_powershell(), "-NoProfile", "-NonInteractive", "-Command", command],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or "PowerShell failed")
    return result.stdout.strip()


_SINGLE_QUOTES = "'\u2018\u2019\u201a\u201b"
_DRIVER_NAME = re.compile(r"[\w .()/+-]{1,120}")
_PATH_TEXT = re.compile(r"[\w :\\/.()-]{1,200}")


def _quote(text: str) -> str:
    """A PowerShell single-quoted string; every quote character PowerShell accepts is doubled."""
    return "'" + "".join(c + c if c in _SINGLE_QUOTES else c for c in text) + "'"


def _require_plain(kind: str, value: str, pattern: re.Pattern) -> str:
    if not pattern.fullmatch(value):
        raise SystemExit(f"Refused: the {kind} '{value}' holds a character the lab does not accept.")
    return value


def port_file(name: str) -> Path:
    """The file the lab printer writes. Refuses a printer on any other port."""
    require_lab_name(name)
    port = _ps(f"(Get-Printer -Name {_quote(name)} -ErrorAction Stop).PortName")
    path = Path(port)
    if not path.is_absolute() or not path.suffix:
        raise SystemExit(f"Refused: '{name}' is on port '{port}', not on a file port.")
    return path


def has_duplex_unit(name: str) -> bool:
    """True when the driver reports a duplex unit (DeviceCapabilitiesW DC_DUPLEX)."""
    import ctypes
    from ctypes import wintypes

    winspool = ctypes.WinDLL("winspool.drv")
    winspool.DeviceCapabilitiesW.argtypes = [
        wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.WORD, ctypes.c_void_p, ctypes.c_void_p,
    ]
    winspool.DeviceCapabilitiesW.restype = ctypes.c_int
    return winspool.DeviceCapabilitiesW(name, None, 7, None, None) > 0


def setup(name: str, driver: str, directory: Path, duplex_unit: bool) -> None:
    require_lab_name(name)
    _require_plain("driver name", driver, _DRIVER_NAME)
    _require_plain("folder", str(directory), _PATH_TEXT)
    directory.mkdir(parents=True, exist_ok=True)
    port = str(directory / f"{name}.prn")
    _ps(f"Add-PrinterPort -Name {_quote(port)} -ErrorAction Stop")
    try:
        _ps(
            f"Add-Printer -Name {_quote(name)} -DriverName {_quote(driver)} "
            f"-PortName {_quote(port)} -ErrorAction Stop"
        )
    except RuntimeError as exc:
        _ps(f"Remove-PrinterPort -Name {_quote(port)} -ErrorAction SilentlyContinue")
        raise SystemExit(f"The driver '{driver}' refused a file port: {exc}") from exc
    if duplex_unit:
        try:
            _ps(
                f"Set-PrinterProperty -PrinterName {_quote(name)} "
                "-PropertyName Config:DuplexUnit -Value TRUE -ErrorAction Stop"
            )
        except RuntimeError as exc:
            print(f"note: the driver has no Config:DuplexUnit property ({exc})")
    print(f"{name}: {driver} -> {port}; duplex unit reported: {has_duplex_unit(name)}")


def teardown(name: str, directory: Path) -> None:
    """Remove the printer if it exists, then the one port `setup` made for it in `directory`."""
    require_lab_name(name)
    _require_plain("folder", str(directory), _PATH_TEXT)
    expected = directory / f"{name}.prn"
    if _ps(f"@(Get-Printer -Name {_quote(name)} -ErrorAction SilentlyContinue).Count") == "1":
        if port_file(name) != expected:
            raise SystemExit(f"Refused: '{name}' is not on the port {expected}.")
        _ps(f"Remove-Printer -Name {_quote(name)} -ErrorAction Stop")
    ports = _ps(
        "Get-PrinterPort | Where-Object { $_.Name -eq " + _quote(str(expected)) + " }"
        " | ForEach-Object { $_.Name }"
    )
    for port in filter(None, (line.strip() for line in ports.splitlines())):
        for attempt in range(10):
            try:
                _ps(f"Remove-PrinterPort -Name {_quote(port)} -ErrorAction Stop")
                break
            except RuntimeError:
                if attempt == 9:
                    raise SystemExit(
                        f"The port '{port}' is still held by the spooler (a queue marked for deletion). "
                        "Restart the Print Spooler service, then run teardown again."
                    ) from None
                time.sleep(2)
        Path(port).unlink(missing_ok=True)
    print(f"{name}: removed with its port and job file")


def make_source(path: Path, pages: int = 4) -> None:
    """A four-page A4 document whose pages carry a frame, so a lost margin shows."""
    import pikepdf

    pdf = pikepdf.Pdf.new()
    font = pdf.make_indirect(pikepdf.Dictionary(
        Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1, BaseFont=pikepdf.Name.Helvetica))
    for number in range(1, pages + 1):
        content = f"BT /F1 120 Tf 200 380 Td (P{number}) Tj ET 20 20 555 802 re S".encode()
        page = pikepdf.Dictionary(
            Type=pikepdf.Name.Page, MediaBox=[0, 0, 595, 842],
            Resources=pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=font)),
            Contents=pdf.make_stream(content))
        pdf.pages.append(pikepdf.Page(page))
    pdf.save(path)


def _clear(path: Path) -> None:
    deadline = time.time() + 30
    while path.exists():
        try:
            path.unlink()
        except OSError:
            if time.time() > deadline:
                raise
            time.sleep(0.5)


def _wait_job(path: Path) -> bytes:
    """The job bytes once the file has stopped growing."""
    deadline = time.time() + JOB_TIMEOUT_S
    last, steady = -1, 0
    while time.time() < deadline:
        size = path.stat().st_size if path.exists() else 0
        if size > 0 and size == last:
            steady += 1
            if steady >= 3:
                return path.read_bytes()
        else:
            steady = 0
        last = size
        time.sleep(1)
    raise TimeoutError(f"no finished job in {path} after {JOB_TIMEOUT_S} s")


class Engine:
    """The engine of the checkout under test."""

    def __init__(self, repo: Path, gs: Path | None) -> None:
        self.repo = repo
        self.gs = gs or repo / "resources" / "ghostscript" / "gswin64c.exe"
        if not self.gs.exists():
            raise SystemExit(f"Ghostscript not found: {self.gs} (use --repo of a checkout that has it)")
        sys.path.insert(0, str(repo / "src"))
        from engine import printer  # noqa: PLC0415

        self.printer = printer

    def print_job(self, source: Path, name: str, **kwargs) -> None:
        self.printer.print_pdf(str(source), name, gs_path=str(self.gs), **kwargs)

    def default_duplex(self, name: str) -> str:
        return self.printer.printer_default_duplex(name) or lab_decode.SIMPLEX


def row_status(decoded: lab_decode.Decoded, expected: str, unit: bool) -> str:
    """PASS only when the whole job was read and it names the expected edge."""
    if not unit:
        return "NO DUPLEX UNIT"
    if not decoded.decodable:
        return "UNDECODABLE"
    if decoded.edges() != {expected}:
        return "FAIL"
    return "PASS" if decoded.complete else "INCOMPLETE"


def exit_code(rows: list[dict]) -> int:
    """1 when a row failed, 2 when no row failed but one was not fully read, else 0."""
    statuses = {r["status"] for r in rows}
    if statuses & {"FAIL", "ERROR"}:
        return 1
    return 2 if statuses & {"UNDECODABLE", "INCOMPLETE"} else 0


def run_matrix(engine: Engine, name: str, work: Path) -> list[dict]:
    path = port_file(name)
    unit = has_duplex_unit(name)
    source = work / "source.pdf"
    make_source(source)
    default = engine.default_duplex(name) if unit else lab_decode.SIMPLEX
    rows: list[dict] = []
    for layout, kwargs in LAYOUTS.items():
        for mode in DUPLEX_MODES:
            if not unit and mode != "printer":
                continue
            expected = default if mode == "printer" else mode
            _clear(path)
            row = {"layout": layout, "duplex": mode, "expected": expected if unit else "n/a"}
            try:
                engine.print_job(source, name, duplex=mode, **kwargs)
                decoded = lab_decode.decode(_wait_job(path))
            except Exception as exc:  # noqa: BLE001
                row.update(found="", status="ERROR", language="", note=str(exc)[:160])
                rows.append(row)
                continue
            row.update(found=decoded.summary(), language=decoded.language, note="; ".join(decoded.notes))
            row["status"] = row_status(decoded, expected, unit)
            rows.append(row)
    return rows


def _content_box(png: Path):
    from PIL import Image, ImageChops

    image = Image.open(png).convert("L")
    return list(ImageChops.invert(image).getbbox() or (0, 0, 0, 0))


def measure_frame(engine: Engine, name: str, work: Path) -> dict:
    import pikepdf

    path = port_file(name)
    source = work / "source.pdf"
    make_source(source)
    measured: dict = {}
    for case, kwargs in FRAME_CASES.items():
        _clear(path)
        engine.print_job(source, name, **kwargs)
        data = _wait_job(path)
        if not data.startswith(b"%PDF"):
            raise SystemExit(f"'{name}' did not write a PDF; use the Microsoft Print To PDF driver.")
        pdf_path = work / f"{case}.pdf"
        pdf_path.write_bytes(data)
        pattern = work / f"{case}_%d.png"
        subprocess.run(
            [str(engine.gs), "-q", "-dNOPAUSE", "-dBATCH", "-dSAFER", "-sDEVICE=png16m",
             f"-r{FRAME_DPI}", f"-sOutputFile={pattern}", str(pdf_path)],
            check=True, capture_output=True,
        )
        with pikepdf.open(pdf_path) as pdf:
            boxes = [[round(float(v), 1) for v in page.MediaBox[2:]] for page in pdf.pages]
        measured[case] = [
            {"page_pt": boxes[i], "content_px": _content_box(work / f"{case}_{i + 1}.png")}
            for i in range(len(boxes))
        ]
    return measured


def compare_frame(measured: dict, baseline: dict) -> list[str]:
    problems: list[str] = []
    for case, pages in measured.items():
        base = baseline.get(case)
        if base is None:
            problems.append(f"{case}: not in the baseline")
            continue
        if len(pages) != len(base):
            problems.append(f"{case}: {len(pages)} pages, baseline has {len(base)}")
            continue
        for index, (now, then) in enumerate(zip(pages, base), start=1):
            if any(abs(a - b) > 0.6 for a, b in zip(now["page_pt"], then["page_pt"])):
                problems.append(f"{case} page {index}: page size {now['page_pt']} vs {then['page_pt']}")
            shift = max(abs(a - b) for a, b in zip(now["content_px"], then["content_px"]))
            if shift > FRAME_TOLERANCE_PX:
                problems.append(
                    f"{case} page {index}: content box {now['content_px']} vs {then['content_px']} "
                    f"(off by {shift} px at {FRAME_DPI} dpi)"
                )
    return problems


def format_baseline(measured: dict) -> str:
    """One line per page, so a baseline change reads as a small diff."""
    cases = []
    for case, pages in measured.items():
        lines = ",\n".join(f"    {json.dumps(page)}" for page in pages)
        cases.append(f'  {json.dumps(case)}: [\n{lines}\n  ]')
    return "{\n" + ",\n".join(cases) + "\n}\n"


def format_table(rows: list[dict]) -> str:
    header = "| Layout | Duplex | Expected | Found | Status | Language | Note |"
    lines = [header, "|---|---|---|---|---|---|---|"]
    for r in rows:
        lines.append(
            f"| {r['layout']} | {r['duplex']} | {r['expected']} | {r['found']} | {r['status']} "
            f"| {r['language']} | {r['note']} |"
        )
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("setup", help="add a lab printer on a file port")
    p.add_argument("--name", required=True)
    p.add_argument("--driver", required=True)
    p.add_argument("--dir", type=Path, default=Path(tempfile.gettempdir()) / "spectra-printer-lab")
    p.add_argument("--no-duplex-unit", action="store_true")
    p = sub.add_parser("teardown", help="remove a lab printer, its port and its job file")
    p.add_argument("--name", required=True)
    p.add_argument("--dir", type=Path, default=Path(tempfile.gettempdir()) / "spectra-printer-lab")
    for command in ("matrix", "frame"):
        p = sub.add_parser(command)
        p.add_argument("--name", required=True)
        p.add_argument("--repo", type=Path, default=HERE.parent.parent)
        p.add_argument("--gs", type=Path)
        p.add_argument("--json", type=Path, help="write the result as JSON")
        if command == "frame":
            p.add_argument("--update-baseline", action="store_true")
    args = parser.parse_args(argv)

    if args.command == "setup":
        setup(args.name, args.driver, args.dir, not args.no_duplex_unit)
        return 0
    if args.command == "teardown":
        teardown(args.name, args.dir)
        return 0

    engine = Engine(args.repo.resolve(), args.gs)
    work = Path(tempfile.mkdtemp(prefix="spectra-lab-"))
    try:
        if args.command == "matrix":
            rows = run_matrix(engine, args.name, work)
            print(format_table(rows))
            if args.json:
                args.json.write_text(json.dumps(rows, indent=2), encoding="utf-8")
            return exit_code(rows)
        measured = measure_frame(engine, args.name, work)
        if args.update_baseline:
            BASELINE.write_text(format_baseline(measured), encoding="utf-8", newline="\n")
            print(f"baseline written: {BASELINE}")
            return 0
        problems = compare_frame(measured, json.loads(BASELINE.read_text(encoding="utf-8")))
        print("\n".join(problems) if problems else "frame: all cases match the baseline")
        if args.json:
            args.json.write_text(json.dumps(measured, indent=2), encoding="utf-8")
        return 1 if problems else 0
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
