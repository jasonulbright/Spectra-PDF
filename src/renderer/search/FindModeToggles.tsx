import React from 'react';
import type { SearchOptions } from './normalize';

// The three advanced Find modes (P4), in the industry-standard find-bar idiom:
// Aa = match case, `\b` = whole word, `.*` = regular expression. Shared by the
// canvas FindBar and the nav-pane SearchPanel so both surfaces offer identical
// modes and the same look. `testIdPrefix` disambiguates the two mounts.
const MODES: { key: keyof SearchOptions; label: string; title: string; suffix: string }[] = [
  { key: 'caseSensitive', label: 'Aa', title: 'Match case', suffix: 'case' },
  { key: 'wholeWord', label: '\\b', title: 'Whole word', suffix: 'word' },
  { key: 'regex', label: '.*', title: 'Use regular expression', suffix: 'regex' },
];

export function FindModeToggles({
  options,
  onToggle,
  testIdPrefix,
}: {
  options: SearchOptions;
  onToggle: (key: keyof SearchOptions) => void;
  testIdPrefix: string;
}): React.ReactElement {
  return (
    <div className="flex items-center gap-0.5">
      {MODES.map((m) => (
        <button
          key={m.key}
          type="button"
          data-testid={`${testIdPrefix}-${m.suffix}`}
          title={m.title}
          aria-label={m.title}
          aria-pressed={!!options[m.key]}
          onClick={() => onToggle(m.key)}
          className={`px-1.5 py-0.5 text-xs font-mono rounded border ${
            options[m.key]
              ? 'bg-blue-600 text-white border-blue-500'
              : 'bg-neutral-900 text-neutral-400 border-neutral-700 hover:bg-neutral-700'
          }`}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}
