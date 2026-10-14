"""The cost of every engine method against the process that serves it.

`src-tauri/src/engine.rs` `METHOD_CLASSES` names the process per method; the
table below names what each method's cost grows with. A call whose cost grows
with the whole document holds its process's FIFO for that long, and a window
process that runs it holds the page commit, the opens and every bounded read
of the window behind it.

Cost classes (one or more per row, joined by ``+``):

  K       constant: no document, or fixed document-level dictionaries
  P1      one page: its dictionaries or its content
  PG      one pass over page dictionaries, ``/Annots`` arrays or resources
  ST      one document-level structure: outline, name or number trees,
          AcroForm fields, optional content, article threads, signatures
  CS      content streams of every page, or of a page set the caller does not
          bound: parsed, text extracted, or images decoded
  OB      every object, or the whole structure tree
  FB      the whole file's bytes, read in Python
  WF      the whole file, written
  EXT     an external program or a remote service, for the method's main
          inputs or for a mode the caller selects
  EXTc    an external program only as a fallback for inputs the in-process
          path cannot decode, or a fixed small run
  LF      a list of files or a folder tree
  session the credential session
  commit  a step of the page commit

Each process serves only these classes:

  Window  every class in K, P1, PG, ST, session, commit
  Work    at least one of CS, OB, FB, WF; none of EXT, LF, session, commit
  Job/Run at least one of EXT, LF; neither session nor commit
  Health  neither session nor commit

A method in an affinity group is placed by its group: the group passes when
one member passes on its own cost.

The static check resolves every registered handler and follows its calls into
engine functions: names imported at module or function level, attributes of
an imported engine module (``from engine import x``, ``from . import x``,
``import engine.x as y``, ``import engine.x``), and re-exports. A
handler WALKS PAGE CONTENT when a content parse (``parse_content_stream``,
pdfminer's ``PDFPageInterpreter``/``process_page``, ``content_walk``'s
``GraphicsTextState``/``ClipTracker``) is reached from inside a loop over the
document's pages: a loop over ``.pages``, over pdfminer's ``get_pages``/
``create_pages``, over a page-number list or a name assigned from one, or a
loop whose body indexes ``.pages``. Every walking handler's row carries CS,
every row that carries CS without P1 walks, and a window handler that walks
fails unless its row is P1 and it takes ``page``.

The same walk over the ``/EmbeddedFiles`` tree (``pdf.attachments``) that
reaches a stream decode (``read_bytes`` and its raw and buffer forms) fails
for a window handler: its cost grows with the decoded size of every embedded
file.
"""

from __future__ import annotations

import ast
import functools
import re

import pytest

from test_engine_route_table import (
    AFFINITY_GROUPS,
    COMMIT_GROUP,
    ENGINE,
    WINDOW_ONLY,
    _handlers,
    _table,
)

CLASSES = frozenset({
    "K", "P1", "PG", "ST", "CS", "OB", "FB", "WF", "EXT", "EXTc", "LF", "session", "commit",
})

