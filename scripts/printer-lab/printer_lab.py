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
decoded, and 0 otherwise. `--dir` of `matrix` and `teardown` must be the `--dir`
of `setup`.

A driver for network printers only refuses a file port. `--kind` puts the printer
on a network port that points at a capture listener on 127.0.0.1:

    setup --kind tcp --name SpectraLabUpd --driver "Universal Print Class Driver"
        a Standard TCP/IP port; tcp_capture.py stores the bytes of each job
    setup --kind ipp --name SpectraLabIpp [--driver "<driver name>"]
        `Add-Printer -IppURL`: Windows adds the Microsoft IPP Class Driver on a
        WSD port; ipp_capture.py records the IPP job attributes and the document.
        `--driver` then switches the queue to another class driver (Universal
        Print, PWG Raster, PS) on the same port. This needs an elevated session,
        and so does `teardown` (the listener runs elevated).
    setup --kind tcp ... is for drivers that accept a Standard TCP/IP port; the
        Universal Print Class Driver does not (Add-Printer fails with 0x800703EB).

`setup` starts the listener (a detached Python process); `teardown` stops it. The
capture folder and the state file `<name>.lab.json` sit in `--dir`; `matrix` and
`teardown` read the kind from that state file.

`--repo` names the checkout under test (default: this one); the engine, the
bundled Ghostscript and the output all come from it. Every printer this tool
touches must be named SpectraLab*. `frame` needs a file port.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import socket
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
DEFAULT_DIR = Path(tempfile.gettempdir()) / "spectra-printer-lab"
STATE_SUFFIX = ".lab.json"
NETWORK_KINDS = ("ipp", "tcp")
IPP_SIDES = ("one-sided", "two-sided-long-edge", "two-sided-short-edge")
DEFAULT_PORTS = {"ipp": 6310, "tcp": 9101}
# The only ports a network teardown removes: the one setup made, and only when it has this shape.
_NETWORK_PORT = {"tcp": re.compile(r"IP_127\.0\.0\.1_\d{2,5}"), "ipp": re.compile(r"WSD-[0-9a-fA-F-]{36}")}
SETTLE_S = 3


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
_PATH_TEXT = re.compile(r"[\w :\\/.()~-]{1,200}")


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


def _enable_duplex_unit(name: str) -> None:
    try:
        _ps(
            f"Set-PrinterProperty -PrinterName {_quote(name)} "
            "-PropertyName Config:DuplexUnit -Value TRUE -ErrorAction Stop"
        )
    except RuntimeError as exc:
        print(f"note: the driver has no Config:DuplexUnit property ({exc})")


def setup(name: str, driver: str, directory: Path, duplex_unit: bool) -> None:
    require_lab_name(name)
    _require_plain("driver name", driver, _DRIVER_NAME)
    _require_plain("folder", str(directory), _PATH_TEXT)
    directory = directory.resolve()
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
        _enable_duplex_unit(name)
    print(f"{name}: {driver} -> {port}; duplex unit reported: {has_duplex_unit(name)}")


def teardown(name: str, directory: Path) -> None:
    """Remove the printer if it exists, then the one port `setup` made for it in `directory`."""
    require_lab_name(name)
    _require_plain("folder", str(directory), _PATH_TEXT)
    if read_state(directory, name):
        return teardown_network(name, directory)
    expected = directory.resolve() / f"{name}.prn"
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


# --- network ports: a capture listener on 127.0.0.1 ----------------------------


def state_path(directory: Path, name: str) -> Path:
    return directory.resolve() / f"{name}{STATE_SUFFIX}"


def read_state(directory: Path, name: str) -> dict | None:
    path = state_path(directory, name)
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None


def write_state(directory: Path, name: str, state: dict) -> None:
    state_path(directory, name).write_text(json.dumps(state, indent=2), encoding="utf-8")


def _is_admin() -> bool:
    import ctypes

    return bool(ctypes.windll.shell32.IsUserAnAdmin())


def _listening(port: int) -> bool:
    with socket.socket() as probe:
        probe.settimeout(0.5)
        return probe.connect_ex(("127.0.0.1", port)) == 0


