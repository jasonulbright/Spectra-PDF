"""
Spectra PDF Engine - JSON-RPC 2.0 server over stdin/stdout.

Receives requests from the Tauri backend, dispatches to
the appropriate handler, and returns results.
"""

import sys

# The JSON-RPC channel is UTF-8 BY CONTRACT. On Windows an embedded Python
# defaults its stdio to the ANSI codepage (cp1252), which silently decodes the
# Rust side's UTF-8 request bytes as cp1252 — mojibake for EVERY non-ASCII
# value on every text-carrying op (metadata titles, watermark text, form
# values, bookmark titles, signer names), in the GUI and the CLI alike, and it
# corrupts valid values, such as "José García", and can turn non-WinAnsi text
# into cp1252 gibberish that passes later encoding checks.
# Reconfigure both directions before the server reads anything. The spawners
# also set PYTHONUTF8=1 (engine.rs / cli.rs) as belt-and-suspenders — this
# line is the authoritative fix that holds no matter how the engine is run.
sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")

from engine.ipc import JsonRpcServer
from engine.merge import merge
from engine.split import split
from engine.rotate import rotate
from engine.delete import delete
from engine.compress import compress
from engine.grayscale import grayscale
from engine.prepress import convert_cmyk, convert_pdfx
from engine.optimize import optimize
from engine.pdfa import convert_pdfa
from engine.encrypt import decrypt, encrypt, grant_accessibility_permission
from engine.pubkey_crypt import decrypt_with_pfx, encrypt_with_certs
from engine.extract_text import extract_text
from engine.search_in_files import search_in_files
from engine.search_regions import search_text_regions
from engine.headers import add_header_footer
from engine.content_crop import content_crop
from engine.page_boxes import set_page_boxes
from engine.page_labels import get_page_labels, set_page_labels
from engine.layers import list_layers, set_layer_visibility
from engine.accessibility import check_accessibility
from engine.accessibility_fixes import apply_accessibility_fixes
from engine.annotations import delete_all_annotations, list_annotations
from engine.preflight import (
    list_preflight_profiles,
    preflight,
    validate_preflight_profile,
)
from engine.preflight_fixups import apply_fixups
from engine.preflight_sweep import run_preflight_sweep
from engine.separations import (
    composite_separations,
    list_inks,
    render_separations,
)
from engine.ink_manager import (
    alias_ink,
    compare_tint_transforms,
    ink_settings_defaults,
    spot_to_process,
)
from engine.flattener import flatten_transparency, list_transparency
from engine.outlines import list_outlines
from engine.trapping import (
    assign_presets,
    emit_trapping_setup,
    export_postscript,
    list_trap_presets,
    trap_preset_defaults,
    validate_trap_preset,
)
from engine.hairlines import fix_hairlines, list_hairlines
from engine.printer_marks import (
    add_printer_marks,
    list_printer_marks,
    remove_printer_marks,
)
from engine.links import (
    add_links,
    create_links_from_urls,
    delete_link,
    find_url_links,
    list_links,
    set_link_url,
)
from engine.threads import list_threads, set_threads
from engine.office_export import export_document, supported_formats
from engine.table_export import detect_table_regions
from engine.image_export import export_images
from engine.xfdf import export_xfdf, import_xfdf
from engine.takeoff import export_count_summary
from engine.attachments import (
    add_attachment,
    extract_attachment,
    list_attachments,
    remove_attachment,
)
from engine.portfolio import (
    create_portfolio,
    extract_member_to_dir,
    get_portfolio,
    make_portfolio,
    update_portfolio_member,
)
from engine.metadata import get_metadata, set_metadata, strip_metadata
from engine.doc_properties import (
    get_advanced_properties,
    get_initial_view,
    set_advanced_properties,
    set_document_language,
    set_document_title,
    set_initial_view,
    set_page_tab_order,
)
from engine.font_inventory import list_document_fonts
from engine.reversion import get_pdf_version, set_pdf_version
from engine.inspect import get_page_count, get_page_info, check_encrypted, unlock
from engine.repair import repair
from engine.rebuild import rebuild
from engine.recover import recover
from engine.check import check
from engine.outline import get_outline, set_outline
from engine.derived_nav import outline_from_structure, preview_structure_outline
from engine.read_aloud import read_aloud_page
from engine.document_js import list_document_js, set_document_js
from engine.redact import redact
from engine.search_redact import search_and_redact
from engine.sanitize import audit_hidden_information, sanitize_pdf
from engine.space_audit import audit_space_usage
from engine.watermark import watermark
from engine.compare import compare_text, compare_visual
from engine.form_detect import detect_form_fields
from engine.form_authoring import set_field_actions, set_field_description, set_field_lock
from engine.form_prepare import create_detected_fields, prepare_form_fields
from engine.forms import (
    export_form_data,
    fill_form_fields,
    import_form_data,
    read_form_fields,
    reset_form_fields,
    set_widget_visibility,
)
from engine.enhance_scan import analyze_scan, enhance_scan
from engine.ocr_layer import apply_ocr_layer
from engine.recognize import recognize
from engine.batch_ocr import batch_ocr, ocr_file
from engine.guided_actions import run_action
from engine.autotag import autotag
from engine.image_resolution import summarize_image_resolution
from engine.page_images import (
    add_page_image,
    add_page_vector_graphic,
    crop_page_image,
    delete_page_image,
    delete_page_images,
    extract_page_image,
    list_page_images,
    replace_page_image,
    set_image_opacity,
    transform_page_image,
    transform_page_images,
)
from engine.page_vectors import (
    delete_page_vector,
    list_page_geometry,
    list_page_vectors,
    restyle_page_vector,
    transform_page_vector,
)
from engine.distill import distill
from engine.create_pdf import create_pdf
from engine.create_pdf_folders import create_pdf_folders, list_source_folders
from engine.system_fonts import list_system_fonts
from engine.text_authoring import add_text_box, measure_text_box
from engine.text_paragraphs import (
    list_text_paragraphs,
    merge_paragraph_with_previous,
    replace_paragraph_text,
)
from engine.text_runs import convert_text_run, list_text_runs, replace_text_run, restyle_text_run
from engine.spelling import (
    add_user_dictionary,
    check_spelling,
    check_text,
    document_language,
    list_dictionaries,
    spelling_suggestions,
)
from engine.printer import print_pdf, print_preview, print_preview_cleanup
from engine.incremental import signature_policy, transplant_incremental
from engine.redact_marks import list_redact_annotations, save_redaction_marks
from engine.signatures import verify_signatures, sign_pdf, generate_signer
from engine.struct_fix import set_table_headers
from engine.tag_content import tag_page_content
from engine.struct_tree import (
    add_struct_node,
    delete_struct_node,
    get_struct_tree,
    move_struct_node,
    set_struct_props,
)