#: Every registered engine method, in `METHOD_CLASSES` order.
COST = {
    "ping": "K",
    "merge": "LF+WF",
    "split": "WF",
    "split_plan": "WF",
    "rotate": "WF",
    "delete": "WF",
    "compress": "EXT+CS+WF",
    "grayscale": "EXT+WF",
    "convert_cmyk": "EXT+CS+WF",
    "convert_pdfx": "EXT+CS+WF",
    "optimize": "WF",
    "convert_pdfa": "EXT+CS+WF",
    "encrypt": "WF",
    "grant_accessibility_permission": "WF",
    "decrypt": "WF",
    "encrypt_pubkey": "WF",
    "decrypt_pubkey": "WF",
    "open_pubkey_document": "session",
    "pubkey_reseal": "session",
    "pubkey_reattach": "session",
    "extract_text": "CS",
    "search_in_files": "LF+CS",
    "search_text_regions": "CS",
    "add_header_footer": "WF",
    "set_page_boxes": "WF",
    "content_crop": "CS+WF+EXTc",
    "get_page_labels": "ST+PG",
    "set_page_labels": "WF",
    "export_xfdf": "PG",
    "import_xfdf": "PG+WF",
    "export_count_summary": "PG",
    "list_attachments": "ST",
    "add_attachment": "WF",
    "extract_attachment": "ST",
    "remove_attachment": "WF",
    "get_portfolio": "ST",
    "create_portfolio": "LF+WF",
    "make_portfolio": "WF",
    "update_portfolio_member": "WF",
    "extract_member_to_dir": "ST",
    "list_layers": "ST",
    "set_layer_visibility": "WF",
    "check_accessibility": "CS+OB",
    "apply_accessibility_fixes": "CS+WF",
    "list_annotations": "PG",
    "list_comments": "PG",
    "summarize_comments": "WF",
    "delete_all_annotations": "WF",
    "preflight": "CS+OB+EXT",
    "list_preflight_profiles": "K",
    "validate_preflight_profile": "K",
    "apply_preflight_fixups": "CS+WF+EXT",
    "run_preflight_sweep": "LF+CS+EXT",
    "list_inks": "CS",
    "render_separations": "EXT+CS",
    "composite_separations": "LF",
    "list_simulation_profiles": "K",
    "inspect_point": "P1+EXT",
    "alias_ink": "WF",
    "compare_ink_transforms": "PG",
    "spot_to_process": "CS+WF",
    "ink_settings_defaults": "CS",
    "add_printer_marks": "CS+WF",
    "remove_printer_marks": "CS+WF",
    "list_printer_marks": "PG",
    "list_hairlines": "CS",
    "fix_hairlines": "CS+WF",
    "list_transparency": "CS",
    "flatten_transparency": "CS+EXT+WF",
    "list_outlines": "CS",
    "trap_preset_defaults": "K",
    "validate_trap_preset": "K",
    "assign_trap_presets": "CS+WF",
    "list_trap_presets": "CS",
    "emit_trapping_setup": "FB+WF",
    "export_postscript": "EXT+CS",
    "get_struct_tree": "OB",
    "set_struct_props": "WF",
    "set_table_headers": "WF",
    "tag_page_content": "P1+OB+WF",
    "move_struct_node": "WF",
    "delete_struct_node": "WF",
    "add_struct_node": "WF",
    "list_links": "PG",
    "set_link_url": "WF",
    "set_link_target": "WF",
    "set_link_appearance": "WF",
    "set_link_rect": "WF",
    "list_named_destinations": "ST",
    "delete_link": "WF",
    "add_links": "WF",
    "export_document": "EXT+CS",
    "supported_export_formats": "K",
    "detect_tables": "CS",
    "export_images": "EXT",
    "get_metadata": "K",
    "set_metadata": "WF",
    "strip_metadata": "WF",
    "get_pdf_version": "K",
    "set_pdf_version": "WF",
    "get_initial_view": "K+PG",
    "set_initial_view": "WF",
    "get_advanced_properties": "PG",
    "set_advanced_properties": "WF",
    "set_document_language": "WF",
    "set_document_title": "WF",
    "set_page_tab_order": "WF",
    "list_document_fonts": "PG",
    "get_page_count": "PG",
    "get_page_info": "P1",
    "check_encrypted": "K",
    "unlock": "session",
    "open_document": "session",
    "open_document_attempt": "session",
    "close_document": "session",
    "document_permissions": "session",
    "share_document": "session",
    "sealed_plaintext": "commit",
    "sealed_reseal": "commit",
    "repair": "WF",
    "rebuild": "EXT+WF",
    "recover": "WF",
    "check": "PG",
    "document_health": "CS+OB",
    "document_health_begin": "PG",
    "document_health_step": "CS",
    "document_health_end": "K",
    "get_outline": "ST",
    "set_outline": "WF",
    "preview_structure_outline": "CS",
    "outline_from_structure": "CS+WF",
    "read_aloud_page": "P1+OB",
    "find_url_links": "CS",
    "create_links_from_urls": "CS+WF",
    "list_threads": "PG",
    "set_threads": "WF",
    "list_document_js": "ST",
    "set_document_js": "WF",
    "redact": "CS+WF+EXTc",
    "remove_redaction_residue": "OB+WF",
    "search_and_redact": "CS+WF+EXTc",
    "audit_hidden_information": "CS+OB",
    "sanitize_pdf": "CS+OB+WF",
    "audit_space_usage": "FB+OB",
    "watermark": "WF",
    "compare_text": "CS",
    "compare_visual": "EXT",
    "read_form_fields": "ST+PG",
    "fill_form_fields": "CS+WF",
    "reset_form_fields": "CS+WF",
    "export_form_data": "ST",
    "import_form_data": "CS+WF",
    "set_widget_visibility": "WF",
    "detect_form_fields": "CS+EXT",
    "create_detected_fields": "WF",
    "prepare_form_fields": "CS+EXT+WF",
    "set_field_lock": "WF",
    "author_vertical_field_font": "WF",
    "author_choice_appearance": "WF",
    "set_field_actions": "WF",
    "set_field_description": "WF",
    "apply_ocr_layer": "CS+WF",
    "recognize": "EXT",
    "recognize_raster": "EXT",
    "analyze_scan": "CS+EXT",
    "enhance_scan": "CS+EXT+WF",
    "batch_ocr": "LF+EXT+CS",
    "ocr_file": "EXT+CS+WF",
    "recognize_music_prepare": "CS+WF+EXTc",
    "recognize_music_run": "EXT",
    "recognize_music_publish": "K",
    "recognize_music_attach": "WF",
    "recognize_music_discard": "K",
    "remove_empty_folders": "LF",
    "run_action": "LF+EXT+CS",
    "autotag": "CS+WF",
    "list_page_images": "P1",
    "summarize_image_resolution": "CS",
    "delete_page_image": "P1+WF",
    "replace_page_image": "P1+WF",
    "extract_page_image": "P1",
    "transform_page_image": "P1+WF",
    "transform_page_images": "P1+WF",
    "delete_page_images": "P1+WF",
    "add_page_image": "P1+WF",
    "add_page_vector_graphic": "P1+WF",
    "crop_page_image": "P1+WF",
    "list_page_vectors": "P1",
    "list_page_geometry": "P1",
    "delete_page_vector": "P1+WF",
    "transform_page_vector": "P1+WF",
    "restyle_page_vector": "P1+WF",
    "set_image_opacity": "P1+WF",
    "replace_text_run": "P1+WF",
    "restyle_text_run": "P1+WF",
    "convert_text_run": "P1+WF",
    "list_text_paragraphs": "P1",
    "replace_paragraph_text": "P1+WF",
    "merge_paragraph_with_previous": "P1+WF",
    "list_dictionaries": "K",
    "check_spelling": "CS",
    "check_text": "K",
    "document_language": "K",
    "spelling_suggestions": "K",
    "add_user_dictionary": "K",
    "distill": "EXT",
    "create_pdf": "EXT+WF",
    "list_source_folders": "LF",
    "create_pdf_folders": "LF+EXT",
    # Installed fonts, not the document: the first call in a process reads
    # every font file once and caches the scan.
    "list_system_fonts": "K",
    "add_text_box": "P1+WF",
    "measure_text_box": "K",
    # The text of the blocks it is given, and the bundled faces: no document.
    "text_box_appearance": "K",
    "print": "EXT",
    "print_preview": "EXT",
    "print_preview_cleanup": "LF",
    "printed_job": "EXT",
    "verify_signatures": "FB+PG",
    "sign_pdf": "FB+WF+EXT",
    "generate_signer": "K",
    "list_pkcs11_certificates": "K",
    "list_csc_credentials": "EXT",
    "preview_stamp_appearance": "K",
    "transplant_incremental": "commit",
    "signature_policy": "ST",
    "save_redaction_marks": "PG+WF",
    "list_redact_annotations": "PG",
}

