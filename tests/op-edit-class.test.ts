// The operation roster: every in-place op names an edit class.
//
// tsc is the first gate — `performOperation` takes `OpMethod`, so an op added
// without a class does not compile. This is the second: it pins WHICH class
// each op has (a wrong class is a compiling lie), holds the two deliberate
// exemptions to an explicit list, and scans the tree for a call site that
// slipped past by casting.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { OP_EDIT_CLASS, UNGATED_OPS, opEditClass } from '../src/renderer/lib/op-edit-class';
import { signedEditDecision, type SignaturePolicy } from '../src/renderer/lib/signatures';

const VALID = new Set(['none', 'form-fill', 'annotate', 'structural']);

describe('OP_EDIT_CLASS', () => {
  it('gives every op one of the four values', () => {
    for (const [method, cls] of Object.entries(OP_EDIT_CLASS)) {
      expect(VALID.has(cls), `${method} → ${cls}`).toBe(true);
    }
  });

  it('classes the two preservable tiers as themselves, not as structural', () => {
    // The gate exists to be delta-aware. Collapsing these into `structural`
    // would warn about every annotation on a signed document — the edits the
    // incremental append carries losslessly.
    expect(opEditClass('save_redaction_marks')).toBe('annotate');
    expect(opEditClass('set_widget_visibility')).toBe('annotate');
    expect(opEditClass('add_links')).toBe('annotate');
    expect(opEditClass('set_link_target')).toBe('annotate');
    expect(opEditClass('set_link_appearance')).toBe('annotate');
    expect(opEditClass('delete_link')).toBe('annotate');
    expect(opEditClass('reset_form_fields')).toBe('form-fill');
    expect(opEditClass('import_form_data')).toBe('form-fill');
  });

  it('classes field STRUCTURE writes as structural, not as form filling', () => {
    // A /Lock policy and an /AA action set are not values in a field; a
    // form-fill class would let them through a fill-only certification.
    expect(opEditClass('set_field_lock')).toBe('structural');
    expect(opEditClass('set_field_actions')).toBe('structural');
  });

  it('classes the fourteen that reached a signed document unasked', () => {
    for (const method of [
      'watermark',
      'add_header_footer',
      'set_page_labels',
      'set_document_js',
      'flatten_transparency',
      'fix_hairlines',
      'alias_ink',
      'spot_to_process',
      'assign_trap_presets',
      'add_printer_marks',
      'remove_printer_marks',
      'enhance_scan',
      'apply_preflight_fixups',
      'apply_ocr_layer',
    ] as const) {
      expect(opEditClass(method), method).toBe('structural');
    }
  });

  it('classes the panel ops the first migration missed', () => {
    // The stragglers: surfaces that snapshot and rewrite the working copy
    // directly. Each reached a signed document with no question asked because
    // the first sweep enumerated the whole-file TREATMENT panels and these are
    // page-geometry, catalog and object-list surfaces.
    for (const method of [
      'rotate',
      'delete',
      'set_page_boxes',
      'content_crop',
      'set_outline',
      'outline_from_structure',
      'set_threads',
      'add_attachment',
      'remove_attachment',
      'make_portfolio',
      'update_portfolio_member',
      'set_layer_visibility',
      'add_struct_node',
      'delete_struct_node',
      'move_struct_node',
      'autotag',
    ] as const) {
      expect(opEditClass(method), method).toBe('structural');
    }
  });

  it('classes a panel rotate as structural, not as the page tier would', () => {
    // The page TIER routes /Rotate through the commit's transplant, which
    // carries it onto an approval-signed document with no dialog. This panel
    // does not: it calls the engine on the working copy, which rewrites the
    // whole file and breaks every byte range. Same word, different tier —
    // a `page-keys` class here would warn about nothing while the file is
    // rewritten underneath the signature.
    expect(opEditClass('rotate')).toBe('structural');
    expect(opEditClass('delete')).toBe('structural');
  });

  it('classes annotation-only comment ops as annotate', () => {
    // Both move only /Annots. Deleting annotations is annotation MODIFICATION
    // in the certification table's terms — collapsing them into structural
    // would refuse a comment sweep a /P 3 certification permits.
    expect(opEditClass('import_xfdf')).toBe('annotate');
    expect(opEditClass('delete_all_annotations')).toBe('annotate');
    expect(opEditClass('create_links_from_urls')).toBe('annotate');
  });

  it('exempts exactly the two ops that own their own decision', () => {
    const exempt = Object.entries(OP_EDIT_CLASS)
      .filter(([, cls]) => cls === 'none')
      .map(([method]) => method)
      .sort();
    expect(exempt).toEqual([...UNGATED_OPS].sort());
    expect(exempt).toEqual(['sanitize_pdf', 'sign_pdf']);
  });

  it('no classed op resolves to proceed on a no-changes certification', () => {
    // The property the roster buys: whatever class an op carries, a document
    // certified against every change refuses it.
    const certified: SignaturePolicy = {
      signed: true,
      count: 1,
      certified: true,
      level: 'none',
    };
    for (const [method, cls] of Object.entries(OP_EDIT_CLASS)) {
      if (cls === 'none') continue;
      const decision = signedEditDecision(certified, cls);
      expect(decision.kind, method).toBe('refuse');
    }
  });
});

// --- the roster is total over the tree -----------------------------------
//
// tsc already rejects a literal that is not in the roster. This catches the
// other shape: a call site that reaches performOperation through a cast, which
// would compile and gate nothing.

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe('performOperation call sites', () => {
  const files = sourceFiles(join(__dirname, '..', 'src', 'renderer'));

  it('name only operations the roster classes', () => {
    const literal = /performOperation\(\s*[^,)]+,\s*'([a-z0-9_]+)'/g;
    const seen = new Set<string>();
    for (const path of files) {
      const text = readFileSync(path, 'utf8');
      for (const match of text.matchAll(literal)) seen.add(match[1]);
    }
    // The scan must actually find call sites — a regex that matches nothing
    // would pass this test while proving nothing.
    expect(seen.size).toBeGreaterThan(20);
    const unclassed = [...seen].filter((m) => !(m in OP_EDIT_CLASS));
    expect(unclassed).toEqual([]);
  });

  it('reach performOperation with no `as` cast on the method', () => {
    const cast = /performOperation\(\s*[^,)]+,\s*[^,)]*\bas\b[^,)]*,/g;
    const offenders: string[] = [];
    for (const path of files) {
      const text = readFileSync(path, 'utf8');
      if (cast.test(text)) offenders.push(path);
      cast.lastIndex = 0;
    }
    expect(offenders).toEqual([]);
  });
});
