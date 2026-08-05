import React, { useCallback, useEffect, useState } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { invokeCommand } from '../commands/context';
import { useAppModal } from '../hooks/useAppModal';
import { useTranslation } from 'react-i18next';
import { tChrome, tChromeCount, tNumber } from '../i18n';
import { runCommitGate } from '../lib/commit-gate';
import type { PdfBuffer } from '../state/types';

// File ▸ Properties combines metadata, PDF version, and encryption status in a
// single dialog. Metadata changes retain their save-to-a-new-file behavior.

const TABS = ['description', 'security', 'advanced'] as const;
type PropTab = (typeof TABS)[number];

const TAB_KEYS = {
  description: 'dialog.props.tab.description',
  security: 'dialog.props.tab.security',
  advanced: 'dialog.props.tab.advanced',
} as const;

export interface PropertiesDialogProps {
  onClose: () => void;
}

export function PropertiesDialog({ onClose }: PropertiesDialogProps): React.JSX.Element {
  // Re-render on language change; strings resolve via tChrome.
  useTranslation();
  const { activeFile } = useActiveFile();
  const { call, saveFile } = useEngine();
  const [tab, setTab] = useState<PropTab>('description');

  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [subject, setSubject] = useState('');
  const [keywords, setKeywords] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const [version, setVersion] = useState<string | null>(null);
  const [encrypted, setEncrypted] = useState<boolean | null>(null);

  // Keyed on workingPath (stable per path, unlike the activeFile object, which
  // swaps on every buffer update) — the MetadataPanel's own note.
  const workingPath = activeFile?.workingPath ?? null;
  const originalPath = activeFile?.path ?? null;

  useEffect(() => {
    if (!workingPath) return;
    let cancelled = false;
    void (async () => {
      // FLUSH FIRST. Every number in this dialog describes the document's
      // BYTES — metadata and version are read out of the working copy, and
      // pageCount/size come from `files`, which only moves on a real byte op.
      // Pending page-tier edits live in `workspace` and touch none of that, so
      // without this a Properties opened right after deleting a page reports
      // the page as still there, disagreeing with the page counter a few pixels
      // away. This is the commit gate's stated job — "before anything READS or
      // replaces file bytes, so these three reads are
      // INTERNAL_METHODS (individually ungated: a panel reading on mount must
      // not commit) is exactly why the gate has to be asked for here.
      try {
        await runCommitGate();
      } catch (e: unknown) {
        if (!cancelled) setStatus(tChrome('dialog.props.gateFailed', { message: e instanceof Error ? e.message : String(e) }));
        return;
      }
      if (cancelled) return;
      try {
        const r = await call('get_metadata', { file: workingPath });
        if (cancelled) return;
        setTitle(r.title || '');
        setAuthor(r.author || '');
        setSubject(r.subject || '');
        setKeywords(r.keywords || '');
      } catch (e: unknown) {
        if (!cancelled) setStatus(tChrome('panel.common.error', { message: e instanceof Error ? e.message : String(e) }));
      }
      try {
        const v = await call('get_pdf_version', { file: workingPath });
        if (!cancelled) setVersion(v.version);
      } catch {
        if (!cancelled) setVersion(null);
      }
    })();
    return () => { cancelled = true; };
  }, [workingPath, call]);

  useEffect(() => {
    if (!originalPath) return;
    let cancelled = false;
    // The ORIGINAL, not the working copy: opening an encrypted file decrypts the
    // working copy, so asking it would always answer "not protected" — a
    // confident, useless lie. What the user wants to know is whether the file on
    // disk needs a password.
    call('check_encrypted', { file: originalPath })
      .then((r) => { if (!cancelled) setEncrypted(Boolean(r.encrypted)); })
      .catch(() => { if (!cancelled) setEncrypted(null); });
    return () => { cancelled = true; };
  }, [originalPath, call]);

  const handleSave = useCallback(async () => {
    if (!activeFile) return;
    const output = await saveFile('metadata-updated.pdf');
    if (!output) return;
    setBusy(true);
    setStatus(tChrome('dialog.props.savingMetadata'));
    try {
      const r = await call('set_metadata', {
        file: activeFile.workingPath, output, title, author, subject, keywords,
      });
      setStatus(tChrome('dialog.props.updated', { fields: (r.updated_fields as string[]).join(', ') }));
    } catch (e: unknown) {
      setStatus(tChrome('panel.common.error', { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  }, [activeFile, title, author, subject, keywords, call, saveFile]);

  const handleStrip = useCallback(async () => {
    if (!activeFile) return;
    const output = await saveFile('stripped.pdf');
    if (!output) return;
    setBusy(true);
    setStatus(tChrome('dialog.props.strippingMetadata'));
    try {
      await call('strip_metadata', { file: activeFile.workingPath, output });
      setTitle(''); setAuthor(''); setSubject(''); setKeywords('');
      setStatus(tChrome('dialog.props.stripped'));
    } catch (e: unknown) {
      setStatus(tChrome('panel.common.error', { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  }, [activeFile, call, saveFile]);

  // The command's `when` requires a showable document, so this is unreachable —
  // but the dialog reads `activeFile` on every render, and a file can close
  // underneath an open dialog.
  if (!activeFile) {
    return (
      <Shell onClose={onClose}>
        <p className="text-sm text-neutral-400" data-testid="props-no-file">
          {tChrome('dialog.props.noFile')}
        </p>
      </Shell>
    );
  }

  // `id` is the STABLE testid/DOM handle. It used to be derived from the
  // English label (`props-${label.toLowerCase()}`) — a localization
  // landmine: translating the label would silently rename every test hook
  // and make the DOM depend on the UI language.
  const fields: { id: string; label: string; value: string; set: (v: string) => void }[] = [
    { id: 'title', label: tChrome('dialog.props.field.title'), value: title, set: setTitle },
    { id: 'author', label: tChrome('dialog.props.field.author'), value: author, set: setAuthor },
    { id: 'subject', label: tChrome('dialog.props.field.subject'), value: subject, set: setSubject },
    { id: 'keywords', label: tChrome('dialog.props.field.keywords'), value: keywords, set: setKeywords },
  ];

  return (
    <Shell onClose={onClose}>
      <nav className="prefs-nav" aria-label={tChrome('dialog.props.tabsAria')}>
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            data-testid={`props-tab-${t}`}
            aria-pressed={tab === t}
            className={'prefs-cat' + (tab === t ? ' active' : '')}
            onClick={() => setTab(t)}
          >
            {tChrome(TAB_KEYS[t])}
          </button>
        ))}
      </nav>

      <div className="prefs-body flex flex-col gap-4" data-testid={`props-body-${tab}`}>
        {tab === 'description' && (
          <>
            {fields.map((f) => (
              <div key={f.id}>
                <label className="block text-sm text-neutral-400 mb-1">{f.label}</label>
                <input
                  data-testid={`props-${f.id}`}
                  aria-label={f.label}
                  className="w-full px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm"
                  value={f.value}
                  onChange={(e) => f.set(e.target.value)}
                />
              </div>
            ))}
            <div className="flex gap-2">
              <button
                data-testid="props-save"
                disabled={busy}
                onClick={() => void handleSave()}
                className="px-3 py-1.5 text-xs text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded font-medium"
              >
                {tChrome('dialog.props.saveAs')}
              </button>
              <button
                data-testid="props-strip"
                disabled={busy}
                onClick={() => void handleStrip()}
                className="px-3 py-1.5 text-xs bg-neutral-800 text-neutral-300 border border-neutral-700 hover:bg-neutral-700 disabled:opacity-50 rounded font-medium"
              >
                {tChrome('dialog.props.removeAll')}
              </button>
            </div>
          </>
        )}

        {tab === 'security' && (
          <>
            <Row label={tChrome('dialog.props.passwordProtection')}>
              <span data-testid="props-encrypted">
                {encrypted === null
                  ? tChrome('dialog.props.unknown')
                  : encrypted
                    ? tChrome('dialog.props.needsPassword')
                    : tChrome('dialog.props.noProtection')}
              </span>
            </Row>
            <button
              data-testid="props-protect"
              onClick={() => {
                onClose();
                invokeCommand('tools.open.protect');
              }}
              className="self-start px-3 py-1.5 text-xs bg-neutral-800 text-neutral-300 border border-neutral-700 hover:bg-neutral-700 rounded font-medium"
            >
              {tChrome('dialog.props.openProtect')}
            </button>
          </>
        )}

        {tab === 'advanced' && (
          <>
            <Row label={tChrome('dialog.props.pdfVersion')}>
              <span data-testid="props-version">
                {version
                  ? tChrome('dialog.props.versionValue', { version })
                  : tChrome('dialog.props.unknown')}
              </span>
            </Row>
            <Row label={tChrome('dialog.props.pageCount')}>
              <span data-testid="props-pages">{tNumber(activeFile.pageCount)}</span>
            </Row>
            <Row label={tChrome('dialog.props.size')}>
              {/* The working copy's bytes — the document as it currently stands,
                  which is what the rest of this dialog describes too. */}
              <span data-testid="props-size">{formatBytes(byteLengthOf(activeFile.buffer))}</span>
            </Row>
            <Row label={tChrome('dialog.props.location')}>
              <span className="break-all" data-testid="props-path">{activeFile.path}</span>
            </Row>
          </>
        )}

        {status && <p className="text-xs text-neutral-500">{status}</p>}
      </div>
    </Shell>
  );
}

function Shell({ children, onClose }: { children: React.ReactNode; onClose: () => void }): React.JSX.Element {
  // Escape-closes / focus-trap / focus-restore — the shared dialog contract.
  const shellRef = useAppModal(onClose);
  return (
    <div
      data-app-modal
      className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
      onClick={onClose}
    >
      <div
        ref={shellRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={tChrome('dialog.props.title')}
        data-testid="properties-dialog"
        className="bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl w-[640px] max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-neutral-800">
          <h3 className="text-sm font-semibold">{tChrome('dialog.props.title')}</h3>
          <button
            data-testid="props-close"
            onClick={onClose}
            className="text-neutral-500 hover:text-neutral-300 text-sm"
          >
            {tChrome('dialog.common.close')}
          </button>
        </div>
        <div className="p-5 prefs">{children}</div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div>
      <span className="block text-sm text-neutral-400 mb-1">{label}</span>
      <span className="text-sm text-neutral-200">{children}</span>
    </div>
  );
}

/** `PdfBuffer` is one of three shapes (and may be absent while a file loads),
 * so the byte count needs asking properly rather than `.length` — which is
 * undefined on an ArrayBuffer and would have rendered "undefined bytes". */
function byteLengthOf(buffer: PdfBuffer | null): number | null {
  if (!buffer) return null;
  if (Array.isArray(buffer)) return buffer.length;
  return buffer.byteLength;
}

function formatBytes(n: number | null): string {
  // Numbers go through Intl — the decimal separator and the
  // digit grouping are locale properties, never hand-rolled.
  if (n === null) return tChrome('dialog.props.unknown');
  if (n < 1024) return tChromeCount('dialog.props.bytes', n);
  const opts = { minimumFractionDigits: 1, maximumFractionDigits: 1 };
  if (n < 1024 * 1024) return tChrome('dialog.props.kilobytes', { size: tNumber(n / 1024, opts) });
  return tChrome('dialog.props.megabytes', { size: tNumber(n / (1024 * 1024), opts) });
}
