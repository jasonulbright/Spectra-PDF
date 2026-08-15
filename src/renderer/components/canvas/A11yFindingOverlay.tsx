import React from 'react';
import { useTranslation } from 'react-i18next';
import type { NormalizedRect } from '../../lib/table-review';

// One accessibility finding, drawn where the checker found it.
//
// Read-only by construction: a finding is a claim about the page, and every
// edit that answers one is an ordinary op on the panel next to it. There is no
// drag, no handle and no accept toggle, so this carries none of the table
// overlay's gesture machinery — the single gesture is a click that selects,
// which is what tells the panel which row to reveal.
//
// The treatment is deliberately not the table or candidate treatment: those
// describe something the app would WRITE, and this describes something already
// on the page that a reader cannot reach.

interface Props {
  id: string;
  rect: NormalizedRect;
  label: string;
  selected: boolean;
  onSelect: (id: string) => void;
}

export default function A11yFindingOverlay({
  id,
  rect,
  label,
  selected,
  onSelect,
}: Props): React.ReactElement {
  useTranslation();
  return (
    <button
      type="button"
      className={`page-a11y-finding${selected ? ' is-selected' : ''}`}
      data-testid={`a11y-finding-${id}`}
      title={label}
      aria-label={label}
      aria-pressed={selected}
      style={{
        left: `${rect.x * 100}%`,
        top: `${rect.y * 100}%`,
        width: `${rect.w * 100}%`,
        height: `${rect.h * 100}%`,
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(id);
      }}
    >
      <span className="page-a11y-finding-label">{label}</span>
    </button>
  );
}
