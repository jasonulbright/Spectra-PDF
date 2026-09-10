"""Optional content groups — the Layers panel.

Layered PDFs (CAD exports, maps, multi-language artwork) carry Optional Content
Groups in the catalog's /OCProperties. Each OCG is a named layer; the default
configuration (/D) lists which are ON and which are OFF. This module lists the
layers and flips a layer's default visibility by moving its reference between
the /D /ON and /D /OFF arrays — a viewer (pdf.js included) renders per that
default, so hiding a layer here hides it in the page.

Layers are addressed by their INDEX into /OCGs (valid only in one revision, and
names aren't guaranteed unique). Membership tests are by object identity
(objgen), never by name.

A layer may also carry a PROCESSING STEP: a declaration that its content is a
manufacturing instruction (a die line, a crease, a varnish area) rather than
artwork a press prints. `engine/processing_steps.py` reads it, and states the
standard it is read against and why that reading is second-hand.
"""

from pathlib import Path

import pikepdf
from pikepdf import Array, Name
from engine.inplace import is_same_file, staged_write
from engine.processing_steps import read_processing_step
from engine.pdf_save import save_pdf


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


def _editable_config(pdf):
    """Complete address/default-state read: ISO 32000-2 8.11.4, Tables 98/99.

    The default configuration has BaseState ON; other configurations and
    usage-driven viewer overrides are not the default-state editor's input.
    """
    def refuse():
        raise ValueError("Layer configuration cannot be read completely.")
    if "/OCProperties" not in pdf.Root:
        return [], None, set(), set(), []
    ocp = pdf.Root.OCProperties
    if not isinstance(ocp, pikepdf.Dictionary):
        refuse()
    groups, config = ocp.get('/OCGs'), ocp.get('/D')
    if not isinstance(groups, Array) or len(groups) > 10000 or not isinstance(config, pikepdf.Dictionary):
        refuse()
    ids = set()
    for group in groups:
        if (not isinstance(group, pikepdf.Dictionary) or group.objgen == (0, 0)
                or group.objgen in ids or group.get('/Type') != Name.OCG
                or not isinstance(group.get('/Name'), pikepdf.String)):
            refuse()
        ids.add(group.objgen)
    if config.get('/BaseState', Name.ON) != Name.ON:
        refuse()
    remaining_refs = 30000
    def refs(value):
        nonlocal remaining_refs
        if not isinstance(value, Array) or len(value) > 10000:
            refuse()
        remaining_refs -= len(value)
        if remaining_refs < 0:
            refuse()
        result = set()
        for group in value:
            if (not isinstance(group, pikepdf.Dictionary) or group.objgen not in ids
                    or group.objgen in result):
                refuse()
            result.add(group.objgen)
        return result
    on, off = refs(config.get('/ON', Array())), refs(config.get('/OFF', Array()))
    if on & off:
        refuse()
    locked = refs(config.get('/Locked', Array()))
    radio = config.get('/RBGroups', Array())
    if not isinstance(radio, Array) or len(radio) > 10000:
        refuse()
    radios = [refs(group) for group in radio]
    return list(groups), config, off, locked, radios


def list_layers(file: str, for_edit: bool = False) -> dict:
    """Every optional-content group: index, name, default visibility, and the
    processing step it declares.

    `processing_step` is None on an ordinary artwork layer. Where it is
    present it carries the declared `group` and `type` verbatim (they are
    document content and are never translated), the `status` of the
    declaration, and the page-element subtype where the layer happens to
    carry one. `processing_step_count` is what tells a caller whether this is
    a packaging document at all without walking the list.
    """
    with pikepdf.open(file) as pdf:
        if for_edit:
            try:
                ocgs, _, off, locked, _ = _editable_config(pdf)
                layers = [{"index": i, "name": str(g.Name), "visible": g.objgen not in off,
                           "locked": g.objgen in locked, "processing_step": read_processing_step(g)}
                          for i, g in enumerate(ocgs)]
                return {"layers": layers, "count": len(layers), "complete": True,
                        "processing_step_count": sum(g['processing_step'] is not None for g in layers)}
            except (pikepdf.PdfError, ValueError, TypeError, AttributeError):
                return {"layers": [], "count": 0, "processing_step_count": 0, "complete": False}
        ocgs = _ocgs(pdf)
        d = _default_config(pdf)
        off = d.get("/OFF") if d is not None else None
        layers = []
        steps = 0
        for i, ocg in enumerate(ocgs):
            try:
                name = str(ocg.get("/Name")) if ocg.get("/Name") is not None else f"Layer {i + 1}"
            except Exception:
                name = f"Layer {i + 1}"
            step = read_processing_step(ocg)
            if step is not None:
                steps += 1
            # A layer is visible unless it is explicitly in the /OFF array.
            layers.append({"index": i, "name": name, "visible": not _in_array(off, ocg),
                           "processing_step": step})
        return {"layers": layers, "count": len(layers), "processing_step_count": steps}


def set_layer_visibility(file: str, output: str, index: int, visible: bool) -> dict:
    """Show or hide one layer by moving its OCG between /D /ON and /D /OFF."""
    input_path = Path(file)
    output_path = Path(output)
    same_file = is_same_file(str(input_path), str(output_path))

    with pikepdf.open(file) as pdf:
        ocgs, d, off, locked, radios = _editable_config(pdf)
        if type(index) is not int or not (0 <= index < len(ocgs)):
            raise ValueError(f"layer index {index} is out of range (0-{len(ocgs) - 1})")
        if type(visible) is not bool:
            raise ValueError("Layer configuration cannot be read completely.")
        ocp = pdf.Root.get("/OCProperties")
        d = ocp.get("/D")
        if d is None:
            d = pikepdf.Dictionary()
            ocp["/D"] = d
        target = ocgs[int(index)]
        target_og = target.objgen
        peers = set().union(*(group - {target_og} for group in radios if target_og in group)) if visible else set()
        if target_og in locked or (peers - off) & locked:
            raise ValueError("Layer is locked in the default configuration.")

        def rebuilt(key: str, keep_target: bool):
            existing = d.get(key)
            out = []
            if existing is not None:
                for el in existing:
                    try:
                        if el.objgen == target_og or el.objgen in peers:
                            continue  # drop the target; re-added below if wanted
                    except Exception:
                        pass
                    out.append(el)
            if keep_target:
                out.append(target)
            if key == '/OFF':
                out.extend(group for group in ocgs if group.objgen in peers)
            return Array(out)

        # Visible → ensure it is NOT in /OFF (and present in /ON); hidden → the
        # reverse. Rebuilding both arrays keeps the target in exactly one.
        d[Name.ON] = rebuilt("/ON", keep_target=visible)
        d[Name.OFF] = rebuilt("/OFF", keep_target=not visible)

        if same_file:
            with staged_write(output_path) as staged:
                save_pdf(pdf, str(staged))
                pdf.close()
        else:
            save_pdf(pdf, output_path)

    return {"output": str(output_path), "index": int(index), "visible": bool(visible)}
