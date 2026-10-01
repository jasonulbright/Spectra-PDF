// The renderer half of the File Explorer context-menu commands.
//
// A verb's selection arrives as `PendingOpen.create`. It opens Create PDF or
// Combine with the selection listed and adjustable before anything is
// written; nothing here reads, opens or converts a file. Pure functions, so
// the routing and the Preferences reading of the registration status are
// testable without a DOM.

import type { ShellCreate, ShellMenuStatus } from './tauri-bridge';
import type { OutputMode } from './create-pdf';
import type { CombineTarget } from './combine';
import { tChrome, tChromeCount, type UiKey } from '../i18n';

/** The product name the verb strings carry as `{{app}}`. */
export const APP_NAME = 'Spectra PDF';

export type ShellSeed =
  | { dialog: 'createPdf'; paths: string[]; outputMode: OutputMode }
  | { dialog: 'combine'; paths: string[]; target: CombineTarget };

/**
 * Which dialog a verb opens, seeded how. Convert on two or more files starts
 * in one-PDF-per-file mode; Combine always starts on a new document, because
 * the selection is the document being made.
 */
export function shellSeed(create: ShellCreate): ShellSeed {
  const paths = [...create.paths];
  if (create.action === 'combine') return { dialog: 'combine', paths, target: 'new' };
  return { dialog: 'createPdf', paths, outputMode: paths.length > 1 ? 'perFile' : 'single' };
}

/** The notice for selected items that did not arrive, or null when all did. */
export function shellSkippedNotice(create: ShellCreate): { title: string; message: string } | null {
  if (!(create.skipped > 0)) return null;
  return {
    title: tChrome('shell.skippedTitle'),
    message: tChromeCount('shell.skipped', create.skipped, { app: APP_NAME }),
  };
}

/** The notice for a File Explorer selection the backend could not read. */
export function shellRefusedNotice(reason: string): { title: string; message: string } {
  return { title: tChrome('shell.refusedTitle'), message: tChrome('shell.refused', { reason }) };
}

/** Tauri's rejection for a command this backend build does not register. */
export function isCommandMissing(err: unknown, command: string): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return text === `Command ${command} not found`;
}

/** What to show for a failed contract call: the named refusal when the
 * command is absent, else the backend's own text. */
export function contractFailureMessage(err: unknown, command: string): string {
  if (isCommandMissing(err, command)) return tChrome('shell.commandMissing', { command });
  return err instanceof Error ? err.message : String(err);
}

/** Run a contract call; an absent command rejects with the named refusal. */
export async function contractCall<T>(command: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    throw new Error(contractFailureMessage(err, command), { cause: err });
  }
}

export interface ExplorerMenuView {
  checked: boolean;
  disabled: boolean;
  /** Explanations under the checkbox, in display order. */
  notes: { key: UiKey; vars?: Record<string, string> }[];
}

/** How Preferences presents one registration status. */
export function explorerMenuView(status: ShellMenuStatus, changed = false): ExplorerMenuView {
  const notes: ExplorerMenuView['notes'] = [{ key: 'panel.settings.explorerMenu.hint' }];
  if (status.container === 'portable' && !status.otherCopy) {
    notes.push({ key: 'panel.settings.explorerMenu.portableHint' });
  }
  if (status.managed) notes.push({ key: 'panel.settings.explorerMenu.managed' });
  if (status.otherCopy) notes.push({ key: 'panel.settings.explorerMenu.installedCopy' });
  if (status.error !== null) {
    if (status.registered && status.mechanism === 'classic') {
      notes.push({ key: 'panel.settings.explorerMenu.blocked' });
    } else if (!status.registered) {
      notes.push({ key: 'panel.settings.explorerMenu.failed', vars: { reason: status.error } });
    }
  }
  if (changed && status.mechanism === 'sparse' && status.error === null) {
    notes.push({ key: 'panel.settings.explorerMenu.restart' });
  }
  return {
    checked: status.registered && status.visible && !status.managed,
    disabled: status.managed || status.otherCopy || status.mechanism === 'none',
    notes,
  };
}
