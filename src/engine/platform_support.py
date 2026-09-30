"""Host-platform facts the engine needs to name and find its bundled tools.

A bundled program's file name differs by platform (`tesseract.exe` on
Windows, `tesseract` elsewhere), and so does the provisioning script that
vendors it. Every lookup and every refusal that names one goes through this
module, so no caller spells a `.exe` suffix or a `.ps1` script by hand.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

IS_WINDOWS = os.name == "nt"

#: The directory under the dev tree's `resources/` that holds the native
#: Linux trees. A checkout shared with a Windows host keeps both platforms'
#: trees side by side; the shipped layout has no such level.
DEV_PLATFORM_DIR = "" if IS_WINDOWS else f"{sys.platform.rstrip('0123456789')}-x86_64"


def program_name(stem: str) -> str:
    """`stem` spelled as this platform's executable file name."""
    return f"{stem}.exe" if IS_WINDOWS else stem


def bundle_script(stem: str) -> str:
    """The repository script that provisions a vendored tool on this platform."""
    return f"scripts/{stem}.ps1" if IS_WINDOWS else f"scripts/{stem}.sh"


def shared_library_name(windows_name: str, posix_name: str) -> str:
    """The file name of a vendored shared library on this platform."""
    return windows_name if IS_WINDOWS else posix_name


def vendored_candidates(engine_dir: Path, component: str, *relative: str) -> tuple[Path, ...]:
    """Where a vendored tree's file sits relative to the engine package.

    Shipped: `<resources>/engine/` beside `<resources>/<component>/`. Dev tree:
    `src/engine/` with `<repo>/resources/<component>/`, or on a non-Windows
    host `<repo>/resources/<platform>/<component>/` for a native tree.
    """
    shipped = engine_dir.parent / component
    dev = engine_dir.parent.parent / "resources"
    if DEV_PLATFORM_DIR:
        dev = dev / DEV_PLATFORM_DIR
    return (shipped.joinpath(*relative), (dev / component).joinpath(*relative))
