import React from 'react';
import { TOOL_DEFS, type ToolId } from '../commands/tools';
import { isCommandEnabled } from '../commands/context';
import { ToolIcon } from './tool-icons';
import { useTranslation } from 'react-i18next';
import { tChrome, tToolDescription, tToolTitle } from '../i18n';

// The Tools tab's landing surface: a grid of tiles, one per
// tool, rendered from `commands/tools.ts` — the same data the task panes and the
// menu read, so a tool cannot exist in one and be missing from another.
//
// This replaces the rail's 21-item accordion of engine operations. The rail
// asked "which operation do you want?"; the Tools Center asks "what are you
// trying to do?" — the question a user actually arrives with.

export interface ToolsCenterProps {
  onOpenTool: (id: ToolId) => void;
  /** Rendered inside a host that provides its own section heading (Home's
   * "All tools" head, the dock's header) — suppress the standalone one. */
  embedded?: boolean;
}

export function ToolsCenter({ onOpenTool, embedded }: ToolsCenterProps): React.JSX.Element {
  // Re-render on language change; strings resolve via tChrome/tTool*.
  useTranslation();
  return (
    <div
      className={'tools-center' + (embedded ? ' tools-center-embedded' : '')}
      data-testid="tools-center"
    >
      {!embedded && <h2 className="tools-center-heading">{tChrome('tools.heading')}</h2>}
      {!embedded && <p className="tools-center-sub">{tChrome('tools.sub')}</p>}
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
            // The description is the TOOLTIP now, not a visible line: the
            // NAME is what a user scans for, and it used to be the smallest
            // text in a tile the description dominated. The disabled reason
            // still wins the attribute — "why can't I click this" beats "what
            // does this do" when the answer is that it can't run yet.
            title={enabled ? tToolDescription(tool.id, tool.description) : tChrome('tools.openFirst')}
            onClick={() => onOpenTool(tool.id)}
          >
            <span className="tool-tile-icon" aria-hidden="true">
              {/* Reuse the established glyph set: a tile borrows the icon of its
                  first operation, so the tool and its panels read as one thing.
                  The mode-only tools (Comment/Redact) name a representative op. */}
              <ToolIcon op={TILE_GLYPH[tool.id]} size={15} />
            </span>
            <span className="tool-tile-title">{tToolTitle(tool.id, tool.title)}</span>
          </button>
          );
        })}
      </div>
    </div>
  );
}

// Which glyph fronts each tile. A tool with ops borrows its first op's glyph; a
// canvas-mode tool (no ops) names the op whose glyph best says what it does.
// Exported so the omnisearch shows a tool with the SAME glyph as its
// tile — two surfaces naming one tool must not draw it differently.
export const TILE_GLYPH: Record<ToolId, Parameters<typeof ToolIcon>[0]['op']> = {
  organize: 'rotate',
  comment: 'comments',
  edit: 'watermark',
  fillsign: 'signatures',
  prepareform: 'forms',
  redact: 'delete',
  measure: 'measure',
  takeoff: 'takeoff',
  actions: 'actions',
  ocr: 'extract_text',
  compare: 'compare',
  protect: 'encrypt',
  optimize: 'compress',
  repair: 'repair',
  watermark: 'watermark',
  headerfooter: 'headerfooter',
  pagebox: 'pagebox',
  pagelabels: 'pagelabels',
  attachments: 'attachments',
  portfolio: 'portfolio',
  layers: 'layers',
  accessibility: 'accessibility',
  printproduction: 'preflight',
  links: 'links',
  export: 'extract_text',
};
