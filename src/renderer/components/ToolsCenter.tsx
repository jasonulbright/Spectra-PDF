import React from 'react';
import { TOOL_DEFS, type ToolId } from '../commands/tools';
import { isCommandEnabled } from '../commands/context';
import { ToolIcon } from './tool-icons';

// The Tools tab's landing surface (Phase 4 M5, § 7): a grid of tiles, one per
// tool, rendered from `commands/tools.ts` — the same data the task panes and the
// menu read, so a tool cannot exist in one and be missing from another.
//
// This replaces the rail's 21-item accordion of engine operations. The rail
// asked "which operation do you want?"; the Tools Center asks "what are you
// trying to do?" — which is the question a user actually arrives with, and the
// one Acrobat's own Tools tab asks.

export interface ToolsCenterProps {
  onOpenTool: (id: ToolId) => void;
}

export function ToolsCenter({ onOpenTool }: ToolsCenterProps): React.JSX.Element {
  return (
    <div className="tools-center" data-testid="tools-center">
      <h2 className="tools-center-heading">Tools</h2>
      <p className="tools-center-sub">Choose what you want to do with your document.</p>
      <div className="tools-grid">
        {TOOL_DEFS.map((tool) => {
          // Grey what can't run, exactly as the menu bar does for the same
          // command. `invokeCommand` silently no-ops on a failed `when`, so an
          // ungated tile is a dead click that looks identical to a live one —
          // and every tool whose work is on the page is disabled with no
          // document open. The menu and the grid invoke the SAME command; they
          // must agree about whether it can run.
          const enabled = isCommandEnabled(`tools.open.${tool.id}`);
          return (
          <button
            key={tool.id}
            type="button"
            data-testid={`tool-tile-${tool.id}`}
            className="tool-tile"
            disabled={!enabled}
            title={enabled ? undefined : 'Open a PDF first'}
            onClick={() => onOpenTool(tool.id)}
          >
            <span className="tool-tile-icon" aria-hidden="true">
              {/* Reuse the established glyph set: a tile borrows the icon of its
                  first operation, so the tool and its panels read as one thing.
                  The mode-only tools (Comment/Redact) name a representative op. */}
              <ToolIcon op={TILE_GLYPH[tool.id]} size={22} />
            </span>
            <span className="tool-tile-title">{tool.title}</span>
            <span className="tool-tile-desc">{tool.description}</span>
          </button>
          );
        })}
      </div>
    </div>
  );
}

// Which glyph fronts each tile. A tool with ops borrows its first op's glyph; a
// canvas-mode tool (no ops) names the op whose glyph best says what it does.
const TILE_GLYPH: Record<ToolId, Parameters<typeof ToolIcon>[0]['op']> = {
  organize: 'rotate',
  comment: 'watermark',
  edit: 'watermark',
  fillsign: 'signatures',
  prepareform: 'forms',
  redact: 'delete',
  ocr: 'extract_text',
  compare: 'compare',
  protect: 'encrypt',
  optimize: 'compress',
  repair: 'repair',
  watermark: 'watermark',
  headerfooter: 'headerfooter',
  pagebox: 'pagebox',
  export: 'extract_text',
};
