// What each in-place engine operation DOES to a document, in the terms a
// certification is written in — the roster `performOperation` consults so the
// signed-document decision is taken ONCE, for every op, instead of being
// copied to a fifteenth call site and forgotten at the sixteenth.
//
// The roster is also the TYPE: `performOperation` takes `OpMethod`, so an
// operation added without a class does not compile. That is the property this
// module exists for — the fourteen ops that reached a signed document with no
// question asked were each an omission nothing could have caught.
//
// Vocabulary. The three classes that mean something to a signature are the
// EditClass triple: `form-fill` and `annotate` are the two the incremental
// append carries losslessly, and `structural` is everything else. Drawn-content
// drift has no fourth name because the certification table has no fourth row
// for it: it is mechanically appendable and is precisely the change the DocMDP
// transform exists to detect, so it lands as a rebuild exactly as a page-tree
// change does. `none` is the fourth value and is not a class at all — it marks
// the ops that must NOT take this decision, each with the reason it must not.
import type { EditClass } from './signatures';

/** An op's class, or `none` for the ops this gate deliberately skips. */
export type OpEditClass = EditClass | 'none';

/**
 * Every in-place operation `performOperation` can run, and what it changes.
 *
 * Ordered by the surface that runs it so a new panel's op lands beside its
 * neighbours. `satisfies` rather than an annotation so `OpMethod` stays the
 * literal union of the keys.
 */
export const OP_EDIT_CLASS = {
  // ── Redaction ─────────────────────────────────────────────────────────
  // Applying rewrites page content, so it is structural however small the
  // band; SAVING marks writes /Redact annotations and removes nothing yet.
  redact: 'structural',
  save_redaction_marks: 'annotate',

  // ── Forms: values and widgets ─────────────────────────────────────────
  reset_form_fields: 'form-fill',
  import_form_data: 'form-fill',
  // A visibility change writes the annotation's own /F bit.
  set_widget_visibility: 'annotate',
  // Both author field STRUCTURE (a /Lock policy, an /AA action set, /CO
  // order), not a value, so neither is form-fill.
  set_field_lock: 'structural',
  set_field_actions: 'structural',

  // ── Links ─────────────────────────────────────────────────────────────
  // /Link annotations: the incremental tier preserves them, and only a
  // certification that forbids commenting has anything to say.
  add_links: 'annotate',
  create_links_from_urls: 'annotate',
  set_link_target: 'annotate',
  set_link_appearance: 'annotate',
  delete_link: 'annotate',

  // ── Comments ──────────────────────────────────────────────────────────
  // Both move only /Annots. Deletion is annotation MODIFICATION in the
  // certification table's terms, not a page-tree change, so it shares the
  // class with the import rather than falling to structural.
  import_xfdf: 'annotate',
  delete_all_annotations: 'annotate',

  // ── Page geometry, run from a panel ───────────────────────────────────
  // The page TIER routes rotate/delete through the commit's transplant and
  // asks `pageEditDecision`. These panels do not: they call the engine on the
  // working copy, which rewrites the whole file, so every byte range breaks
  // and the class is structural whatever the page tier could have carried.
  rotate: 'structural',
  delete: 'structural',
  set_page_boxes: 'structural',
  content_crop: 'structural',

  // ── Navigation structures ─────────────────────────────────────────────
  set_outline: 'structural',
  outline_from_structure: 'structural',
  set_threads: 'structural',

  // ── Embedded files and portfolios ─────────────────────────────────────
  add_attachment: 'structural',
  remove_attachment: 'structural',
  make_portfolio: 'structural',
  update_portfolio_member: 'structural',

  // ── Optional content ──────────────────────────────────────────────────
  set_layer_visibility: 'structural',

  // ── Structure tree ────────────────────────────────────────────────────
  add_struct_node: 'structural',
  delete_struct_node: 'structural',
  move_struct_node: 'structural',
  autotag: 'structural',

  // ── Text and object editing (drawn-content drift) ─────────────────────
  convert_text_run: 'structural',
  replace_text_run: 'structural',
  restyle_text_run: 'structural',
  replace_paragraph_text: 'structural',
  merge_paragraph_with_previous: 'structural',
  add_text_box: 'structural',
  transform_page_vector: 'structural',
  restyle_page_vector: 'structural',
  delete_page_vector: 'structural',
  delete_page_image: 'structural',
  delete_page_images: 'structural',
  transform_page_image: 'structural',
  transform_page_images: 'structural',
  crop_page_image: 'structural',
  set_image_opacity: 'structural',

  // ── Recognition and tagging ───────────────────────────────────────────
  apply_ocr_layer: 'structural',
  apply_accessibility_fixes: 'structural',
  tag_page_content: 'structural',
  set_struct_props: 'structural',
  set_document_language: 'structural',
  set_document_title: 'structural',
  set_field_description: 'structural',

  // ── Document-level catalog writes ─────────────────────────────────────
  set_initial_view: 'structural',
  set_advanced_properties: 'structural',
  set_document_js: 'structural',
  set_page_labels: 'structural',

  // ── Prepress and print production ─────────────────────────────────────
  flatten_transparency: 'structural',
  fix_hairlines: 'structural',
  alias_ink: 'structural',
  spot_to_process: 'structural',
  assign_trap_presets: 'structural',
  add_printer_marks: 'structural',
  remove_printer_marks: 'structural',
  apply_preflight_fixups: 'structural',
  enhance_scan: 'structural',

  // ── Stamping ──────────────────────────────────────────────────────────
  watermark: 'structural',
  add_header_footer: 'structural',

  // ── The deliberate exemptions ─────────────────────────────────────────
  // Signing APPENDS a revision: it is the one edit that adds a signature
  // rather than endangering one, and asking whether the user accepts
  // breaking the signatures would refuse the act the surface exists for.
  sign_pdf: 'none',
  // Sanitize keeps its own confirm: collapsing prior revisions is its point,
  // so its dialog names the signature COUNT the report measured. A second
  // dialog from this gate would ask the same question in weaker words.
  sanitize_pdf: 'none',
} as const satisfies Record<string, OpEditClass>;

/** The finite set of operations the in-place flow can run. */
export type OpMethod = keyof typeof OP_EDIT_CLASS;

/** The ops that take no signed-document decision here, and are therefore the
 * ops whose surface owes one. Exported so the roster test asserts the
 * exemption list rather than counting on a reader to notice a `none`. */
export const UNGATED_OPS: readonly OpMethod[] = ['sign_pdf', 'sanitize_pdf'];

export function opEditClass(method: OpMethod): OpEditClass {
  return OP_EDIT_CLASS[method];
}
