"""The accessibility fixes that need nothing authored.

One table, in one place: check id → the door that repairs it. The panel's row
buttons and the command line's ``--fix`` both call THIS, so "what does fixing
`heading_nesting` mean" has a single answer rather than one per surface — the
same reason `form_authoring` and `lib/forms.ts` are pinned against a shared
corpus rather than left to drift.

An AUTOMATIC fix is one whose result is decided by the document: the level that
closes a heading gap, the first row of a table, the tab order a page with
annotations needs. Everything that needs a value a machine cannot invent — alt
text, a table summary, a language, a field description — is an AUTHORED fix and
lives on its own door, called per finding, because inventing that value is
worse than leaving the finding standing.

The ORDER is load-bearing, and the reason is addressing. Every fix that takes a
structure PATH runs while the tree still has the shape the single report run
read, so the addresses it produced still name what they named. The three
annotation doors run LAST because binding an annotation inserts an element, and
an insertion is the one thing that shifts a sibling path. `autotag` is the other
exception and needs no ordering care: it only applies to an untagged document,
where every structure check reported `not_applicable` and has no address to go
stale.

A door that refuses does not stop the run: its refusal is recorded against its
check and the rest still land. A run where NOTHING landed and something refused
raises, so a caller asking for one fix gets that fix's own refusal rather than
an empty success.
"""

from __future__ import annotations

from pathlib import Path

import pikepdf

from engine.accessibility import check_accessibility
from engine.autotag import autotag
from engine.derived_nav import outline_from_structure
from engine.doc_properties import (
    _signed_structural_gate,
    set_document_title,
    set_page_tab_order,
)
from engine.encrypt import grant_accessibility_permission
from engine.pdf_save import save_pdf
from engine.struct_fix import set_table_headers
from engine.struct_tree import set_struct_props
from engine.tag_content import tag_page_content

# The checks whose fix needs no authored value, in application order.
#
# `permissions` runs first because everything after it writes the file, and
# `tagged` runs before the structure checks because autotag is what gives them
# a tree to address at all.
AUTOMATIC_CHECKS = (
    "permissions",
    "tagged",
    # The suspects flag is cleared right after tagging and before every check
    # that reads the tree: a document disclaiming its own structure is
    # disclaiming what the rest of this table is about to repair.
    "suspects",
    "title",
    "bookmarks",
    "tab_order",
    "heading_nesting",
    "table_headers",
    "nested_alt",
    "alt_hides_annotation",
    # Binding an annotation into the tree needs no value from anyone: the
    # element's role follows from the annotation's own subtype.
    "tagged_annotations",
    "tagged_multimedia",
    "tagged_form_fields",
    # An attachment's two file names are the SAME name in two encodings, so
    # either one supplies the other. Nothing is authored and nothing is
    # guessed; a specification carrying neither is left standing.
    "embedded_file_names",
)

# The checks that carry an AUTHORED fix — one value the user supplies, per
# finding. Named here so a surface can ask this module which kind a check is
# rather than keeping a second list of its own.
AUTHORED_CHECKS = (
    "lang",
    # Untagged page content takes one authored value that no machine can
    # supply: whether the run is content or decoration.
    "tagged_content",
    "title",
    "field_descriptions",
    "figures_alt",
    "table_summary",
)

# `title` is in BOTH lists, and that is the check itself rather than an
# untidiness: a document with a title it does not show needs no value from
# anyone, while a document with no title needs the one thing a machine must
# never invent. The automatic arm fires only on the first.

# The verdicts a fix is offered against. A `warn` is short of the
# recommendation, which is still something the door repairs.
_FIXABLE_STATES = ("fail", "warn")


def _findings(report: dict, check_id: str) -> list:
    for check in report["checks"]:
        if check["id"] == check_id:
            return check["findings"] if check["status"] in _FIXABLE_STATES else []
    return []


def _status(report: dict, check_id: str) -> str:
    for check in report["checks"]:
        if check["id"] == check_id:
            return check["status"]
    return "not_applicable"


