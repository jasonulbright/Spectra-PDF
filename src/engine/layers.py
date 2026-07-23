"""Optional content groups — the Layers panel (§ I.6).

Layered PDFs (CAD exports, maps, multi-language artwork) carry Optional Content
Groups in the catalog's /OCProperties. Each OCG is a named layer; the default
configuration (/D) lists which are ON and which are OFF. This module lists the
layers and flips a layer's default visibility by moving its reference between
the /D /ON and /D /OFF arrays — a viewer (pdf.js included) renders per that
default, so hiding a layer here hides it in the page.

Layers are addressed by their INDEX into /OCGs (stable within a document, and
names aren't guaranteed unique). Membership tests are by object identity
(objgen), never by name.
"""

import shutil
import tempfile
from pathlib import Path

import pikepdf
from pikepdf import Array, Name


def _ocgs(pdf) -> list:
    ocp = pdf.Root.get("/OCProperties")
    if ocp is None:
        return []
    ocgs = ocp.get("/OCGs")
    if ocgs is None:
        return []
    return list(ocgs)


def _default_config(pdf):
    ocp = pdf.Root.get("/OCProperties")
    return ocp.get("/D") if ocp is not None else None


def _in_array(arr, target) -> bool:
    if arr is None:
        return False
    try:
        tog = target.objgen
    except Exception:
        return False
    for el in arr:
        try:
            if el.objgen == tog:
                return True
        except Exception:
            continue
    return False


def list_layers(file: str) -> dict:
    """Every optional-content group: index, name, and default visibility."""
    with pikepdf.open(file) as pdf:
        ocgs = _ocgs(pdf)
        d = _default_config(pdf)
        off = d.get("/OFF") if d is not None else None
        layers = []
        for i, ocg in enumerate(ocgs):
            try:
                name = str(ocg.get("/Name")) if ocg.get("/Name") is not None else f"Layer {i + 1}"
            except Exception:
                name = f"Layer {i + 1}"
            # A layer is visible unless it is explicitly in the /OFF array.
            layers.append({"index": i, "name": name, "visible": not _in_array(off, ocg)})
        return {"layers": layers, "count": len(layers)}


def set_layer_visibility(file: str, output: str, index: int, visible: bool) -> dict:
    """Show or hide one layer by moving its OCG between /D /ON and /D /OFF."""
    input_path = Path(file)
    output_path = Path(output)
    same_file = input_path.resolve() == output_path.resolve()

    with pikepdf.open(file) as pdf:
        ocgs = _ocgs(pdf)
        if not (0 <= int(index) < len(ocgs)):
            raise ValueError(f"layer index {index} is out of range (0-{len(ocgs) - 1})")
        ocp = pdf.Root.get("/OCProperties")
        d = ocp.get("/D")
        if d is None:
            d = pikepdf.Dictionary()
            ocp["/D"] = d
        target = ocgs[int(index)]
        target_og = target.objgen

        def rebuilt(key: str, keep_target: bool):
            existing = d.get(key)
            out = []
            if existing is not None:
                for el in existing:
                    try:
                        if el.objgen == target_og:
                            continue  # drop the target; re-added below if wanted
                    except Exception:
                        pass
                    out.append(el)
            if keep_target:
                out.append(target)
            return Array(out)

        # Visible → ensure it is NOT in /OFF (and present in /ON); hidden → the
        # reverse. Rebuilding both arrays keeps the target in exactly one.
        d[Name.ON] = rebuilt("/ON", keep_target=visible)
        d[Name.OFF] = rebuilt("/OFF", keep_target=not visible)

        if same_file:
            with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False, dir=str(input_path.parent)) as tmp:
                tmp_path = tmp.name
            pdf.save(tmp_path)
        else:
            pdf.save(output_path)

    if same_file:
        shutil.move(tmp_path, str(output_path))

    return {"output": str(output_path), "index": int(index), "visible": bool(visible)}