#: CS rows the static check cannot see walking, and where the content parse is.
UNSEEN_CS = {
    "preview_structure_outline": "a per-page cache method parses content during a structure-tree walk",
}

#: The credential session: the window-only methods and the permissions read of
#: a registered credential.
SESSION = frozenset(WINDOW_ONLY) | {"document_permissions"}

WINDOW_CLASSES = frozenset({"K", "P1", "PG", "ST", "session", "commit"})
WORK_CLASSES = frozenset({"CS", "OB", "FB", "WF"})
EXTERNAL_CLASSES = frozenset({"EXT", "LF"})
PINNED = frozenset({"session", "commit"})

PARSERS = frozenset({
    "parse_content_stream", "PDFPageInterpreter", "process_page", "GraphicsTextState", "ClipTracker",
})
PAGE_ITERATORS = frozenset({"pages", "get_pages", "create_pages"})
PAGE_NAMES = re.compile(r"pages|page_numbers|page_list")
DECODERS = frozenset({"read_bytes", "read_raw_bytes", "get_stream_buffer", "get_raw_stream_buffer"})
FUNCTIONS = (ast.FunctionDef, ast.AsyncFunctionDef)
COMPREHENSIONS = (ast.ListComp, ast.SetComp, ast.GeneratorExp, ast.DictComp)


