import React, { useState, useCallback } from 'react';
import { useEngine } from '../hooks/useEngine';
import { dialog } from '../lib/tauri-bridge';

// The signer source both sign flows (SignaturesPanel invisible form, canvas
// visible-signature popover) share: a PKCS#12 file, a PEM key+cert pair, or a
// freshly generated self-signed .pfx (which becomes the selected .pfx).
// SECURITY: this component never holds the SIGNING password — only the
// generator sub-form's own password, which is cleared the moment generation
// finishes (the user then types it again as the signing password; a generated
// signer is prompted for like any other, never cached).

export type SignerSource =
  | { mode: 'pfx'; pfxPath: string | null }
  | { mode: 'pem'; keyPath: string | null; certPath: string | null };

export const EMPTY_SIGNER_SOURCE: SignerSource = { mode: 'pfx', pfxPath: null };

/** Engine params for the chosen source, or null (with a message) when
 * incomplete. */
export function signerSourceParams(
  source: SignerSource,
): { params: Record<string, string>; error?: never } | { params?: never; error: string } {
  if (source.mode === 'pfx') {
    if (!source.pfxPath) return { error: 'Choose a signer (.pfx) file first.' };
    return { params: { pfx_path: source.pfxPath } };
  }
  if (!source.keyPath || !source.certPath)
    return { error: 'Choose both the PEM key file and the certificate file.' };
  return { params: { key_path: source.keyPath, cert_path: source.certPath } };
}

interface GenerateResult {
  output: string;
  common_name: string;
  not_after: string;
  fingerprint_sha256: string;
}

