// The main toolbar as DATA (19-phase4 § 3.1). A flat list of registered
// command ids with separators; the MainToolbar component renders each as an
// icon button driven by the command (title→tooltip, when→disabled). Zoom and
// Find need the board's canvas services, so their commands self-disable off
// the board (canvas() === null) — no toolbar-side view gating needed.
import type { CommandId } from './registry';

export type ToolbarNode = { kind: 'command'; command: CommandId } | { kind: 'separator' };

const c = (command: CommandId): ToolbarNode => ({ kind: 'command', command });
const sep: ToolbarNode = { kind: 'separator' };

export const MAIN_TOOLBAR: ToolbarNode[] = [
  c('file.open'),
  c('file.save'),
  sep,
  c('edit.undo'),
  c('edit.redo'),
  sep,
  c('view.zoomOut'),
  c('view.fit'),
  c('view.zoomIn'),
  sep,
  c('edit.find'),
];

/** Registered ids the toolbar references (integrity test). */
export function toolbarCommandIds(): CommandId[] {
  return MAIN_TOOLBAR.filter((n): n is { kind: 'command'; command: CommandId } => n.kind === 'command').map(
    (n) => n.command,
  );
}
