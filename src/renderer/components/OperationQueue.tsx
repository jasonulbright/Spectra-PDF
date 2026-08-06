import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { tChrome } from '../i18n';
import { formatQueueLabel, type QueueLabel } from '../hooks/useOperationQueue';

export interface QueueItem {
  id: string;
  /** What the line SAYS, as data — rendered at the current language on every
   * paint. The operation log renders the same descriptor in English. */
  label: QueueLabel;
  status: 'running' | 'done' | 'error';
  /** Failure text from the engine (slice-D boundary — passed through as the
   * engine wrote it). Empty for running and completed operations, whose
   * wording is the queue's own. */
  message: string;
  startTime: number;
}

interface OperationQueueProps {
  items: QueueItem[];
  onClear: () => void;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function OperationQueue({ items, onClear }: OperationQueueProps): React.ReactElement | null {
  // Re-render on language change; strings resolve via tChrome.
  useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(false);

  // Auto-scroll to bottom when new items arrive or status changes
  useEffect(() => {
    if (scrollRef.current && !collapsed) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [items, collapsed]);

  if (items.length === 0) return null;

  return (
    <div className="border-t border-neutral-800 bg-neutral-850 shrink-0">
      <div
        className="flex items-center justify-between px-4 py-1.5 cursor-pointer select-none"
        onClick={() => setCollapsed((prev) => !prev)}
      >
        <span className="text-[10px] uppercase tracking-widest text-neutral-500 font-semibold">
          {tChrome(
            collapsed ? 'dialog.opqueue.headingCollapsed' : 'dialog.opqueue.heading',
            { count: items.length },
          )}
        </span>
        <button
          onClick={(e) => { e.stopPropagation(); onClear(); }}
          className="text-[10px] text-neutral-500 hover:text-neutral-400"
        >
          {tChrome('dialog.opqueue.clear')}
        </button>
      </div>
      {!collapsed && (
        <div
          ref={scrollRef}
          className="overflow-y-auto px-4 pb-2 flex flex-col gap-1"
          style={{ maxHeight: 88 }}
          tabIndex={0}
          role="region"
          aria-label={tChrome('dialog.opqueue.aria')}
        >
          {items.map((item) => (
            <div key={item.id} className="flex items-center gap-3 text-xs">
              <span className={`status-dot w-1.5 h-1.5 rounded-full shrink-0 ${
                item.status === 'running' ? 'bg-blue-500 animate-pulse' :
                item.status === 'done' ? 'bg-emerald-500' : 'bg-red-500'
              }`} />
              <span className="text-neutral-300">
                {formatTime(item.startTime)} {formatQueueLabel(item.label)}
              </span>
              <span className="text-neutral-500 truncate flex-1">
                {/* Completion is the queue's OWN wording, keyed off the state
                    discriminant rather than off any text the hook wrote —
                    a failure's text belongs to the engine and passes through. */}
                {item.status === 'done' ? tChrome('dialog.opqueue.complete') : item.message}
              </span>
              <span className="text-neutral-500 shrink-0">
                {item.status === 'done'
                  ? tChrome('dialog.opqueue.elapsed', {
                      seconds: ((Date.now() - item.startTime) / 1000).toFixed(1),
                    })
                  : ''}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