export function SignerSourceFields({
  value,
  onChange,
  idPrefix,
}: {
  value: SignerSource;
  onChange: (next: SignerSource) => void;
  /** Distinguishes testids when two forms exist (panel vs canvas). */
  idPrefix: string;
}): React.ReactElement {
  const { call } = useEngine();
  const [showGenerate, setShowGenerate] = useState(false);
  const [genName, setGenName] = useState('');
  const [genOrg, setGenOrg] = useState('');
  const [genPassword, setGenPassword] = useState('');
  const [genBusy, setGenBusy] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [genDone, setGenDone] = useState<GenerateResult | null>(null);

  const pickPfx = useCallback(async () => {
    const p = await dialog.pickCertificate();
    if (p) onChange({ mode: 'pfx', pfxPath: p });
  }, [onChange]);

  const pickKey = useCallback(async () => {
    const p = await dialog.pickPemFile();
    if (p) onChange({ mode: 'pem', keyPath: p, certPath: value.mode === 'pem' ? value.certPath : null });
  }, [onChange, value]);

  const pickCert = useCallback(async () => {
    const p = await dialog.pickPemFile();
    if (p) onChange({ mode: 'pem', keyPath: value.mode === 'pem' ? value.keyPath : null, certPath: p });
  }, [onChange, value]);

  const handleGenerate = useCallback(async () => {
    const cn = genName.trim();
    if (!cn) {
      setGenError('Enter a signer name.');
      return;
    }
    if (!genPassword) {
      setGenError('Choose a password — the file will contain a private key.');
      return;
    }
    const dest = await dialog.saveFile({ defaultPath: `${cn.replace(/[\\/:*?"<>|]+/g, '_')}.pfx` });
    if (!dest) return; // cancelled
    setGenBusy(true);
    setGenError(null);
    try {
      // The save dialog above already confirmed any overwrite with the user,
      // so overwrite: true here does not bypass a confirmation.
      const res = (await call('generate_signer', {
        common_name: cn,
        output: dest,
        password: genPassword,
        ...(genOrg.trim() ? { org: genOrg.trim() } : {}),
        overwrite: true,
      })) as unknown as GenerateResult;
      setGenDone(res);
      setShowGenerate(false);
      onChange({ mode: 'pfx', pfxPath: res.output });
    } catch (e: unknown) {
      setGenError(e instanceof Error ? e.message : String(e));
    } finally {
      // Clear the generation password from state regardless of outcome.
      setGenPassword('');
      setGenBusy(false);
    }
  }, [genName, genOrg, genPassword, call, onChange]);

  const fileName = (p: string | null): React.ReactNode =>
    p ? p.split(/[\\/]/).pop() : <span className="text-neutral-600">none chosen</span>;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-xs text-neutral-400 w-20 shrink-0">Signer</span>
        <div className="flex rounded overflow-hidden border border-neutral-700">
          {(['pfx', 'pem'] as const).map((m) => (
            <button
              key={m}
              data-testid={`${idPrefix}-source-${m}`}
              onClick={() =>
                onChange(m === 'pfx' ? { mode: 'pfx', pfxPath: null } : { mode: 'pem', keyPath: null, certPath: null })
              }
              className={`px-2.5 py-1 text-xs font-medium ${
                value.mode === m
                  ? 'bg-neutral-600 text-neutral-100'
                  : 'bg-neutral-800 text-neutral-400 hover:bg-neutral-700'
              }`}
            >
              {m === 'pfx' ? '.pfx file' : 'PEM key + cert'}
            </button>
          ))}
        </div>
        <button
          data-testid={`${idPrefix}-generate-open`}
          onClick={() => {
            setShowGenerate((v) => !v);
            setGenError(null);
          }}
          className="px-2.5 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 rounded font-medium"
          title="Create a new self-signed signing identity (.pfx)"
        >
          Create new…
        </button>
      </div>

      {value.mode === 'pfx' ? (
        <div className="flex items-center gap-2">
          <span className="text-xs text-neutral-400 w-20 shrink-0">.pfx file</span>
          <span
            data-testid={`${idPrefix}-pfx-path`}
            className="flex-1 text-xs text-neutral-300 truncate"
            title={value.pfxPath ?? undefined}
          >
            {fileName(value.pfxPath)}
          </span>
          <button
            data-testid={`${idPrefix}-pick-pfx`}
            onClick={() => void pickPfx()}
            className="px-2.5 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 rounded font-medium"
          >
            Choose…
          </button>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <span className="text-xs text-neutral-400 w-20 shrink-0">Key file</span>
            <span className="flex-1 text-xs text-neutral-300 truncate" title={value.keyPath ?? undefined}>
              {fileName(value.keyPath)}
            </span>
            <button
              data-testid={`${idPrefix}-pick-key`}
              onClick={() => void pickKey()}
              className="px-2.5 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 rounded font-medium"
            >
              Choose…
            </button>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-neutral-400 w-20 shrink-0">Certificate</span>
            <span className="flex-1 text-xs text-neutral-300 truncate" title={value.certPath ?? undefined}>
              {fileName(value.certPath)}
            </span>
            <button
              data-testid={`${idPrefix}-pick-cert`}
              onClick={() => void pickCert()}
              className="px-2.5 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 rounded font-medium"
            >
              Choose…
            </button>
          </div>
          <p className="text-[11px] text-neutral-500 -mt-1 ml-[5.5rem]">
            The certificate file may be a fullchain (signer first).
          </p>
        </>
      )}

      {showGenerate && (
        <div className="rounded border border-neutral-700 bg-neutral-900/70 p-2.5 flex flex-col gap-2">
          <div className="text-xs text-neutral-300 font-medium">New self-signed signer</div>
          <p className="text-[11px] text-neutral-500 -mt-1">
            Proves possession of this new key — it does not prove your identity to third parties.
          </p>
          <div className="flex items-center gap-2">
            <span className="text-xs text-neutral-400 w-20 shrink-0">Name</span>
            <input
              data-testid={`${idPrefix}-generate-name`}
              type="text"
              value={genName}
              onChange={(e) => setGenName(e.target.value)}
              className="flex-1 px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-xs focus:outline-none focus:border-blue-500"
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-neutral-400 w-20 shrink-0">Organization</span>
            <input
              type="text"
              value={genOrg}
              placeholder="optional"
              onChange={(e) => setGenOrg(e.target.value)}
              className="flex-1 px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-xs focus:outline-none focus:border-blue-500"
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-neutral-400 w-20 shrink-0">Password</span>
            <input
              data-testid={`${idPrefix}-generate-password`}
              type="password"
              value={genPassword}
              onChange={(e) => setGenPassword(e.target.value)}
              className="flex-1 px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-xs focus:outline-none focus:border-blue-500"
            />
          </div>
          {genError && <div className="text-xs text-red-400">{genError}</div>}
          <div className="flex justify-end gap-2">
            <button
              onClick={() => {
                setShowGenerate(false);
                setGenPassword('');
                setGenError(null);
              }}
              className="px-2.5 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 rounded font-medium"
            >
              Cancel
            </button>
            <button
              data-testid={`${idPrefix}-generate-apply`}
              onClick={() => void handleGenerate()}
              disabled={genBusy}
              className="px-2.5 py-1 text-xs text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded font-medium"
            >
              {genBusy ? 'Generating…' : 'Generate & Save…'}
            </button>
          </div>
        </div>
      )}

      {genDone && (
        <div
          data-testid={`${idPrefix}-generate-done`}
          className="text-[11px] text-green-300/90 bg-green-600/10 border border-green-600/30 rounded px-2 py-1"
        >
          Created <strong>{genDone.common_name}</strong> (valid until{' '}
          {genDone.not_after.slice(0, 10)}) and selected it. Enter its password to sign.
        </div>
      )}
    </div>
  );
}
