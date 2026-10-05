// A sweep reports the repairs it applied as engine fixup ids; the result row
// shows each one by its localized name, never by its id.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { appliedFixupNames } from '../src/renderer/components/FolderPreflightDialog';
import { PANEL_STRINGS } from '../src/renderer/i18n-panels';

function engineFixupIds(): string[] {
  const src = readFileSync(resolve(__dirname, '../src/engine/preflight_profiles.py'), 'utf8');
  const start = src.indexOf('FIXUP_IDS = (');
  const block = src.slice(start, src.indexOf(')', start));
  return [...block.matchAll(/"([a-z_0-9]+)"/g)].map((m) => m[1]);
}

describe('folder preflight: applied fixups', () => {
  it('has a display name for every fixup id the engine can report', () => {
    const ids = engineFixupIds();
    expect(ids.length).toBeGreaterThan(10);
    expect(ids.filter((id) => !(`panel.preflight.fixup.${id}` in PANEL_STRINGS))).toEqual([]);
  });

  it('names the repairs and joins them with the language list pattern', () => {
    expect(appliedFixupNames(['remove_attachments'], 'en')).toBe('Remove embedded files');
    expect(appliedFixupNames(['remove_attachments', 'fix_hairlines'], 'en')).toBe(
      'Remove embedded files and Thicken hairlines',
    );
  });

  it('renders in the language asked for, with no id left in the text', () => {
    const german = appliedFixupNames(['remove_attachments', 'write_xmp'], 'de');
    expect(german).not.toContain('remove_attachments');
    expect(german).not.toContain('write_xmp');
    expect(german).not.toContain('Remove embedded files');
  });
});