def _fix_permissions(source: str, output: str, report: dict, allow_signed: bool) -> int:
    grant_accessibility_permission(source, output)
    return 1


def _fix_tagged(source: str, output: str, report: dict, allow_signed: bool) -> int:
    autotag(source, output)
    return 1


def _fix_title(source: str, output: str, report: dict, allow_signed: bool) -> int:
    # The two shortfalls this check reports are not alike, and the status no
    # longer separates them: "there is a title and the reader is set to show
    # the file name instead" needs no value from anyone, while "there is no
    # title" can only be repaired by the authored fix that supplies one. The
    # finding names which, so the door reads the finding.
    if not any(
        f["detail_key"] == "title_not_displayed" for f in _findings(report, "title")
    ):
        return 0
    set_document_title(source, output, display=True, allow_signed=allow_signed)
    return 1


def _fix_suspects(source: str, output: str, report: dict, allow_signed: bool) -> int:
    """Clear `/MarkInfo /Suspects`.

    A one-key edit, and the only automatic fix in this table whose result is
    decided by nothing at all: the flag says the tagging MAY be unreliable, and
    a document that has been through this checker has a better answer than a
    maybe. The value is written false rather than deleted — ISO 32000-2 Table
    321 makes false the default, and a document that once carried the flag is
    clearer for saying it no longer holds.
    """
    gate = _signed_structural_gate(source, allow_signed)
    if gate == "refuse":
        raise RuntimeError(
            "this document is certified to allow no changes, so clearing the suspects "
            "flag would produce a file that reports as illegally modified"
        )
    if gate == "warn":
        raise RuntimeError(
            "this document is signed and clearing the suspects flag invalidates its "
            "signatures -- the run must state that signed documents are included before "
            "it will touch one"
        )
    with pikepdf.open(source, allow_overwriting_input=True) as pdf:
        mark_info = pdf.Root.get("/MarkInfo")
        if mark_info is None:
            return 0
        mark_info[pikepdf.Name("/Suspects")] = False
        save_pdf(pdf, output)
    return 1


def _fix_bookmarks(source: str, output: str, report: dict, allow_signed: bool) -> int:
    outline_from_structure(source, output)
    return 1


def _fix_tab_order(source: str, output: str, report: dict, allow_signed: bool) -> int:
    pages = sorted(
        {
            int(f["address"]["page"])
            for f in _findings(report, "tab_order")
            if f["address"].get("page") is not None
        }
    )
    if not pages:
        return 0
    set_page_tab_order(source, output, pages=pages, allow_signed=allow_signed)
    return len(pages)


def _fix_heading_nesting(source: str, output: str, report: dict, allow_signed: bool) -> int:
    applied = 0
    current = source
    for finding in _findings(report, "heading_nesting"):
        # `heading_opens_below_h1` carries no `from` — no heading precedes it —
        # and the 0 floor makes the fix H1, which is what cl. 7.4.2 asks for.
        previous = int(finding.get("values", {}).get("from", 0))
        # The level that CLOSES the gap: one below the heading before it. A
        # deeper guess would be a judgment about the document's outline.
        set_struct_props(current, output, finding["address"]["path"], {"type": f"H{previous + 1}"})
        current = output
        applied += 1
    return applied


def _fix_table_headers(source: str, output: str, report: dict, allow_signed: bool) -> int:
    applied = 0
    current = source
    for finding in _findings(report, "table_headers"):
        if finding["detail_key"] == "table_has_no_header_cells":
            set_table_headers(current, output, finding["address"]["path"])
        else:
            set_struct_props(current, output, finding["address"]["path"], {"scope": "Column"})
        current = output
        applied += 1
    return applied


# The structure type an annotation is bound under, by its subtype. A link is a
# Link, a form field is a Form, and everything else is an Annot — the three
# roles ISO 32000 table 337 names for exactly this.
_ANNOT_ROLES = {"Link": "Link", "Widget": "Form"}


