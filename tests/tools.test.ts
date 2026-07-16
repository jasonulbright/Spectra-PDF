import { describe, expect, it } from 'vitest';
import {
  TOOL_DEFS,
  TOOL_IDS,
  armedModeOf,
  toolById,
  toolForCanvasTool,
  toolForOp,
  showsFormWidgets,
  type ToolId,
} from '../src/renderer/commands/tools';
// Every mode the canvas has, derived from a record tsc forces to be total over
// `CanvasTool` — NOT a hand-listed copy of the union, which is exactly the
// second source of truth that would silently omit a new mode from the
// orphan-ownership check below and quietly pass.
import { CANVAS_MODES } from '../src/renderer/commands/registry';
// The TYPE is still needed (the ownership map below is keyed by it) — what this
// slice removed was the hand-listed copy of its MEMBERS, not the import.
import type { CanvasTool } from '../src/renderer/state/types';
import { OPERATIONS, OPERATION_TITLES } from '../src/renderer/commands/operations';

// The tools registry (M5, § 7) regroups the 19 engine operations into 12 tools
// named for the JOB. These pin the properties the UI relies on — above all that
// no operation can be orphaned by a future edit, which is the whole risk of
// moving from "one rail listing everything" to "tools that group things".

describe('the operation set', () => {
  it('has no duplicate entries', () => {
    // The one property the type system can't see: `Operation` is derived from
    // this array, so a repeated entry collapses in the union while the ARRAY
    // still carries both — every `Record<Operation, …>` stays total and tsc
    // stays quiet, but anything iterating OPERATIONS (the command ids, the
    // totality check below) silently doubles it.
    expect([...new Set(OPERATIONS)]).toEqual([...OPERATIONS]);
  });

  it('titles every operation', () => {
    // Record<Operation, string> makes this total at compile time; this catches
    // the other direction — a title left as an empty string.
    for (const op of OPERATIONS) {
      expect(OPERATION_TITLES[op]?.length, `${op} has no title`).toBeGreaterThan(0);
    }
  });
});

describe('tools registry', () => {
  it('reaches EVERY operation through exactly one tool', () => {
    const seen = new Map<string, ToolId[]>();
    for (const tool of TOOL_DEFS) {
      for (const op of tool.ops) seen.set(op, [...(seen.get(op) ?? []), tool.id]);
    }
    // Nothing orphaned: every op the app has is reachable.
    const missing = OPERATIONS.filter((op) => !seen.has(op));
    expect(missing, `operations reachable through NO tool: ${missing.join(', ')}`).toEqual([]);
    // ...and nothing ambiguous: an op in two tools means two places claim it.
    const dupes = [...seen.entries()].filter(([, tools]) => tools.length > 1);
    expect(dupes.map(([op, t]) => `${op} -> ${t.join('+')}`)).toEqual([]);
  });

  it('lists no operation that does not exist', () => {
    for (const tool of TOOL_DEFS) {
      for (const op of tool.ops) {
        expect(OPERATIONS, `${tool.id} lists unknown op '${op}'`).toContain(op);
      }
    }
  });

  it('has unique ids, and every id resolves', () => {
    expect(new Set(TOOL_IDS).size).toBe(TOOL_IDS.length);
    for (const id of TOOL_IDS) expect(toolById(id)?.id).toBe(id);
    expect(toolById('nope' as ToolId)).toBeUndefined();
  });

  it('gives every tool a title and a description (the tile is unusable without both)', () => {
    for (const tool of TOOL_DEFS) {
      expect(tool.title.trim().length, tool.id).toBeGreaterThan(0);
      expect(tool.description.trim().length, tool.id).toBeGreaterThan(0);
    }
  });

  it('maps an operation back to its owning tool', () => {
    expect(toolForOp('compress')?.id).toBe('optimize');
    expect(toolForOp('encrypt')?.id).toBe('protect');
    expect(toolForOp('rotate')?.id).toBe('organize');
  });

  // A tool with no ops is deliberate (its work is a canvas MODE, not a form) —
  // but then it must arm something, or the tile would do nothing at all.
  it('every tool either hosts operations or owns a canvas mode', () => {
    for (const tool of TOOL_DEFS) {
      const usable = tool.ops.length > 0 || (tool.canvasTools?.length ?? 0) > 0 || tool.id === 'ocr';
      expect(usable, `${tool.id} has neither ops nor a canvas mode`).toBe(true);
    }
  });

  it('every canvas mode is owned by exactly one tool — except select', () => {
    // The property the secondary toolbar rests on: on a document tab, the
    // armed MODE must name the active TOOL, unambiguously. It didn't before
    // this slice — Fill & Sign and Prepare Form both wanted 'forms', because
    // authoring was a boolean riding on the fill mode rather than a mode.
    const owners = new Map<CanvasTool, ToolId[]>();
    for (const tool of TOOL_DEFS) {
      for (const m of tool.canvasTools ?? []) owners.set(m, [...(owners.get(m) ?? []), tool.id]);
    }
    const dupes = [...owners.entries()].filter(([, ts]) => ts.length > 1);
    expect(dupes.map(([m, ts]) => `${m} -> ${ts.join('+')}`)).toEqual([]);

    // 'select' is the ABSENCE of a tool, so nothing may claim it.
    expect(owners.has('select'), "'select' must belong to no tool").toBe(false);
    expect(toolForCanvasTool('select')).toBeUndefined();

    // Every other mode the canvas has resolves to its tool.
    for (const m of CANVAS_MODES) {
      if (m === 'select') continue;
      expect(toolForCanvasTool(m)?.id, `${m} is owned by no tool`).toBeDefined();
    }
  });

  it('opening a tool arms the FIRST mode it owns', () => {
    expect(armedModeOf(toolById('comment')!)).toBe('highlight');
    expect(armedModeOf(toolById('redact')!)).toBe('redact');
    expect(armedModeOf(toolById('prepareform')!)).toBe('formfields');
    // A tool that drives no canvas mode says so, rather than defaulting.
    expect(armedModeOf(toolById('protect')!)).toBeUndefined();
  });

  it('both form modes show widgets — a field is never invisible while form work is armed', () => {
    // PageCell renders a widget only in a FORM mode (FormWidgetView returns
    // null otherwise), so this set is literally "when can you see the fields".
    // It must cover authoring as well as filling, or you place new fields blind
    // over the existing ones — and, worse, the field you just created vanishes
    // the moment the mode changes, against the popup's own promise that it is
    // "fillable right away". Splitting authoring out of `forms` shrank this set
    // by accident; the split must not cost visibility.
    expect(CANVAS_MODES.filter(showsFormWidgets).sort()).toEqual(['formfields', 'forms']);
    // ...and PageCell asks THIS, so the assertion is about the real thing.
    expect(showsFormWidgets('forms')).toBe(true);
    expect(showsFormWidgets('formfields')).toBe(true);
    expect(showsFormWidgets('signature')).toBe(false); // Fill & Sign owns it; widgets stay hidden
    expect(showsFormWidgets('select')).toBe(false);
  });

  it('Fill & Sign and Prepare Form own DIFFERENT modes', () => {
    // The split this slice exists for: filling a form and authoring one are
    // different jobs, so they cannot share one mode — that ambiguity is what
    // made "which tool is armed?" unanswerable.
    expect(toolForCanvasTool('forms')?.id).toBe('fillsign');
    expect(toolForCanvasTool('formfields')?.id).toBe('prepareform');
  });
});
