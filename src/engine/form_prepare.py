"""Turn detected field candidates into real fields, by path.

Two composed doors over parts that already exist -- the detector
(``detect_form_fields``) and the authoring primitive (``add_form_fields``).
Nothing here decides where a field goes or what it is called; what it owns is
the ONE rule that turns a candidate LIST into a field list:

  * a radio group collapses into one field whose options carry their own
    rectangles, because the circles a form draws are separately placed buttons
    and equal cells of one enclosing rectangle cannot express that;
  * a group's members land on the page its first option is on -- one field with
    widgets on two pages is one field with two homes;
  * names are made unique against the document AND within the batch, since a
    duplicate name refuses the whole write.

``create_detected_fields`` is the reviewed path: the caller sends back the rows
it kept. ``prepare_form_fields`` is the headless one: it detects and then
creates EVERY candidate, because a run with no reviewer has nobody to ask.
"""

from pathlib import Path
import shutil

from engine.afemit import DETECTED_DATE_FORMAT
from engine.form_authoring import add_form_fields, existing_field_names
from engine.form_detect import MAX_CANDIDATES_DEFAULT, detect_form_fields

# The kinds the detector emits. A narrower run names a subset; an unknown name
# refuses rather than silently matching nothing.
CANDIDATE_KINDS = ("text", "checkbox", "radio", "signature")


def _sanitize_name(raw: str) -> str:
    """The characters a field name can carry.

    '.' separates a parent from its child and '/' delimits a name, so neither
    survives; whitespace collapses to a single underscore.
    """
    kept = []
    for ch in (raw or "").strip():
        if ch.isalnum() or ch in " _-" or ord(ch) > 127:
            kept.append(ch)
    return "_".join("".join(kept).split()).strip("_")


def _unique(base: str, taken: set) -> str:
    stem = base or "Field"
    if stem not in taken:
        taken.add(stem)
        return stem
    for suffix in range(2, 100):
        candidate = f"{stem}_{suffix}"
        if candidate not in taken:
            taken.add(candidate)
            return candidate
    raise ValueError(
        f"cannot name the detected field {stem}: too many fields already carry that name"
    )


def _union(rects: list) -> list:
    return [
        min(r[0] for r in rects),
        min(r[1] for r in rects),
        max(r[2] for r in rects),
        max(r[3] for r in rects),
    ]


def specs_from_candidates(candidates, existing_names=None) -> list:
    """Detected candidate rows as authoring specs, in the order they arrive."""
    taken = set(existing_names or ())
    rows = list(candidates or [])
    groups: dict = {}
    for row in rows:
        key = row.get("group") if row.get("kind") == "radio" else None
        if key:
            groups.setdefault(key, []).append(row)

    specs = []
    emitted = set()
    for row in rows:
        kind = row.get("kind") or "text"
        rect = [float(v) for v in row["rect"]]
        page_index = int(row["page"]) - 1
        key = row.get("group") if kind == "radio" else None
        if key:
            if key in emitted:
                continue
            emitted.add(key)
            members = groups[key]
            page_index = int(members[0]["page"]) - 1
            on_page = [m for m in members if int(m["page"]) - 1 == page_index]
            options = []
            for index, member in enumerate(on_page):
                label = member.get("export") or member.get("label") or f"Option {index + 1}"
                options.append(
                    {"label": label, "rect": [float(v) for v in member["rect"]]}
                )
            specs.append(
                {
                    "name": _unique(_sanitize_name(row.get("name") or ""), taken),
                    "type": "radio",
                    "page_index": page_index,
                    "rect": _union([o["rect"] for o in options]),
                    "options": options,
                }
            )
            continue
        # A radio that carries no group has no option set, so it reaches
        # validation as the invalid spec it is and refuses by name rather than
        # landing as some other kind of field nobody asked for.
        spec = {
            "name": _unique(_sanitize_name(row.get("name") or ""), taken),
            "type": kind if kind in ("text", "checkbox", "signature", "radio") else "text",
            "page_index": page_index,
            "rect": rect,
        }
        if spec["type"] == "text":
            if row.get("multiline"):
                spec["multiline"] = True
            comb = row.get("comb")
            if comb and not row.get("multiline"):
                spec["comb"] = True
                spec["max_length"] = int(comb)
            # The detector's own format hint, carried into the spec so a
            # detected date field lands with a date format rather than with the
            # hint stopping at the review surface.
            if row.get("format") == "date":
                spec["format"] = dict(DETECTED_DATE_FORMAT)
        specs.append(spec)
    return specs


def create_detected_fields(
    file: str,
    output: str,
    candidates=None,
    allow_signed: bool = False,
    font_dir: str = "",
) -> dict:
    """Create the fields these candidate rows describe.

    The rows are the detector's own, so a caller that reviewed them sends back
    exactly what it kept -- nothing is detected again here, and a second
    detection pass could not be trusted to enumerate in the same order anyway.

    A request with no rows still writes ``output``: a step in the middle of a
    sequence, or a mirror pass, needs the file it named.
    """
    rows = list(candidates or [])
    if not rows:
        if Path(file).resolve() != Path(output).resolve():
            Path(output).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(file, output)
        return {"output": str(output), "created": 0, "names": [], "candidates": 0}
    specs = specs_from_candidates(rows, existing_field_names(file))
    result = add_form_fields(file, output, specs, allow_signed=allow_signed, font_dir=font_dir)
    result["candidates"] = len(rows)
    return result


def prepare_form_fields(
    file: str,
    output: str,
    pages="all",
    scan: str = "auto",
    lang: str = "eng",
    tesseract_path: str = "",
    gs_path: str = "",
    max_candidates: int = MAX_CANDIDATES_DEFAULT,
    kinds=None,
    allow_signed: bool = False,
    font_dir: str = "",
) -> dict:
    """Detect this file's field candidates and create every one of them.

    Returns ``{output, candidates, created, names, unoffered, pages_by_source,
    existing_fields, truncated}``.

    There is NO review step here, so every candidate the detector offers
    becomes a field. `kinds` is the only narrowing an unattended run can make:
    a subset of text, checkbox, radio, signature.
    """
    wanted = list(kinds or CANDIDATE_KINDS)
    unknown = sorted(set(wanted) - set(CANDIDATE_KINDS))
    if unknown:
        raise ValueError(
            f"unknown field kind: {unknown[0]} (choose from {', '.join(CANDIDATE_KINDS)})"
        )
    detected = detect_form_fields(
        file,
        pages=pages,
        scan=scan,
        lang=lang,
        tesseract_path=tesseract_path,
        gs_path=gs_path,
        max_candidates=max_candidates,
    )
    rows = [row for row in detected["candidates"] if row["kind"] in wanted]
    written = create_detected_fields(
        file, output, rows, allow_signed=allow_signed, font_dir=font_dir
    )
    return {
        "output": written["output"],
        "candidates": len(rows),
        "created": written["created"],
        "names": written["names"],
        "unoffered": detected["unoffered"],
        "pages_by_source": detected["pages_by_source"],
        "existing_fields": detected["existing_fields"],
        "truncated": detected["truncated"],
    }