def _classes(method: str) -> frozenset:
    return frozenset(COST[method].split("+"))


def _allowed(process: str, classes: frozenset) -> bool:
    if process == "Window":
        return classes <= WINDOW_CLASSES
    if process == "Work":
        return bool(classes & WORK_CLASSES) and not classes & (EXTERNAL_CLASSES | PINNED)
    if process in ("Job", "Run"):
        return bool(classes & EXTERNAL_CLASSES) and not classes & PINNED
    if process == "Health":
        return not classes & PINNED
    raise AssertionError(f"unknown process {process}")


# The static walk check.

_TREES: dict = {}


def _tree(module: str):
    if module not in _TREES:
        path = ENGINE / (module.replace(".", "/") + ".py")
        if not path.exists():
            path = ENGINE / module.replace(".", "/") / "__init__.py"
        _TREES[module] = ast.parse(path.read_text(encoding="utf-8")) if path.exists() else None
    return _TREES[module]


@functools.lru_cache(maxsize=None)
def _is_module(module: str) -> bool:
    return (ENGINE / (module.replace(".", "/") + ".py")).exists() or (
        ENGINE / module.replace(".", "/") / "__init__.py"
    ).exists()


def _engine_imports(nodes) -> tuple[dict, dict]:
    """``(functions, modules)`` the import statements in ``nodes`` bind:
    ``name -> (module, function)`` and ``name -> module``. ``import engine.x``
    binds the package itself, mapped to the empty module name."""
    functions: dict = {}
    modules: dict = {}
    for node in nodes:
        if isinstance(node, ast.ImportFrom):
            if node.level:
                base = "engine" + (f".{node.module}" if node.module else "")
            else:
                base = node.module or ""
            if base != "engine" and not base.startswith("engine."):
                continue
            package = base[len("engine."):] if base != "engine" else ""
            for alias in node.names:
                bound = alias.asname or alias.name
                child = f"{package}.{alias.name}" if package else alias.name
                if _is_module(child):
                    modules[bound] = child
                else:
                    functions[bound] = (package or "__init__", alias.name)
        elif isinstance(node, ast.Import):
            for alias in node.names:
                if not alias.name.startswith("engine."):
                    continue
                if alias.asname:
                    modules[alias.asname] = alias.name[len("engine."):]
                else:
                    modules["engine"] = ""
    return functions, modules


