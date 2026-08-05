import React, { useState, useCallback } from 'react';
import { useEngine } from '../hooks/useEngine';
import { useTranslation } from 'react-i18next';
import { dialog } from '../lib/tauri-bridge';
import { tChrome, tDate } from '../i18n';

// The signer source both sign flows (SignaturesPanel invisible form, canvas
// visible-signature popover) share: a PKCS#12 file, a PEM key+cert pair, a
// PKCS#11 hardware token, or a freshly generated self-signed .pfx
// (which becomes the selected .pfx).
// SECURITY: this component never holds the SIGNING password or token PIN —
// only the generator sub-form's own password, which is cleared the moment
// generation finishes (the user then types it again as the signing
// password/PIN; a generated signer is prompted for like any other, never
// cached). For a token the sign form's password field IS the PIN.

export type SignerSource =
  | { mode: 'pfx'; pfxPath: string | null }
  | { mode: 'pem'; keyPath: string | null; certPath: string | null }
  | {
      mode: 'pkcs11';
      modulePath: string | null;
      tokenLabel: string;
      certLabel: string;
      keyLabel: string;
    };

export const EMPTY_SIGNER_SOURCE: SignerSource = { mode: 'pfx', pfxPath: null };

/** Engine params for the chosen source, or null (with a message) when
 * incomplete. */
