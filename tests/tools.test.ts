import { describe, expect, it } from 'vitest';
import { TOOL_DEFS, TOOL_IDS, toolById, toolForOp, type ToolId } from '../src/renderer/commands/tools';
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
  it('every tool either hosts operations or arms a canvas tool', () => {
    for (const tool of TOOL_DEFS) {
      const usable = tool.ops.length > 0 || tool.canvasTool !== undefined || tool.id === 'ocr';
      expect(usable, `${tool.id} has neither ops nor a canvas mode`).toBe(true);
    }
  });
});