def _tag_annotations(check_id: str, default_role: str = "Annot"):
    """Bind every annotation this check named into the tree.

    One call per (page, role): `tag_page_content` writes the `/OBJR` and the
    annotation's `/StructParent` together, so a page's links and its widgets
    are two calls and never one that guesses a single role for both.

    `default_role` is what the check itself knows. A widget is a `Form`
    wherever it is found, which is why the form-field check carries the role
    rather than re-deriving it from a subtype its findings never needed.
    """

    def run(source: str, output: str, report: dict, allow_signed: bool) -> int:
        groups: dict = {}
        for finding in _findings(report, check_id):
            address = finding["address"]
            page = address.get("page")
            index = address.get("annotation")
            if page is None or index is None:
                continue
            subtype = str(finding.get("values", {}).get("subtype", ""))
            role = _ANNOT_ROLES.get(subtype, default_role)
            groups.setdefault((int(page), role), []).append(int(index))
        applied = 0
        current = source
        for (page, role), indexes in sorted(groups.items()):
            tag_page_content(
                current,
                output,
                page,
                [{"annot": i} for i in sorted(indexes)],
                role=role,
                allow_signed=allow_signed,
            )
            current = output
            applied += len(indexes)
        return applied

    return run


def _clear_alt(check_id: str):
    def run(source: str, output: str, report: dict, allow_signed: bool) -> int:
        applied = 0
        current = source
        for finding in _findings(report, check_id):
            set_struct_props(current, output, finding["address"]["path"], {"alt": ""})
            current = output
            applied += 1
        return applied

    return run


def _fix_embedded_file_names(source: str, output: str, report: dict,
                             allow_signed: bool) -> int:
    """Supply the missing half of an attached file's name pair.

    ISO 14289-1 cl. 7.11 requires both `/F` and `/UF` on the file specification
    of an embedded file. They are the SAME name written twice — one in the
    system's encoding, one in Unicode — so a specification carrying either can
    have the other without anything being authored or guessed.

    A specification carrying NEITHER is left standing: there is no name to copy,
    and inventing one would name a file something it is not.

    The two keys are not the same STRING. ISO 32000-2 7.11.2 makes `/F` a byte
    string in the host system's encoding and `/UF` a text string, so copying the
    bytes of one into the other transcodes nothing: a non-ASCII `/UF` is
    UTF-16BE with a byte order mark, and those bytes read as a file name spell
    mojibake — in exactly the case the Unicode key exists for. Each direction
    therefore decodes and re-encodes:
      `/F` → `/UF`  always possible; a text string can spell any name.
      `/UF` → `/F`  only where the name is ASCII, which every host encoding
                    agrees on. A name that is not is LEFT UNWRITTEN and the
                    finding stands: `/F` names the file to a system whose
                    encoding this document never states, and guessing one would
                    write a name that is wrong rather than absent.
    """
    gate = _signed_structural_gate(source, allow_signed)
    if gate == "refuse":
        raise RuntimeError(
            "this document is certified to allow no changes, so naming its attached "
            "files would produce a file that reports as illegally modified"
        )
    if gate == "warn":
        raise RuntimeError(
            "this document is signed and naming its attached files invalidates its "
            "signatures -- the run must state that signed documents are included before "
            "it will touch one"
        )
    applied = 0
    with pikepdf.open(source, allow_overwriting_input=True) as pdf:
        for obj in pdf.objects:
            if not isinstance(obj, pikepdf.Dictionary):
                continue
            try:
                if str(obj.get("/Type") or "") != "/Filespec" or obj.get("/EF") is None:
                    continue
                name = obj.get("/F")
                unicode_name = obj.get("/UF")
            except Exception:
                continue
            if name is None and unicode_name is None:
                continue
            if name is None:
                try:
                    text = str(unicode_name)
                except Exception:
                    continue
                if not text.isascii():
                    continue
                obj[pikepdf.Name("/F")] = pikepdf.String(text)
                applied += 1
            elif unicode_name is None:
                # pikepdf decodes a byte string by the text-string rules --
                # UTF-16 behind a byte order mark, PDFDocEncoding otherwise --
                # which is the only reading of `/F` this document supports, and
                # re-encoding through `String` writes `/UF` as UTF-16BE wherever
                # that reading is not ASCII.
                try:
                    text = str(name)
                except Exception:
                    continue
                obj[pikepdf.Name("/UF")] = pikepdf.String(text)
                applied += 1
        if applied:
            save_pdf(pdf, output)
    return applied


