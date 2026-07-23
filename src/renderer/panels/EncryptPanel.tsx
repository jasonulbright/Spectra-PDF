import React, { useState, useCallback } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';

export function EncryptPanel(): React.ReactElement {
  const { activeFile, openNewFiles } = useActiveFile();
  const { call, saveFile } = useEngine();
  const [userPass, setUserPass] = useState('');
  const [ownerPass, setOwnerPass] = useState('');
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
      <div>
        <label className="block text-sm text-neutral-400 mb-2">Allowed for readers (owner password bypasses these)</label>
        <div className="flex flex-col gap-1.5">
          {permRow('print', 'Printing')}
          {permRow('copy', 'Copying text and graphics')}
          {permRow('modify', 'Changing the document')}
          {permRow('annotate', 'Commenting and filling form fields')}
        </div>
        <p className="text-xs text-neutral-500 mt-1">Accessibility (screen-reader) extraction is always allowed.</p>
      </div>
      <button onClick={handleEncrypt} disabled={busy} className="self-start px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm font-medium">
        {busy ? 'Encrypting...' : 'Encrypt'}
      </button>
      <StatusBar message={status} busy={busy} />
    </div>
  );
}
