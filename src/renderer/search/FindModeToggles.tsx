import React from 'react';
import { useTranslation } from 'react-i18next';
import type { SearchOptions } from './normalize';
import { tChrome } from '../i18n';
import type { UiKey } from '../i18n';

// The three advanced Find modes, in the industry-standard find-bar idiom:
// Aa = match case, a boxed `ab` = whole word, `.*` = regular expression.
// Shared by the canvas FindBar and the nav-pane SearchPanel so both surfaces
// offer identical modes and the same look. `testIdPrefix` disambiguates the
// two mounts. The LABELS are notation, not prose — they stay verbatim in every
// locale, exactly as the industry's find bars draw them; the tooltips that
// explain them localize.
//
// Whole word is `ab`, not `\b`. The other two labels are what a find bar draws;
// `\b` is a regular-expression escape, which made it the ONE label whose
// meaning came from a different notation than the button beside it — and it sat
// next to the `.*` button that actually turns that notation on.
const MODES: { key: keyof SearchOptions; label: string; title: UiKey; suffix: string }[] = [
  { key: 'caseSensitive', label: 'Aa', title: 'nav.find.matchCase', suffix: 'case' },
  { key: 'wholeWord', label: 'ab', title: 'nav.find.wholeWord', suffix: 'word' },
  { key: 'regex', label: '.*', title: 'nav.find.regex', suffix: 'regex' },
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
  // Re-render on language change; strings resolve via tChrome.
  useTranslation();
  return (
    <div className="flex items-center gap-0.5">
      {MODES.map((m) => (
        <button
          key={m.key}
          type="button"
          data-testid={`${testIdPrefix}-${m.suffix}`}
          title={tChrome(m.title)}
          aria-label={tChrome(m.title)}
          aria-pressed={!!options[m.key]}
          onClick={() => onToggle(m.key)}
          className={`px-1.5 py-0.5 text-xs font-mono rounded border ${
            m.key === 'wholeWord' ? 'find-mode-word ' : ''
          }${
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