def _printer_exists(name: str) -> bool:
    return _ps(f"@(Get-Printer -Name {_quote(name)} -ErrorAction SilentlyContinue).Count") == "1"


def _printer_port(name: str) -> str:
    return _ps(f"(Get-Printer -Name {_quote(name)} -ErrorAction Stop).PortName")


def _port_listed(port: str) -> bool:
    listing = _ps("Get-PrinterPort | Where-Object { $_.Name -eq " + _quote(port) + " } | ForEach-Object { $_.Name }")
    return port in listing.splitlines()


def start_listener(
    kind: str, name: str, port: int, capture_dir: Path, sides_default: str | None = None,
    formats: str | None = None,
) -> int:
    """Start the capture listener as a detached process; returns its pid once it accepts connections."""
    script = HERE / ("ipp_capture.py" if kind == "ipp" else "tcp_capture.py")
    command = [sys.executable, str(script), "--dir", str(capture_dir), "--port", str(port)]
    if kind == "ipp":
        command += ["--printer-name", name]
        if sides_default:
            command += ["--sides-default", sides_default]
        if formats:
            command += ["--document-formats", formats]
    flags = 0x08000000 | 0x00000200  # CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP
    log = (capture_dir / "listener.log").open("w")
    process = subprocess.Popen(
        command, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, creationflags=flags
    )
    log.close()
    deadline = time.time() + 15
    while time.time() < deadline:
        if _listening(port):
            return process.pid
        if process.poll() is not None:
            break
        time.sleep(0.3)
    subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True)
    raise SystemExit(f"The capture listener did not start on 127.0.0.1:{port} (see {capture_dir / 'listener.log'}).")


def stop_listener(state: dict) -> None:
    """Stop the listener `setup` started, only when the pid still runs that listener on that folder."""
    pid = state.get("pid")
    if not isinstance(pid, int):
        return
    line = _ps(f"(Get-CimInstance Win32_Process -Filter 'ProcessId={pid}' -ErrorAction SilentlyContinue).CommandLine")
    if line and "_capture.py" in line and str(state.get("capture_dir", "")) in line:
        subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True)