def _resolve(module: str, name: str, seen: frozenset = frozenset()):
    """``(module, FunctionDef)`` that ``name`` names in ``module``, or None."""
    tree = _tree(module)
    if tree is None or (module, name) in seen:
        return None
    for node in tree.body:
        if isinstance(node, FUNCTIONS) and node.name == name:
            return module, node
    target = _engine_imports(tree.body)[0].get(name)
    return _resolve(*target, seen | {(module, name)}) if target else None


def _callee_name(call: ast.Call):
    func = call.func
    if isinstance(func, ast.Name):
        return func.id
    if isinstance(func, ast.Attribute):
        return func.attr
    return None


def _module_named(expr, modules: dict):
    """The engine module ``expr`` names (``x``, ``engine.x``), or None."""
    if isinstance(expr, ast.Name):
        found = modules.get(expr.id)
        return found if found else None
    if isinstance(expr, ast.Attribute):
        if isinstance(expr.value, ast.Name) and modules.get(expr.value.id) == "":
            package = ""
        else:
            package = _module_named(expr.value, modules)
            if package is None:
                return None
        child = f"{package}.{expr.attr}" if package else expr.attr
        return child if _is_module(child) else None
    return None


_CALLS: dict = {}


def _calls(module: str, fn) -> dict:
    """Each call in ``fn`` that names an engine function, and that function:
    a bare name, or an attribute of an imported engine module."""
    key = (module, id(fn))
    if key not in _CALLS:
        _CALLS[key] = _find_calls(module, fn)
    return _CALLS[key]


def _find_calls(module: str, fn) -> dict:
    tree = _tree(module)
    outer_modules = _engine_imports(tree.body)[1] if tree is not None else {}
    local_functions, local_modules = _engine_imports(ast.walk(fn))
    modules = {**outer_modules, **local_modules}
    out = {}
    for node in ast.walk(fn):
        if not isinstance(node, ast.Call):
            continue
        target = None
        if isinstance(node.func, ast.Name):
            name = node.func.id
            target = _resolve(*local_functions[name]) if name in local_functions else _resolve(module, name)
        elif isinstance(node.func, ast.Attribute):
            owner = _module_named(node.func.value, modules)
            if owner is not None:
                target = _resolve(owner, node.func.attr)
        if target is not None:
            out[node] = target
    return out


