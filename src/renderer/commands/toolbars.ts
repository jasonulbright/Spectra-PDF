// The main toolbar as DATA (19-phase4 § 3.1). A flat list of registered
// command ids (each with its glyph) plus separators; the MainToolbar
// component renders each as an icon button driven by the command
// (title→tooltip, when→disabled). Zoom and Find need the board's canvas
// services, so their commands self-disable off the board (canvas() === null)
// — no toolbar-side view gating needed. The icon rides on the node (not a
// side map) so a new entry can't compile without one (the GLYPHS precedent).
import type { CommandId } from './registry';
import type { ChromeIconId } from '../components/chrome-icons';

export type ToolbarNode =
  | { kind: 'command'; command: CommandId; icon: ChromeIconId }
  | { kind: 'separator' };

const c = (command: CommandId, icon: ChromeIconId): ToolbarNode => ({ kind: 'command', command, icon });
const sep: ToolbarNode = { kind: 'separator' };

export const MAIN_TOOLBAR: ToolbarNode[] = [
  c('file.open', 'open'),
  c('file.save', 'save'),
  sep,
  c('edit.undo', 'undo'),
  c('edit.redo', 'redo'),
  sep,
  // Hand / Select (M6.2): how you hold vs. touch the page — § 3.1's pair.
  c('tools.hand', 'hand'),
  c('tools.select', 'cursor'),
  sep,
  c('view.zoomOut', 'zoomOut'),
  c('view.fit', 'fit'),
  c('view.zoomIn', 'zoomIn'),
  sep,
  c('edit.find', 'find'),
];

/** Registered ids the toolbar references (integrity test). */
export function toolbarCommandIds(): CommandId[] {
  return MAIN_TOOLBAR.filter(
    (n): n is Extract<ToolbarNode, { kind: 'command' }> => n.kind === 'command',
  ).map((n) => n.command);
}
