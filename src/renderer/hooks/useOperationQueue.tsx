import React, { createContext, useContext, useCallback, useState, useRef } from 'react';
import type { QueueItem } from '../components/OperationQueue';
import { app } from '../lib/tauri-bridge';

interface QueueContextValue {
  items: QueueItem[];
  /** Track an async operation in the queue. Returns a promise that resolves when the operation completes. */
  track: (label: string, operation: () => Promise<unknown>) => Promise<unknown>;
  clear: () => void;
}

const QueueContext = createContext<QueueContextValue | null>(null);

const FRIENDLY_NAMES: Record<string, string> = {
  merge: 'Merge',
  split: 'Split',
  rotate: 'Rotate',
  delete: 'Delete Pages',
  compress: 'Compress',
  convert_pdfa: 'PDF/A',
  encrypt: 'Encrypt',
  decrypt: 'Decrypt',
  extract_text: 'Extract Text',
  set_metadata: 'Update Metadata',
  set_outline: 'Save Bookmarks',
  unlock: 'Unlock',
  redact: 'Redact',
  watermark: 'Watermark',
  compare_text: 'Compare',
  compare_visual: 'Compare (visual)',
  apply_ocr_layer: 'Apply OCR Text',
  verify_signatures: 'Verify Signatures',
  // NB: the default getFriendlyName path uses only params.file — the signing
  // password is never referenced, so it can't reach the operation log.
  sign_pdf: 'Sign',
  // Same property: no param besides the (non-secret) name ever reaches the
  // queue label; the .pfx password stays out of every sink.
  generate_signer: 'Create Signer',
};

/** Methods that are internal lookups, not user-facing operations. */
const INTERNAL_METHODS = new Set([
  'get_page_count',
  'get_page_info',
  'check_encrypted',
  'get_metadata',
  'get_outline',
]);

export function isTrackableMethod(method: string): boolean {
  return !INTERNAL_METHODS.has(method);
}

function formatPages(pages: unknown): string {
  if (Array.isArray(pages)) return pages.length === 1 ? `p${pages[0]}` : `p${pages.join(',')}`;
  if (typeof pages === 'string' && pages) return `p${pages}`;
  return 'all';
}

function fileName(path: unknown): string {
  if (typeof path !== 'string') return '';
  return path.split(/[\\/]/).pop() || '';
}

export function getFriendlyName(method: string, params: Record<string, unknown> = {}): string {
  const base = FRIENDLY_NAMES[method] || method;
  const file = fileName(params.file);

  switch (method) {
    case 'rotate': {
      const angle = Number(params.angle);
      const dir = angle === 90 ? 'CW' : angle === 270 ? 'CCW' : `${angle}°`;
      return `${base} ${dir} ${formatPages(params.pages)} — ${file}`;
    }
    case 'delete':
      return `${base} ${formatPages(params.pages)} — ${file}`;
    case 'split':
      return `${base} ${params.ranges || 'all'} — ${file}`;
    case 'extract_text':
      return `${base} ${formatPages(params.pages)} — ${file}`;
    case 'compress':
      return `${base} (${params.quality || 'ebook'}) — ${file}`;
    case 'convert_pdfa':
      return `${base} ${params.level || '2b'} — ${file}`;
    case 'encrypt':
    case 'decrypt':
    case 'set_metadata':
    case 'unlock':
      return `${base} — ${file}`;
    case 'merge':
      return `${base} (${Array.isArray(params.files) ? params.files.length : '?'} files)`;
    case 'redact': {
      const n = Array.isArray(params.regions) ? params.regions.length : 0;
      return `${base} ${n} region${n === 1 ? '' : 's'} — ${file}`;
    }
    case 'compare_text':
      return `${base}: ${fileName(params.file_a)} ↔ ${fileName(params.file_b)}`;
    default:
      return file ? `${base} — ${file}` : base;
  }
}

export function QueueProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [items, setItems] = useState<QueueItem[]>([]);
  const idCounter = useRef(0);

  const track = useCallback((label: string, operation: () => Promise<unknown>) => {
    const id = String(++idCounter.current);
    const startTime = Date.now();
    setItems((prev) => [...prev, { id, label, status: 'running', message: '', startTime }]);

    const logLine = (status: string, detail: string) => {
      const ts = new Date(startTime).toISOString();
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      app.appendOperationLog(`${ts} [${status}] ${label} — ${detail} (${elapsed}s)`).catch(() => {});
    };

    return operation().then(
      (result) => {
        setItems((prev) => prev.map((item) =>
          item.id === id ? { ...item, status: 'done' as const, message: 'Complete' } : item
        ));
        logLine('OK', 'Complete');
        return result;
      },
      (err) => {
        const message = err instanceof Error ? err.message : String(err);
        setItems((prev) => prev.map((item) =>
          item.id === id ? { ...item, status: 'error' as const, message } : item
        ));
        logLine('ERROR', message);
        throw err;
      },
    );
  }, []);

  const clear = useCallback(() => setItems([]), []);

  return (
    <QueueContext.Provider value={{ items, track, clear }}>
      {children}
    </QueueContext.Provider>
  );
}

export function useOperationQueue(): QueueContextValue {
  const ctx = useContext(QueueContext);
  if (!ctx) throw new Error('useOperationQueue must be used within QueueProvider');
  return ctx;
}
