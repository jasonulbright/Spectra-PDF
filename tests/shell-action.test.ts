// The File Explorer verbs, renderer side: which dialog a selection opens and
// how, the notice for items that did not arrive, the refusal for a backend
// command this build lacks, and how Preferences reads a registration status.
import { describe, expect, it } from 'vitest';
import { tChrome, tChromeCount } from '../src/renderer/i18n';
import {
  APP_NAME,
  contractCall,
  explorerMenuView,
  isCommandMissing,
  shellSeed,
  shellRefusedNotice,
  shellSkippedNotice,
} from '../src/renderer/lib/shell-action';
import type { ShellMenuStatus } from '../src/renderer/lib/tauri-bridge';

describe('shellSeed', () => {
  it('Convert opens Create PDF: one file as one PDF, several as one PDF each', () => {
    expect(shellSeed({ action: 'convert', paths: ['C:/a.png'], skipped: 0 })).toEqual({
      dialog: 'createPdf',
      paths: ['C:/a.png'],
      outputMode: 'single',
    });
    expect(shellSeed({ action: 'convert', paths: ['C:/a.png', 'C:/b.docx'], skipped: 0 })).toMatchObject({
      dialog: 'createPdf',
      outputMode: 'perFile',
    });
  });

  it('Combine opens Combine on a new document', () => {
    expect(shellSeed({ action: 'combine', paths: ['C:/a.pdf', 'C:/b.png'], skipped: 0 })).toEqual({
      dialog: 'combine',
      paths: ['C:/a.pdf', 'C:/b.png'],
      target: 'new',
    });
  });
});

describe('shellRefusedNotice', () => {
  it('names the refusal with the backend reason', () => {
    expect(shellRefusedNotice('the shell handoff is malformed')).toEqual({
      title: tChrome('shell.refusedTitle'),
      message: tChrome('shell.refused', { reason: 'the shell handoff is malformed' }),
    });
  });
});

describe('shellSkippedNotice', () => {
  it('says nothing when every item arrived, and counts the rest', () => {
    expect(shellSkippedNotice({ action: 'convert', paths: ['C:/a.png'], skipped: 0 })).toBeNull();
    expect(shellSkippedNotice({ action: 'combine', paths: [], skipped: 3 })).toEqual({
      title: tChrome('shell.skippedTitle'),
      message: tChromeCount('shell.skipped', 3, { app: APP_NAME }),
    });
  });
});

describe('an absent backend command', () => {
  it('is recognised by the exact IPC refusal and named in the error', async () => {
    const missing = 'Command free_output_path not found';
    expect(isCommandMissing(missing, 'free_output_path')).toBe(true);
    expect(isCommandMissing('Command other not found', 'free_output_path')).toBe(false);
    await expect(contractCall('free_output_path', () => Promise.reject(missing))).rejects.toThrow(
      tChrome('shell.commandMissing', { command: 'free_output_path' }),
    );
    await expect(contractCall('free_output_path', () => Promise.reject(new Error('Access is denied.'))))
      .rejects.toThrow('Access is denied.');
  });
});

describe('explorerMenuView', () => {
  const base: ShellMenuStatus = {
    mechanism: 'sparse',
    registered: true,
    visible: true,
    managed: false,
    container: 'installed',
    otherCopy: false,
    error: null,
  };
  const keys = (status: ShellMenuStatus, changed = false) =>
    explorerMenuView(status, changed).notes.map((n) => n.key);

  it('shows a registered, visible menu as on', () => {
    expect(explorerMenuView(base)).toMatchObject({ checked: true, disabled: false });
    expect(explorerMenuView({ ...base, visible: false }).checked).toBe(false);
    expect(keys(base, true)).toContain('panel.settings.explorerMenu.restart');
  });

  it('locks the control under policy and beside an installed copy', () => {
    expect(explorerMenuView({ ...base, managed: true })).toMatchObject({ checked: false, disabled: true });
    expect(keys({ ...base, managed: true })).toContain('panel.settings.explorerMenu.managed');
    const portable = { ...base, container: 'portable' as const, otherCopy: true, registered: false };
    expect(explorerMenuView(portable).disabled).toBe(true);
    expect(keys(portable)).toContain('panel.settings.explorerMenu.installedCopy');
    expect(keys(portable)).not.toContain('panel.settings.explorerMenu.portableHint');
  });

  it('tells a classic fallback apart from a failure', () => {
    const fellBack = { ...base, mechanism: 'classic' as const, error: '0x80073CFF' };
    expect(keys(fellBack)).toContain('panel.settings.explorerMenu.blocked');
    const failed = { ...base, registered: false, error: 'Access is denied.' };
    expect(explorerMenuView(failed).notes).toContainEqual({
      key: 'panel.settings.explorerMenu.failed',
      vars: { reason: 'Access is denied.' },
    });
    expect(keys(failed, true)).not.toContain('panel.settings.explorerMenu.restart');
  });
});