class _Walk:
    """A loop over one of the document's collections that reaches a call whose
    cost grows with what it reads."""

    def __init__(self, attributes: frozenset, names, constants: frozenset, targets: frozenset):
        self.attributes = attributes
        self.names = names
        self.constants = constants
        self.targets = targets
        self.reaches: dict = {}
        self.walks: dict = {}

    def target(self, node) -> bool:
        return isinstance(node, ast.Call) and _callee_name(node) in self.targets

    def source(self, node, tainted: set) -> bool:
        if isinstance(node, ast.Attribute):
            return node.attr in self.attributes
        if isinstance(node, ast.Name):
            return node.id in tainted or bool(self.names.search(node.id))
        if isinstance(node, ast.Call):
            name = _callee_name(node)
            return bool(name and self.names.search(name))
        if isinstance(node, ast.Constant):
            return node.value in self.constants
        return False

    def tainted(self, fn) -> set:
        """Names ``fn`` assigns from a source, to a fixed point."""
        names: set = set()
        grew = True
        while grew:
            grew = False
            for node in ast.walk(fn):
                if isinstance(node, ast.Assign):
                    pairs = [(target, node.value) for target in node.targets]
                elif isinstance(node, (ast.AnnAssign, ast.AugAssign, ast.NamedExpr)) and node.value is not None:
                    pairs = [(node.target, node.value)]
                else:
                    continue
                for target, value in pairs:
                    if any(self.source(x, names) for x in ast.walk(value)):
                        for name in ast.walk(target):
                            if isinstance(name, ast.Name) and name.id not in names:
                                names.add(name.id)
                                grew = True
        return names

    def loop_body(self, node, tainted: set):
        """The nodes a loop over the collection runs, or None."""
        if isinstance(node, (ast.For, ast.AsyncFor)):
            head, body = [node.iter], [x for stmt in node.body for x in ast.walk(stmt)]
        elif isinstance(node, ast.While):
            head, body = [node.test], [x for stmt in node.body for x in ast.walk(stmt)]
        elif isinstance(node, COMPREHENSIONS):
            head = [generator.iter for generator in node.generators]
            body = [x for generator in node.generators for cond in generator.ifs for x in ast.walk(cond)]
            for part in (getattr(node, "elt", None), getattr(node, "key", None), getattr(node, "value", None)):
                if part is not None:
                    body.extend(ast.walk(part))
        else:
            return None
        if any(self.source(x, tainted) for expr in head for x in ast.walk(expr)):
            return body
        if any(
            isinstance(x, ast.Subscript) and isinstance(x.value, ast.Attribute) and x.value.attr in self.attributes
            for x in body
        ):
            return body
        return None

    # A result found while a caller still on the stack was cut off as a back
    # edge depends on that caller's answer, so it is cached only once that
    # caller finishes: caching it earlier makes a walker found or missed by the
    # order the handlers are evaluated in. A hit is final whatever the stack.

    def reached(self, module: str, fn) -> bool:
        return self._reached(module, fn, frozenset())[0]

    def walked(self, module: str, fn) -> bool:
        return self._walked(module, fn, frozenset())[0]

    def _reached(self, module: str, fn, stack: frozenset) -> tuple[bool, frozenset]:
        key = (module, fn.name)
        if key in self.reaches:
            return self.reaches[key], frozenset()
        if key in stack:
            return False, frozenset({key})
        if any(self.target(node) for node in ast.walk(fn)):
            self.reaches[key] = True
            return True, frozenset()
        open_edges: set = set()
        for target in _calls(module, fn).values():
            hit, edges = self._reached(*target, stack | {key})
            if hit:
                self.reaches[key] = True
                return True, frozenset()
            open_edges |= edges
        open_edges.discard(key)
        if not open_edges:
            self.reaches[key] = False
        return False, frozenset(open_edges)

    def _walked(self, module: str, fn, stack: frozenset) -> tuple[bool, frozenset]:
        key = (module, fn.name)
        if key in self.walks:
            return self.walks[key], frozenset()
        if key in stack:
            return False, frozenset({key})
        calls = _calls(module, fn)
        tainted = self.tainted(fn)
        for node in ast.walk(fn):
            body = self.loop_body(node, tainted)
            if body and any(self.target(x) or (x in calls and self.reached(*calls[x])) for x in body):
                self.walks[key] = True
                return True, frozenset()
        open_edges: set = set()
        for target in calls.values():
            hit, edges = self._walked(*target, stack | {key})
            if hit:
                self.walks[key] = True
                return True, frozenset()
            open_edges |= edges
        open_edges.discard(key)
        if not open_edges:
            self.walks[key] = False
        return False, frozenset(open_edges)


#: Page content parsed inside a loop over the pages.
PAGE_CONTENT = _Walk(PAGE_ITERATORS, PAGE_NAMES, frozenset(), PARSERS)

#: Embedded files decoded inside a loop over the `/EmbeddedFiles` tree.
EMBEDDED_FILES = _Walk(
    frozenset({"attachments", "EmbeddedFiles"}),
    re.compile(r"attachment|embedded_file"),
    frozenset({"/EmbeddedFiles"}),
    DECODERS,
)


