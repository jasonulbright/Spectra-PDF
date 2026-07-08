import React, { useState, useEffect } from 'react';
import { getSettings } from '../panels/SettingsPanel';

export type Operation =
  | 'merge'
  | 'split'
  | 'rotate'
  | 'delete'
  | 'compress'
  | 'grayscale'
  | 'optimize'
  | 'pdfa'
  | 'pdf_version'
  | 'encrypt'
  | 'decrypt'
  | 'extract_text'
  | 'outline'
  | 'watermark'
  | 'metadata'
  | 'repair'
  | 'rebuild'
  | 'recover';

interface SidebarProps {
  active: Operation;
  onSelect: (op: Operation) => void;
}

interface OpGroup {
  name: string;
  items: { id: Operation; label: string }[];
}

const groups: OpGroup[] = [
  { name: 'Pages', items: [
    { id: 'merge', label: 'Merge' },
    { id: 'split', label: 'Split' },
    { id: 'rotate', label: 'Rotate' },
    { id: 'delete', label: 'Delete Pages' },
  ]},
  { name: 'Transform', items: [
    { id: 'compress', label: 'Compress' },
    { id: 'grayscale', label: 'Grayscale' },
    { id: 'optimize', label: 'Optimize' },
    { id: 'pdfa', label: 'PDF/A' },
    { id: 'pdf_version', label: 'PDF Version' },
  ]},
  { name: 'Repair', items: [
    { id: 'repair', label: 'Repair' },
    { id: 'rebuild', label: 'Rebuild' },
    { id: 'recover', label: 'Recover' },
  ]},
  { name: 'Security', items: [
    { id: 'encrypt', label: 'Encrypt' },
    { id: 'decrypt', label: 'Decrypt' },
  ]},
  { name: 'Content', items: [
    { id: 'extract_text', label: 'Extract Text' },
    { id: 'outline', label: 'Bookmarks' },
    { id: 'watermark', label: 'Watermark' },
    { id: 'metadata', label: 'Metadata' },
  ]},
];

function getGroupForOp(op: Operation): string {
  for (const g of groups) {
    if (g.items.some((item) => item.id === op)) return g.name;
  }
  return '';
}

export function Sidebar({ active, onSelect }: SidebarProps): React.ReactElement {
  const [expandAll, setExpandAll] = useState(() => getSettings().expandAllTools === true);
  const [expanded, setExpanded] = useState<string>(() => expandAll ? '__all__' : getGroupForOp(active));

  // Poll for setting changes (settings are in localStorage, no event bus)
  useEffect(() => {
    const interval = setInterval(() => {
      const current = getSettings().expandAllTools === true;
      setExpandAll(current);
    }, 500);
    return () => clearInterval(interval);
  }, []);

  // React to expandAll changes and active operation changes
  useEffect(() => {
    if (expandAll) {
      setExpanded('__all__');
    } else {
      setExpanded(getGroupForOp(active));
    }
  }, [active, expandAll]);

  const toggleGroup = (name: string) => {
    if (expandAll) return; // no toggling in expand-all mode
    setExpanded((prev) => prev === name ? '' : name);
  };

  return (
    <nav className="w-48 bg-neutral-850 flex flex-col py-2 shrink-0 overflow-y-auto">
      {groups.map((group) => {
        const isExpanded = expandAll || expanded === group.name;
        const hasActive = group.items.some((item) => item.id === active);
        return (
          <div key={group.name}>
            <button
              onClick={() => toggleGroup(group.name)}
              className={`w-full px-4 py-2 text-left text-[10px] uppercase tracking-widest font-semibold flex items-center justify-between transition-colors ${
                hasActive ? 'text-neutral-300' : 'text-neutral-500 hover:text-neutral-400'
              }`}
            >
              {group.name}
              {!expandAll && <span className="text-[10px]">{isExpanded ? '−' : '+'}</span>}
            </button>
            {isExpanded && group.items.map((op) => (
              <button
                key={op.id}
                onClick={() => onSelect(op.id)}
                className={`w-full px-6 py-1.5 text-left text-sm transition-colors ${
                  active === op.id
                    ? 'bg-neutral-700 text-white'
                    : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800'
                }`}
              >
                {op.label}
              </button>
            ))}
          </div>
        );
      })}
    </nav>
  );
}
