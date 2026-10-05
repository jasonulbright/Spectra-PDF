import { describe, expect, it } from 'vitest';
import { repairStatus } from '../src/renderer/lib/repair-status';

describe('repairStatus', () => {
  const base = { original_size: 2048, repaired_size: 1024, pages: 3 };

  it('says no damage was found when the rewrite reconstructed nothing', () => {
    const text = repairStatus({ ...base, issues_found: [] });
    expect(text).toContain('No damage found');
    expect(text).not.toContain('Repaired');
  });

  it('reports the repaired issues when there were some', () => {
    const text = repairStatus({ ...base, issues_found: ['xref rebuilt', 'stream length'] });
    expect(text).toContain('Repaired');
    expect(text).toContain('Issues addressed: 2.');
  });
});