def setup_network(
    name: str, kind: str, driver: str | None, directory: Path, duplex_unit: bool, port: int,
    sides_default: str | None = None, formats: str | None = None,
) -> None:
    require_lab_name(name)
    if formats and (kind != "ipp" or not re.fullmatch(r"[a-z0-9.+/-]+(,[a-z0-9.+/-]+)*", formats)):
        raise SystemExit("Refused: --formats is for --kind ipp and is a comma separated list of MIME types.")
    if sides_default and (kind != "ipp" or sides_default not in IPP_SIDES):
        raise SystemExit(f"Refused: --sides-default is for --kind ipp and is one of {', '.join(IPP_SIDES)}.")
    _require_plain("folder", str(directory), _PATH_TEXT)
    directory = directory.resolve()
    if kind == "tcp" or driver:
        _require_plain("driver name", driver or "", _DRIVER_NAME)
    if not 1024 <= port <= 65535:
        raise SystemExit(f"Refused: the port {port} is outside 1024 to 65535.")
    if read_state(directory, name) or _printer_exists(name):
        raise SystemExit(f"Refused: '{name}' already exists (or has a state file in {directory}); run teardown first.")
    if kind == "ipp" and not _is_admin():
        raise SystemExit("Refused: setup --kind ipp needs an elevated session (Add-Printer -IppURL is denied otherwise).")
    if _listening(port):
        raise SystemExit(f"Refused: something already listens on 127.0.0.1:{port}; use --port.")
    port_name = f"IP_127.0.0.1_{port}" if kind == "tcp" else None
    if port_name and _port_listed(port_name):
        raise SystemExit(f"Refused: the port {port_name} already exists.")
    capture_dir = directory / f"{name}-capture"
    capture_dir.mkdir(parents=True, exist_ok=True)
    state = {"kind": kind, "name": name, "port": port, "capture_dir": str(capture_dir), "port_name": None, "pid": None}
    state["pid"] = start_listener(kind, name, port, capture_dir, sides_default, formats)
    write_state(directory, name, state)
    try:
        if kind == "tcp":
            _ps(
                f"Add-PrinterPort -Name {_quote(port_name)} -PrinterHostAddress 127.0.0.1 "
                f"-PortNumber {port} -ErrorAction Stop"
            )
            state["port_name"] = port_name
            write_state(directory, name, state)
            _ps(
                f"Add-Printer -Name {_quote(name)} -DriverName {_quote(driver)} "
                f"-PortName {_quote(port_name)} -ErrorAction Stop"
            )
            if duplex_unit:
                _enable_duplex_unit(name)
        else:
            _ps(
                f"Add-Printer -Name {_quote(name)} "
                f"-IppURL {_quote(f'http://127.0.0.1:{port}/ipp/print')} -ErrorAction Stop"
            )
            state["port_name"] = _printer_port(name)
            write_state(directory, name, state)
            if driver:  # the queue keeps its IPP (WSD) port; only the driver changes
                _ps(f"Set-Printer -Name {_quote(name)} -DriverName {_quote(driver)} -ErrorAction Stop")
                if duplex_unit:
                    _enable_duplex_unit(name)
    except RuntimeError as exc:
        # Add-Printer can create the queue and then throw: record the port the queue really has,
        # but only when it has the shape of a lab port, so the rollback can remove it.
        try:
            if state["port_name"] is None and _printer_exists(name):
                actual = _printer_port(name)
                if _NETWORK_PORT[kind].fullmatch(actual):
                    state["port_name"] = actual
                    write_state(directory, name, state)
        except (RuntimeError, OSError):
            pass
        undone = "was undone"
        try:
            teardown_network(name, directory)
        except SystemExit as undo:
            undone = f"could not be undone ({undo})"
        raise SystemExit(f"Setup of '{name}' ({kind}) failed and {undone}: {exc}") from exc
    print(f"{name}: {_ps(f'(Get-Printer -Name {_quote(name)}).DriverName')} -> {state['port_name']} "
          f"-> 127.0.0.1:{port} ({kind}); duplex unit reported: {has_duplex_unit(name)}")


def _remove_port(port: str) -> None:
    """Remove one port; a queue marked for deletion holds it until the spooler restarts."""
    for attempt in range(10):
        try:
            _ps(f"Remove-PrinterPort -Name {_quote(port)} -ErrorAction Stop")
            return
        except RuntimeError:
            if not _port_listed(port):
                return
            if attempt == 9:
                raise SystemExit(
                    f"The port '{port}' is still held by the spooler (a queue marked for deletion). "
                    "Restart the Print Spooler service, then run teardown again."
                ) from None
            time.sleep(2)


def teardown_network(name: str, directory: Path) -> None:
    """Remove the lab printer, the port setup recorded, the listener, the captures and the state file."""
    require_lab_name(name)
    state = read_state(directory, name)
    if not state or state.get("kind") not in NETWORK_KINDS or state.get("name") != name:
        raise SystemExit(f"Refused: no network lab state for '{name}' in {directory}.")
    kind, port_name = state["kind"], state.get("port_name")
    if port_name and not _NETWORK_PORT[kind].fullmatch(port_name):
        raise SystemExit(f"Refused: the recorded port '{port_name}' is not a lab port.")
    if _printer_exists(name):
        if port_name is None or _printer_port(name) != port_name:
            raise SystemExit(f"Refused: '{name}' is not on the port setup recorded ({port_name}).")
        _ps(f"Remove-Printer -Name {_quote(name)} -ErrorAction Stop")
    if port_name and _port_listed(port_name):
        _remove_port(port_name)
    stop_listener(state)
    capture_dir = Path(state["capture_dir"])
    if capture_dir.resolve().parent == directory.resolve() and capture_dir.name == f"{name}-capture":
        shutil.rmtree(capture_dir, ignore_errors=True)
    state_path(directory, name).unlink(missing_ok=True)
    print(f"{name}: removed with its port, listener and captures")


