import React, { useState, useCallback } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import { dialog } from '../lib/tauri-bridge';

export function EncryptPanel(): React.ReactElement {
  const { activeFile, openNewFiles } = useActiveFile();
  const { call, saveFile } = useEngine();
  // Password vs certificate encryption (F9 both halves). One method per
  // output — the PDF spec allows exactly one security handler per file.
  const [mode, setMode] = useState<'password' | 'certs'>('password');
  const [userPass, setUserPass] = useState('');
  const [ownerPass, setOwnerPass] = useState('');
  // Recipient certificate files (.cer/.crt/.pem/.der) for certificate mode.
  const [recipients, setRecipients] = useState<string[]>([]);
  // Owner permissions (F9). All allowed by default; unchecking restricts.
  const [perms, setPerms] = useState({ print: true, copy: true, modify: true, annotate: true });
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const restricted = !perms.print || !perms.copy || !perms.modify || !perms.annotate;

  const handleEncrypt = useCallback(async () => {
    if (!activeFile) return;
    if (!userPass && !ownerPass) { setStatus('Enter at least one password.'); return; }
    // Permission restrictions are only enforceable behind an OWNER password — a
    // viewer that knows the password to open can otherwise ignore them.
    if (restricted && !ownerPass) {
      setStatus('Set an owner password to enforce permission restrictions.');
      return;
    }
    const output = await saveFile('encrypted.pdf');
    if (!output) return;
    setBusy(true); setStatus('Encrypting...');
    try {
      const r = await call('encrypt', {
        file: activeFile.workingPath, output, user_password: userPass, owner_password: ownerPass,
        ...(restricted ? { permissions: perms } : {}),
      });
      setStatus(
        `Encrypted with ${r.encryption}` +
          (r.has_user_password ? ' (password required to open)' : '') +
          (restricted ? ' — permissions restricted' : ''),
      );
    } catch (e: unknown) { setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setBusy(false); }
  }, [activeFile, userPass, ownerPass, perms, restricted, call, saveFile]);

  const addRecipient = useCallback(async () => {
    const p = await dialog.pickPemFile();
    if (p) setRecipients((r) => (r.includes(p) ? r : [...r, p]));
  }, []);

  const handleEncryptCerts = useCallback(async () => {
    if (!activeFile) return;
    if (recipients.length === 0) { setStatus('Add at least one recipient certificate.'); return; }
    const output = await saveFile('encrypted.pdf');
    if (!output) return;
    setBusy(true); setStatus('Encrypting...');
    try {
      const r = await call('encrypt_pubkey', {
        file: activeFile.workingPath, output, certs: recipients,
        ...(restricted ? { permissions: perms } : {}),
      });
      setStatus(
        `Encrypted to ${r.recipients} recipient certificate${r.recipients === 1 ? '' : 's'}` +
          (restricted ? ' — permissions restricted' : ''),
      );
    } catch (e: unknown) { setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setBusy(false); }
  }, [activeFile, recipients, perms, restricted, call, saveFile]);

  const permRow = (key: keyof typeof perms, label: string) => (
    <label className="flex items-center gap-2 text-sm text-neutral-300 cursor-pointer">
      <input
        data-testid={`encrypt-allow-${key}`}
        type="checkbox"
        checked={perms[key]}
        onChange={(e) => setPerms((p) => ({ ...p, [key]: e.target.checked }))}
        className="rounded bg-neutral-800 border-neutral-700"
      />
      {label}
    </label>
  );

  if (!activeFile) return <NoFileOpen onOpen={openNewFiles} message="Open a PDF to encrypt" />;

  return (
    <div className="flex flex-col gap-4">
      <div className="text-sm text-neutral-400">Working on: <span className="text-neutral-200">{activeFile.name}</span></div>
      <div className="flex gap-4">
        {(
          [
            ['password', 'Password'],
            ['certs', 'Certificates'],
          ] as const
        ).map(([m, label]) => (
          <label key={m} className="flex items-center gap-1.5 text-sm text-neutral-300 cursor-pointer">
            <input
              data-testid={`encrypt-mode-${m}`}
              type="radio"
              checked={mode === m}
              onChange={() => setMode(m)}
              className="bg-neutral-800 border-neutral-700"
            />
            {label}
          </label>
        ))}
      </div>
      {mode === 'password' ? (
        <>
          <div>
            <label className="block text-sm text-neutral-400 mb-1">User password (to open)</label>
            <input type="password" value={userPass} onChange={(e) => setUserPass(e.target.value)} placeholder="Leave empty for no open password"
              className="w-64 px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500" />
          </div>
          <div>
            <label className="block text-sm text-neutral-400 mb-1">Owner password (to edit/print)</label>
            <input type="password" value={ownerPass} onChange={(e) => setOwnerPass(e.target.value)} placeholder="Defaults to user password"
              className="w-64 px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500" />
          </div>
        </>
      ) : (
        <div>
          <label className="block text-sm text-neutral-400 mb-1">Recipient certificates</label>
          <p className="text-xs text-neutral-500 mb-2">
            Anyone holding a listed certificate's private key can open the file — no
            shared password. Accepts .cer, .crt, .pem, and .der certificate files.
          </p>
          {recipients.length > 0 && (
            <ul className="flex flex-col gap-1 mb-2">
              {recipients.map((p) => (
                <li key={p} className="flex items-center gap-2 text-sm text-neutral-300">
                  <span className="truncate" title={p}>{p.split(/[\\/]/).pop()}</span>
                  <button
                    data-testid="encrypt-cert-remove"
                    onClick={() => setRecipients((r) => r.filter((x) => x !== p))}
                    className="text-xs text-neutral-500 hover:text-red-400"
                    title="Remove recipient"
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button
            data-testid="encrypt-cert-add"
            onClick={() => void addRecipient()}
            className="px-3 py-1.5 bg-neutral-700 hover:bg-neutral-600 rounded text-xs font-medium"
          >
            Add certificate…
          </button>
        </div>
      )}
      <div>
        <label className="block text-sm text-neutral-400 mb-2">
          {mode === 'password'
            ? 'Allowed for readers (owner password bypasses these)'
            : 'Allowed for recipients'}
        </label>
        <div className="flex flex-col gap-1.5">
          {permRow('print', 'Printing')}
          {permRow('copy', 'Copying text and graphics')}
          {permRow('modify', 'Changing the document')}
          {permRow('annotate', 'Commenting and filling form fields')}
        </div>
        <p className="text-xs text-neutral-500 mt-1">Accessibility (screen-reader) extraction is always allowed.</p>
      </div>
      <button
        data-testid="encrypt-run"
        onClick={mode === 'password' ? handleEncrypt : handleEncryptCerts}
        disabled={busy}
        className="self-start px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm font-medium"
      >
        {busy ? 'Encrypting...' : 'Encrypt'}
      </button>
      <StatusBar message={status} busy={busy} />
    </div>
  );
}
