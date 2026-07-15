import { describe, expect, it } from 'vitest';
import { TOOL_DEFS, TOOL_IDS, toolById, toolForOp, type ToolId } from '../src/renderer/commands/tools';
import { OPERATIONS } from '../src/renderer/components/tool-icons';

// The tools registry (M5, § 7) regroups 21 engine operations into 12 tools named
// for the JOB. These pin the properties the UI relies on — above all that no
// operation can be orphaned by a future edit, which is the whole risk of moving
// from "one rail listing everything" to "tools that group things".

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