def _remove_with_retry(path: Path) -> None:
    deadline = time.time() + 30
    while True:
        try:
            path.unlink(missing_ok=True)
            return
        except OSError:
            if time.time() > deadline:
                raise
            time.sleep(0.5)


class FileTarget:
    """A printer on a file port: the job is the file the driver wrote."""

    def __init__(self, name: str) -> None:
        self.path = port_file(name)

    def clear(self) -> None:
        _clear(self.path)

    def read(self) -> lab_decode.Decoded:
        return lab_decode.decode(_wait_job(self.path))


class CaptureTarget:
    """A printer on a network port: the jobs are the files the capture listener wrote."""

    def __init__(self, name: str, state: dict, timeout: float | None = None) -> None:
        self.kind = state["kind"]
        self.dir = Path(state["capture_dir"])
        self.timeout = timeout or JOB_TIMEOUT_S
        if _printer_port(name) != state.get("port_name"):
            raise SystemExit(f"Refused: '{name}' is not on the port setup recorded ({state.get('port_name')}).")
        if not _listening(state["port"]):
            raise SystemExit(f"The capture listener on 127.0.0.1:{state['port']} is not running; run setup again.")

    @property
    def pattern(self) -> str:
        return "job-*.json" if self.kind == "ipp" else "job-*.bin"

    def clear(self) -> None:
        for path in self.dir.glob("job-*"):
            _remove_with_retry(path)

    def read(self) -> lab_decode.Decoded:
        deadline = time.time() + self.timeout
        while not list(self.dir.glob(self.pattern)):
            if time.time() > deadline:
                raise TimeoutError(f"no job reached the {self.kind} capture listener in {self.timeout:.0f} s")
            time.sleep(0.5)
        time.sleep(SETTLE_S)  # a second job of the same print would arrive now
        decoded = [self._decode(path) for path in sorted(self.dir.glob(self.pattern))]
        merged = decoded[0]
        for other in decoded[1:]:
            merged.sources.extend(other.sources)
            merged.complete = merged.complete and other.complete
        if len(decoded) > 1:
            merged.notes.append(f"{len(decoded)} jobs arrived")
        return merged

    def _decode(self, path: Path) -> lab_decode.Decoded:
        if self.kind == "tcp":
            decoded = lab_decode.decode(path.read_bytes())
            cut = path.with_suffix(".cut")
            if cut.exists():
                decoded.complete = False
                decoded.notes.append("cut: " + cut.read_text(encoding="utf-8", errors="replace").strip())
            return decoded
        record = json.loads(path.read_text(encoding="utf-8"))
        document = path.with_name(record["document_file"]).read_bytes() if record.get("document_file") else None
        return lab_decode.decode_ipp(record, document)


def resolve_target(name: str, directory: Path, timeout: float | None = None):
    """The capture target for a printer made by `setup --kind`, else the file target."""
    require_lab_name(name)
    state = read_state(directory, name)
    return CaptureTarget(name, state, timeout) if state else FileTarget(name)


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

    def __init__(self, repo: Path, gs: Path | None, job_timeout: float | None = None) -> None:
        self.repo = repo
        self.gs = gs or repo / "resources" / "ghostscript" / "gswin64c.exe"
        if not self.gs.exists():
            raise SystemExit(f"Ghostscript not found: {self.gs} (use --repo of a checkout that has it)")
        sys.path.insert(0, str(repo / "src"))
        from engine import printer  # noqa: PLC0415

        self.printer = printer
        if job_timeout:
            # A driver that cannot open its printer can hang Ghostscript; the engine waits 600 s by default.
            printer.JOB_TIMEOUT_S = job_timeout

    def print_job(self, source: Path, name: str, **kwargs) -> None:
        try:
            self.printer.print_pdf(str(source), name, gs_path=str(self.gs), **kwargs)
        except RuntimeError as exc:
            if "timed out" in str(exc):
                raise TimeoutError(str(exc)) from exc
            raise

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