export function signerSourceParams(
  source: SignerSource,
): { params: Record<string, string>; error?: never } | { params?: never; error: string } {
  if (source.mode === 'pfx') {
    if (!source.pfxPath) return { error: tChrome('dialog.signer.needPfx') };
    return { params: { pfx_path: source.pfxPath } };
  }
  if (source.mode === 'pkcs11') {
    if (!source.modulePath) return { error: tChrome('dialog.signer.needModule') };
    if (!source.tokenLabel.trim()) return { error: tChrome('dialog.signer.needToken') };
    if (!source.certLabel.trim()) return { error: tChrome('dialog.signer.needCertLabel') };
    const params: Record<string, string> = {
      pkcs11_module: source.modulePath,
      pkcs11_token: source.tokenLabel.trim(),
      pkcs11_cert_label: source.certLabel.trim(),
    };
    if (source.keyLabel.trim()) params.pkcs11_key_label = source.keyLabel.trim();
    return { params };
  }
  if (!source.keyPath || !source.certPath)
    return { error: tChrome('dialog.signer.needPem') };
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
  // Re-render on language change; strings resolve via tChrome.
  useTranslation();
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

  const pickModule = useCallback(async () => {
    const p = await dialog.pickPkcs11Module();
    if (p && value.mode === 'pkcs11') onChange({ ...value, modulePath: p });
  }, [onChange, value]);

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
      setGenError(tChrome('dialog.signer.needName'));
      return;
    }
    if (!genPassword) {
      setGenError(tChrome('dialog.signer.needPassword'));
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
    p ? p.split(/[\\/]/).pop()
      : <span className="text-neutral-600">{tChrome('dialog.signer.noneChosen')}</span>;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-xs text-neutral-400 w-20 shrink-0">{tChrome('dialog.signer.label')}</span>
        <div className="flex rounded overflow-hidden border border-neutral-700">
          {(['pfx', 'pem', 'pkcs11'] as const).map((m) => (
            <button
              key={m}
              data-testid={`${idPrefix}-source-${m}`}
              onClick={() =>
                onChange(
                  m === 'pfx'
                    ? { mode: 'pfx', pfxPath: null }
                    : m === 'pem'
                      ? { mode: 'pem', keyPath: null, certPath: null }
                      : { mode: 'pkcs11', modulePath: null, tokenLabel: '', certLabel: '', keyLabel: '' },
                )
              }
              className={`px-2.5 py-1 text-xs font-medium ${
                value.mode === m
                  ? 'bg-neutral-600 text-neutral-100'
                  : 'bg-neutral-800 text-neutral-400 hover:bg-neutral-700'
              }`}
            >
              {tChrome(
                m === 'pfx'
                  ? 'dialog.signer.modePfx'
                  : m === 'pem'
                    ? 'dialog.signer.modePem'
                    : 'dialog.signer.modeToken',
              )}
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
          title={tChrome('dialog.signer.createTitle')}
        >
          {tChrome('dialog.signer.create')}
        </button>
      </div>

      {value.mode === 'pfx' ? (
        <div className="flex items-center gap-2">
          <span className="text-xs text-neutral-400 w-20 shrink-0">{tChrome('dialog.signer.modePfx')}</span>
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
            {tChrome('dialog.signer.choose')}
          </button>
        </div>
      ) : value.mode === 'pkcs11' ? (
        <>
          <div className="flex items-center gap-2">
            <span className="text-xs text-neutral-400 w-20 shrink-0">{tChrome('dialog.signer.module')}</span>
            <span
              className="flex-1 text-xs text-neutral-300 truncate"
              title={value.modulePath ?? undefined}
            >
              {fileName(value.modulePath)}
            </span>
            <button
              data-testid={`${idPrefix}-pick-module`}
              onClick={() => void pickModule()}
              className="px-2.5 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 rounded font-medium"
            >
              {tChrome('dialog.signer.choose')}
            </button>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-neutral-400 w-20 shrink-0">{tChrome('dialog.signer.token')}</span>
            <input
              data-testid={`${idPrefix}-token-label`}
              value={value.tokenLabel}
              onChange={(e) => onChange({ ...value, tokenLabel: e.target.value })}
              placeholder={tChrome('dialog.signer.tokenPlaceholder')}
              className="flex-1 px-2 py-1 text-xs bg-neutral-800 border border-neutral-700 rounded focus:outline-none focus:border-blue-500"
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-neutral-400 w-20 shrink-0">{tChrome('dialog.signer.certLabel')}</span>
            <input
              data-testid={`${idPrefix}-cert-label`}
              value={value.certLabel}
              onChange={(e) => onChange({ ...value, certLabel: e.target.value })}
              placeholder={tChrome('dialog.signer.certPlaceholder')}
              className="flex-1 px-2 py-1 text-xs bg-neutral-800 border border-neutral-700 rounded focus:outline-none focus:border-blue-500"
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-neutral-400 w-20 shrink-0">{tChrome('dialog.signer.keyLabel')}</span>
            <input
              data-testid={`${idPrefix}-key-label`}
              value={value.keyLabel}
              onChange={(e) => onChange({ ...value, keyLabel: e.target.value })}
              placeholder={tChrome('dialog.signer.keyPlaceholder')}
              className="flex-1 px-2 py-1 text-xs bg-neutral-800 border border-neutral-700 rounded focus:outline-none focus:border-blue-500"
            />
          </div>
          <p className="text-[11px] text-neutral-500 -mt-1 ml-[5.5rem]">
            {tChrome('dialog.signer.tokenNote')}
          </p>
        </>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <span className="text-xs text-neutral-400 w-20 shrink-0">{tChrome('dialog.signer.keyFile')}</span>
            <span className="flex-1 text-xs text-neutral-300 truncate" title={value.keyPath ?? undefined}>
              {fileName(value.keyPath)}
            </span>
            <button
              data-testid={`${idPrefix}-pick-key`}
              onClick={() => void pickKey()}
              className="px-2.5 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 rounded font-medium"
            >
              {tChrome('dialog.signer.choose')}
            </button>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-neutral-400 w-20 shrink-0">{tChrome('dialog.signer.certificate')}</span>
            <span className="flex-1 text-xs text-neutral-300 truncate" title={value.certPath ?? undefined}>
              {fileName(value.certPath)}
            </span>
            <button
              data-testid={`${idPrefix}-pick-cert`}
              onClick={() => void pickCert()}
              className="px-2.5 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 rounded font-medium"
            >
              {tChrome('dialog.signer.choose')}
            </button>
          </div>
          <p className="text-[11px] text-neutral-500 -mt-1 ml-[5.5rem]">
            {tChrome('dialog.signer.pemNote')}
          </p>
        </>
      )}

      {showGenerate && (
        <div className="rounded border border-neutral-700 bg-neutral-900/70 p-2.5 flex flex-col gap-2">
          <div className="text-xs text-neutral-300 font-medium">{tChrome('dialog.signer.newTitle')}</div>
          <p className="text-[11px] text-neutral-500 -mt-1">
            {tChrome('dialog.signer.newNote')}
          </p>
          <div className="flex items-center gap-2">
            <span className="text-xs text-neutral-400 w-20 shrink-0">{tChrome('dialog.signer.name')}</span>
            <input
              data-testid={`${idPrefix}-generate-name`}
              type="text"
              value={genName}
              onChange={(e) => setGenName(e.target.value)}
              className="flex-1 px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-xs focus:outline-none focus:border-blue-500"
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-neutral-400 w-20 shrink-0">{tChrome('dialog.signer.organization')}</span>
            <input
              type="text"
              value={genOrg}
              placeholder={tChrome('dialog.signer.optional')}
              onChange={(e) => setGenOrg(e.target.value)}
              className="flex-1 px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-xs focus:outline-none focus:border-blue-500"
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-neutral-400 w-20 shrink-0">{tChrome('dialog.signer.password')}</span>
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
              {tChrome('dialog.common.cancel')}
            </button>
            <button
              data-testid={`${idPrefix}-generate-apply`}
              onClick={() => void handleGenerate()}
              disabled={genBusy}
              className="px-2.5 py-1 text-xs text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded font-medium"
            >
              {tChrome(genBusy ? 'dialog.signer.generating' : 'dialog.signer.generate')}
            </button>
          </div>
        </div>
      )}

      {genDone && (
        <div
          data-testid={`${idPrefix}-generate-done`}
          className="text-[11px] text-green-300/90 bg-green-600/10 border border-green-600/30 rounded px-2 py-1"
        >
          {/* One whole message, not a sentence assembled around a <strong>:
              the clause order differs per language (the Settings precedent). */}
          {tChrome('dialog.signer.created', {
            name: genDone.common_name,
            date: tDate(genDone.not_after),
          })}
        </div>
      )}
    </div>
  );
}