_DOORS = {
    "permissions": _fix_permissions,
    "tagged": _fix_tagged,
    "suspects": _fix_suspects,
    "title": _fix_title,
    "bookmarks": _fix_bookmarks,
    "tab_order": _fix_tab_order,
    "heading_nesting": _fix_heading_nesting,
    "table_headers": _fix_table_headers,
    "nested_alt": _clear_alt("nested_alt"),
    "alt_hides_annotation": _clear_alt("alt_hides_annotation"),
    "tagged_annotations": _tag_annotations("tagged_annotations"),
    "tagged_multimedia": _tag_annotations("tagged_multimedia"),
    "tagged_form_fields": _tag_annotations("tagged_form_fields", "Form"),
    "embedded_file_names": _fix_embedded_file_names,
}


def apply_accessibility_fixes(
    file: str, output: str, checks=None, allow_signed: bool = False
) -> dict:
    """Apply every automatic fix the document needs, or the named ones.

    Args:
        file: Input PDF path.
        output: Output PDF path (may equal `file`).
        checks: Check ids to fix, or None for every automatic one. A check with
            no automatic fix, or one this document passes, is reported in
            `skipped` rather than refused — asking to repair what is already
            right is not an error.
        allow_signed: The signed-document decision, taken ONCE for the whole
            run rather than per door: repairing a document is one act, and a
            reader asked the same question eight times has been asked nothing.

    Returns ``{output, applied, skipped, refused}``. `applied` names each check
    and how many findings its door repaired.
    """
    wanted = list(AUTOMATIC_CHECKS) if checks is None else [str(c) for c in checks]
    unknown = [c for c in wanted if c not in _DOORS]
    if unknown:
        raise ValueError(
            f"no automatic accessibility fix exists for {', '.join(sorted(unknown))} "
            f"(the automatic ones are: {', '.join(AUTOMATIC_CHECKS)})"
        )

    output_path = Path(output)
    report = check_accessibility(file)
    source = str(file)
    applied: list = []
    skipped: list = []
    refused: list = []
    for check_id in AUTOMATIC_CHECKS:
        if check_id not in wanted:
            continue
        if _status(report, check_id) not in _FIXABLE_STATES:
            skipped.append({"check": check_id, "status": _status(report, check_id)})
            continue
        try:
            count = _DOORS[check_id](source, str(output_path), report, allow_signed)
        except (ValueError, RuntimeError) as exc:
            refused.append({"check": check_id, "reason": str(exc)})
            continue
        if count == 0:
            skipped.append({"check": check_id, "status": _status(report, check_id)})
            continue
        applied.append({"check": check_id, "findings": count})
        # Every later door reads the file the previous one wrote.
        source = str(output_path)
    if not applied and refused:
        raise RuntimeError(refused[0]["reason"])
    if not applied and checks is not None:
        # A caller that NAMED its fixes is told when none of them ran: a sweep
        # over a folder reports "nothing to repair" as a result, but a surface
        # that reported success after changing nothing would be lying about
        # the row the reader just clicked.
        # The reason is in `skipped`, structured. It is NOT composed into the
        # sentence: a refusal that interpolated its own English explanation
        # would re-emit that English inside every translated one.
        raise ValueError("There is nothing here for that fix to repair.")
    if not applied and source != str(output_path) and Path(file).resolve() != output_path.resolve():
        # Nothing to repair, and the caller asked for a copy: an output path
        # that does not exist would report a success that wrote no file.
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(Path(file).read_bytes())
    return {
        "output": str(output_path),
        "applied": applied,
        "skipped": skipped,
        "refused": refused,
    }