def ping() -> dict:
    return {"status": "ok", "engine": "spectra-pdf", "version": "0.2.0"}


def main() -> None:
    server = JsonRpcServer()
    server.register("ping", ping)
    server.register("merge", merge)
    server.register("split", split)
    server.register("rotate", rotate)
    server.register("delete", delete)
    server.register("compress", compress)
    server.register("grayscale", grayscale)
    server.register("convert_cmyk", convert_cmyk)
    server.register("convert_pdfx", convert_pdfx)
    server.register("optimize", optimize)
    server.register("convert_pdfa", convert_pdfa)
    server.register("encrypt", encrypt)
    server.register("grant_accessibility_permission", grant_accessibility_permission)
    server.register("decrypt", decrypt)
    server.register("encrypt_pubkey", encrypt_with_certs)
    server.register("decrypt_pubkey", decrypt_with_pfx)
    server.register("extract_text", extract_text)
    server.register("search_in_files", search_in_files)
    server.register("search_text_regions", search_text_regions)
    server.register("add_header_footer", add_header_footer)
    server.register("set_page_boxes", set_page_boxes)
    server.register("content_crop", content_crop)
    server.register("get_page_labels", get_page_labels)
    server.register("set_page_labels", set_page_labels)
    server.register("export_xfdf", export_xfdf)
    server.register("import_xfdf", import_xfdf)
    server.register("export_count_summary", export_count_summary)
    server.register("list_attachments", list_attachments)
    server.register("add_attachment", add_attachment)
    server.register("extract_attachment", extract_attachment)
    server.register("remove_attachment", remove_attachment)
    server.register("get_portfolio", get_portfolio)
    server.register("create_portfolio", create_portfolio)
    server.register("make_portfolio", make_portfolio)
    server.register("update_portfolio_member", update_portfolio_member)
    server.register("extract_member_to_dir", extract_member_to_dir)
    server.register("list_layers", list_layers)
    server.register("set_layer_visibility", set_layer_visibility)
    server.register("check_accessibility", check_accessibility)
    server.register("apply_accessibility_fixes", apply_accessibility_fixes)
    server.register("list_annotations", list_annotations)
    server.register("delete_all_annotations", delete_all_annotations)
    server.register("preflight", preflight)
    server.register("list_preflight_profiles", list_preflight_profiles)
    server.register("validate_preflight_profile", validate_preflight_profile)
    server.register("apply_preflight_fixups", apply_fixups)
    server.register("run_preflight_sweep", run_preflight_sweep)
    server.register("list_inks", list_inks)
    server.register("render_separations", render_separations)
    server.register("composite_separations", composite_separations)
    server.register("alias_ink", alias_ink)
    server.register("compare_ink_transforms", compare_tint_transforms)
    server.register("spot_to_process", spot_to_process)
    server.register("ink_settings_defaults", ink_settings_defaults)
    server.register("add_printer_marks", add_printer_marks)
    server.register("remove_printer_marks", remove_printer_marks)
    server.register("list_printer_marks", list_printer_marks)
    server.register("list_hairlines", list_hairlines)
    server.register("fix_hairlines", fix_hairlines)
    server.register("list_transparency", list_transparency)
    server.register("flatten_transparency", flatten_transparency)
    server.register("list_outlines", list_outlines)
    server.register("trap_preset_defaults", trap_preset_defaults)
    server.register("validate_trap_preset", validate_trap_preset)
    server.register("assign_trap_presets", assign_presets)
    server.register("list_trap_presets", list_trap_presets)
    server.register("emit_trapping_setup", emit_trapping_setup)
    server.register("export_postscript", export_postscript)
    server.register("get_struct_tree", get_struct_tree)
    server.register("set_struct_props", set_struct_props)
    server.register("set_table_headers", set_table_headers)
    server.register("tag_page_content", tag_page_content)
    server.register("move_struct_node", move_struct_node)
    server.register("delete_struct_node", delete_struct_node)
    server.register("add_struct_node", add_struct_node)
    server.register("list_links", list_links)
    server.register("set_link_url", set_link_url)
    server.register("delete_link", delete_link)
    server.register("add_links", add_links)
    server.register("export_document", export_document)
    server.register("supported_export_formats", supported_formats)
    server.register("detect_tables", detect_table_regions)
    server.register("export_images", export_images)
    server.register("get_metadata", get_metadata)
    server.register("set_metadata", set_metadata)
    server.register("strip_metadata", strip_metadata)
    server.register("get_pdf_version", get_pdf_version)
    server.register("set_pdf_version", set_pdf_version)
    server.register("get_initial_view", get_initial_view)
    server.register("set_initial_view", set_initial_view)
    server.register("get_advanced_properties", get_advanced_properties)
    server.register("set_advanced_properties", set_advanced_properties)
    server.register("set_document_language", set_document_language)
    server.register("set_document_title", set_document_title)
    server.register("set_page_tab_order", set_page_tab_order)
    server.register("list_document_fonts", list_document_fonts)
    server.register("get_page_count", get_page_count)
    server.register("get_page_info", get_page_info)
    server.register("check_encrypted", check_encrypted)
    server.register("unlock", unlock)
    server.register("repair", repair)
    server.register("rebuild", rebuild)
    server.register("recover", recover)
    server.register("check", check)
    server.register("get_outline", get_outline)
    server.register("set_outline", set_outline)
    server.register("preview_structure_outline", preview_structure_outline)
    server.register("outline_from_structure", outline_from_structure)
    server.register("read_aloud_page", read_aloud_page)
    server.register("find_url_links", find_url_links)
    server.register("create_links_from_urls", create_links_from_urls)
    server.register("list_threads", list_threads)
    server.register("set_threads", set_threads)
    server.register("list_document_js", list_document_js)
    server.register("set_document_js", set_document_js)
    server.register("redact", redact)
    server.register("search_and_redact", search_and_redact)
    server.register("audit_hidden_information", audit_hidden_information)
    server.register("sanitize_pdf", sanitize_pdf)
    server.register("audit_space_usage", audit_space_usage)
    server.register("watermark", watermark)
    server.register("compare_text", compare_text)
    server.register("compare_visual", compare_visual)
    server.register("read_form_fields", read_form_fields)
    server.register("fill_form_fields", fill_form_fields)
    server.register("reset_form_fields", reset_form_fields)
    server.register("export_form_data", export_form_data)
    server.register("import_form_data", import_form_data)
    server.register("set_widget_visibility", set_widget_visibility)
    server.register("detect_form_fields", detect_form_fields)
    server.register("create_detected_fields", create_detected_fields)
    server.register("prepare_form_fields", prepare_form_fields)
    server.register("set_field_lock", set_field_lock)
    server.register("set_field_actions", set_field_actions)
    server.register("set_field_description", set_field_description)
    server.register("apply_ocr_layer", apply_ocr_layer)
    server.register("recognize", recognize)
    server.register("analyze_scan", analyze_scan)
    server.register("enhance_scan", enhance_scan)
    server.register("batch_ocr", batch_ocr)
    server.register("ocr_file", ocr_file)
    server.register("run_action", run_action)
    server.register("autotag", autotag)
    server.register("list_page_images", list_page_images)
    server.register("summarize_image_resolution", summarize_image_resolution)
    server.register("delete_page_image", delete_page_image)
    server.register("replace_page_image", replace_page_image)
    server.register("extract_page_image", extract_page_image)
    server.register("transform_page_image", transform_page_image)
    server.register("transform_page_images", transform_page_images)
    server.register("delete_page_images", delete_page_images)
    server.register("add_page_image", add_page_image)
    server.register("add_page_vector_graphic", add_page_vector_graphic)
    server.register("crop_page_image", crop_page_image)
    server.register("list_page_vectors", list_page_vectors)
    server.register("list_page_geometry", list_page_geometry)
    server.register("delete_page_vector", delete_page_vector)
    server.register("transform_page_vector", transform_page_vector)
    server.register("restyle_page_vector", restyle_page_vector)
    server.register("set_image_opacity", set_image_opacity)
    server.register("list_text_runs", list_text_runs)
    server.register("replace_text_run", replace_text_run)
    server.register("restyle_text_run", restyle_text_run)
    server.register("convert_text_run", convert_text_run)
    server.register("list_text_paragraphs", list_text_paragraphs)
    server.register("replace_paragraph_text", replace_paragraph_text)
    server.register("merge_paragraph_with_previous", merge_paragraph_with_previous)
    server.register("list_dictionaries", list_dictionaries)
    server.register("check_spelling", check_spelling)
    server.register("check_text", check_text)
    server.register("document_language", document_language)
    server.register("spelling_suggestions", spelling_suggestions)
    server.register("add_user_dictionary", add_user_dictionary)
    server.register("distill", distill)
    server.register("create_pdf", create_pdf)
    server.register("list_source_folders", list_source_folders)
    server.register("create_pdf_folders", create_pdf_folders)
    server.register("list_system_fonts", list_system_fonts)
    server.register("add_text_box", add_text_box)
    server.register("measure_text_box", measure_text_box)
    server.register("print", print_pdf)
    server.register("print_preview", print_preview)
    server.register("print_preview_cleanup", print_preview_cleanup)
    server.register("verify_signatures", verify_signatures)
    server.register("sign_pdf", sign_pdf)
    server.register("generate_signer", generate_signer)
    server.register("transplant_incremental", transplant_incremental)
    server.register("signature_policy", signature_policy)
    server.register("save_redaction_marks", save_redaction_marks)
    server.register("list_redact_annotations", list_redact_annotations)

    # Signal readiness on stderr so the Tauri backend knows we're alive
    print("engine: ready", file=sys.stderr, flush=True)

    server.run(input_stream=sys.stdin, output_stream=sys.stdout)


if __name__ == "__main__":
    main()
