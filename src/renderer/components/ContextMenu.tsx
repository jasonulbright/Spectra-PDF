import React, { useEffect, useRef } from 'react';
import { pushEscapeInterceptor } from '../commands/context';

export interface MenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  // An open menu owns Escape (the keymap dispatcher's interceptor stack —
  // Phase 4 M1; formerly this component's own document keydown listener).
  useEffect(() => {
    return pushEscapeInterceptor(() => {
      onClose();
      return true;
    });
  }, [onClose]);

  return (
    <div
      ref={ref}
      data-testid="context-menu"
      className="fixed bg-neutral-800 border border-neutral-700 rounded shadow-xl py-1 z-50 min-w-[160px]"
      style={{ left: x, top: y }}
    >
      {items.map((item, i) =>
        item.separator ? (
          <div key={i} className="border-t border-neutral-700 my-1" />
        ) : (
          <button
            key={i}
            onClick={() => { item.onClick(); onClose(); }}
            disabled={item.disabled}
            className={`w-full text-left px-3 py-1.5 text-sm transition-colors disabled:opacity-30
              ${item.danger ? 'text-red-400 hover:bg-red-900/40' : 'text-neutral-200 hover:bg-neutral-700'}`}
          >
            {item.label}
          </button>
        )
      )}
    </div>
  );
}