def run_matrix(engine: Engine, name: str, work: Path, target=None, all_modes: bool = False) -> list[dict]:
    target = target or FileTarget(name)
    unit = has_duplex_unit(name)
    source = work / "source.pdf"
    make_source(source)
    default = engine.default_duplex(name) if unit else lab_decode.SIMPLEX
    rows: list[dict] = []
    for layout, kwargs in LAYOUTS.items():
        for mode in DUPLEX_MODES:
            if not unit and mode != "printer" and not all_modes:
                continue
            expected = default if mode == "printer" else mode
            target.clear()
            row = {"layout": layout, "duplex": mode, "expected": expected if unit else "n/a"}
            try:
                engine.print_job(source, name, duplex=mode, **kwargs)
                decoded = target.read()
            except Exception as exc:  # noqa: BLE001
                row.update(found="", status="ERROR", language="", note=str(exc)[:160])
                rows.append(row)
                if isinstance(exc, TimeoutError) and all(r["status"] == "ERROR" for r in rows):
                    hint = (
                        "The driver may not print to this port: see the PrintService/Admin log, event 372."
                        if isinstance(target, FileTarget)
                        else "See requests.jsonl or the queue (Get-PrintJob) for what the driver did."
                    )
                    row["note"] += f"; no job was written, so the remaining cells were not run. {hint}"
                    return rows
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
    p = sub.add_parser("setup", help="add a lab printer on a file port, a TCP/IP port or an IPP printer")
    p.add_argument("--name", required=True)
    p.add_argument("--driver", help="required for a file or tcp printer; with --kind ipp it replaces the "
                                    "Microsoft IPP Class Driver after the printer is added")
    p.add_argument("--kind", choices=("file", *NETWORK_KINDS), default="file")
    p.add_argument("--port", type=int, help="the listener port for --kind ipp or tcp (default 6310 ipp, 9101 tcp)")
    p.add_argument("--sides-default", choices=IPP_SIDES,
                   help="--kind ipp: the `sides-default` the printer reports (default one-sided)")
    p.add_argument("--formats", help="--kind ipp: the document-format-supported list, comma separated "
                                     "(default application/pdf,image/pwg-raster,image/urf)")
    p.add_argument("--dir", type=Path, default=DEFAULT_DIR)
    p.add_argument("--no-duplex-unit", action="store_true")
    p = sub.add_parser("teardown", help="remove a lab printer, its port, its listener and its captures")
    p.add_argument("--name", required=True)
    p.add_argument("--dir", type=Path, default=DEFAULT_DIR)
    for command in ("matrix", "frame"):
        p = sub.add_parser(command)
        p.add_argument("--name", required=True)
        if command == "matrix":
            p.add_argument("--dir", type=Path, default=DEFAULT_DIR)
            p.add_argument("--all-modes", action="store_true",
                           help="print every duplex mode even when the driver reports no duplex unit "
                                "(shows what the job carries; the status stays NO DUPLEX UNIT)")
            p.add_argument("--timeout", type=float,
                           help="seconds to wait for each print and each network job (default: the engine's 600 s "
                                "for a print, 240 s for a job)")
        p.add_argument("--repo", type=Path, default=HERE.parent.parent)
        p.add_argument("--gs", type=Path)
        p.add_argument("--json", type=Path, help="write the result as JSON")
        if command == "frame":
            p.add_argument("--update-baseline", action="store_true")
    args = parser.parse_args(argv)

    if args.command == "setup":
        if args.kind == "file":
            if not args.driver:
                parser.error("--driver is required for --kind file")
            setup(args.name, args.driver, args.dir, not args.no_duplex_unit)
        else:
            setup_network(args.name, args.kind, args.driver, args.dir, not args.no_duplex_unit,
                          args.port or DEFAULT_PORTS[args.kind], args.sides_default, args.formats)
        return 0
    if args.command == "teardown":
        teardown(args.name, args.dir)
        return 0

    engine = Engine(args.repo.resolve(), args.gs, getattr(args, "timeout", None))
    work = Path(tempfile.mkdtemp(prefix="spectra-lab-"))
    try:
        if args.command == "matrix":
            rows = run_matrix(engine, args.name, work, resolve_target(args.name, args.dir, args.timeout), args.all_modes)
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