def _registered() -> dict:
    """``method -> (module, FunctionDef)`` of every registered handler."""
    out = {}
    for node in ast.walk(_tree("__main__")):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "register":
            target = _resolve("__main__", node.args[1].id)
            assert target is not None, f"unresolved handler of {node.args[0].value}"
            out[node.args[0].value] = target
    return out


def _walking(walk: _Walk = PAGE_CONTENT) -> set:
    return {method for method, target in _registered().items() if walk.walked(*target)}


def test_every_registered_method_has_a_cost_row_and_every_row_is_registered():
    handlers = _handlers()
    assert len(handlers) > 200, "registration walk stopped resolving"
    assert sorted(set(handlers) - set(COST)) == [], "registered methods without a cost row"
    assert sorted(set(COST) - set(handlers)) == [], "cost rows naming no registered method"


def test_every_cost_row_names_known_classes():
    unknown = [m for m in COST if not _classes(m) <= CLASSES]
    assert unknown == [], "cost rows naming an unknown class"
    mixed = [m for m in COST if _classes(m) & PINNED and len(_classes(m)) != 1]
    assert mixed == [], "session and commit stand alone in a row"


def test_the_session_and_commit_rows_are_the_session_and_commit_methods():
    assert sorted(m for m in COST if COST[m] == "session") == sorted(SESSION)
    assert sorted(m for m in COST if COST[m] == "commit") == sorted(COMMIT_GROUP)


def test_each_process_serves_only_its_cost_classes():
    rows = _table()
    group_of = {method: group for group in AFFINITY_GROUPS for method in group}
    refused = []
    for method, process in rows.items():
        group = group_of.get(method, (method,))
        if not any(_allowed(process, _classes(member)) for member in group):
            refused.append(method)
    assert refused == [], "rows whose process the cost rule refuses"


def test_a_window_handler_never_walks_page_content():
    rows = _table()
    registered = _registered()
    offenders = []
    for method in sorted(_walking()):
        if rows[method] != "Window":
            continue
        _module, fn = registered[method]
        params = [a.arg for a in fn.args.posonlyargs + fn.args.args + fn.args.kwonlyargs]
        if "P1" in _classes(method) and "page" in params:
            continue
        offenders.append(method)
    assert offenders == [], "window handlers that walk page content"


def test_a_handler_walks_page_content_exactly_when_its_row_says_cs():
    walking = _walking()
    unmarked = sorted(m for m in walking if "CS" not in _classes(m))
    assert unmarked == [], "handlers that walk page content with no CS in their row"
    unseen = sorted(m for m in COST if "CS" in _classes(m) and "P1" not in _classes(m) and m not in walking)
    assert unseen == sorted(UNSEEN_CS), "CS rows the static check does not see walking"


def test_a_window_handler_never_decodes_every_embedded_file():
    rows = _table()
    offenders = sorted(m for m in _walking(EMBEDDED_FILES) if rows[m] == "Window")
    assert offenders == [], "window handlers that decode every embedded file"


_CYCLE = """
def walker(pdf):
    for page in pdf.pages:
        parse_content_stream(page)


def back(pdf):
    front(pdf)


def front(pdf):
    back(pdf)
    walker(pdf)


def entry(pdf):
    back(pdf)
"""


@pytest.mark.parametrize("order", [("front", "entry"), ("entry", "front"), ("back", "entry", "front")])
def test_a_call_graph_cycle_finds_a_walker_whatever_the_evaluation_order(monkeypatch, order):
    module = "_cycle_fixture"
    monkeypatch.setitem(_TREES, module, ast.parse(_CYCLE))
    walk = _Walk(PAGE_ITERATORS, PAGE_NAMES, frozenset(), PARSERS)
    functions = {node.name: node for node in _TREES[module].body if isinstance(node, FUNCTIONS)}
    answers = {name: walk.walked(module, functions[name]) for name in order}
    assert answers == {name: True for name in order}
    assert walk.walked(module, functions["walker"]) is True
