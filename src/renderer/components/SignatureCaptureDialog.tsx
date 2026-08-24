import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslation } from 'react-i18next';
import { tChrome } from '../i18n';
import { dialog, file } from '../lib/tauri-bridge';
import {
  loadSignatureAssets,
  normalizeStrokes,
  persistSignatureAssets,
  placeStrokes,
  smoothStrokes,
  type SignatureAsset,
  type SignatureRole,
} from '../lib/signature-assets';
import {
  DEFAULT_SIGNATURE_FACE,
  SIGNATURE_FACES,
  ensureSignatureFaceLoaded,
  signatureCssFamily,
  type SignatureFaceId,
} from '../lib/signature-fonts';
import {
  DEFAULT_BACKGROUND_THRESHOLD,
  removeBackground,
  visibleBounds,
} from '../lib/signature-image';

// The personal-signature capture dialog: three doors onto one store.
//
// DRAW uses WINDOW-LEVEL native pointer listeners, not React's synthetic
// handlers with setPointerCapture — the canvas-drag invariant, which exists
// because synthetic pointermove via setPointerCapture does not deliver in this
// WebView. The same shape every canvas drag uses: a pointerdown that adds
// move/up/cancel/blur listeners on `window` and removes all four in one
// `finish`.
//
// The stroke points captured here are RAW. Smoothing is applied when a stroke
// is DRAWN (preview and placement alike) and never on the way into the store,
// so a saved signature can always be re-rendered at another density.
//
// Nothing in this dialog touches a document. It writes localStorage and
// arms a placement; the mark reaches a page only when the user clicks one.

/** Preview and capture surface size, in CSS pixels. The stored asset is
 * resolution-independent (unit-box strokes, or an image, or text), so this is
 * a comfort choice rather than a fidelity one. */
const CANVAS_W = 520;
const CANVAS_H = 180;
const PEN_PX = 2.4;

/** The imported raster's longest side. Same cap as a custom image stamp's:
 * beyond it the data URL grows without the mark looking any better. */
const IMPORT_MAX = 800;

type Door = 'draw' | 'type' | 'import';

interface ImportState {
  /** The scaled source pixels, kept so every threshold change re-derives from
   * the ORIGINAL — removal stays reversible until the asset is saved. */
  original: ImageData;
  fileStem: string;
}

export interface SignatureCaptureDialogProps {
  open: boolean;
  onClose: () => void;
  /** Arm an asset for placement on the page. */
  onPlace: (asset: SignatureAsset) => void;
}

export function SignatureCaptureDialog({
  open,
  onClose,
  onPlace,
}: SignatureCaptureDialogProps): React.ReactElement {
  useTranslation();
  const [assets, setAssets] = useState<SignatureAsset[]>([]);
  const [door, setDoor] = useState<Door>('draw');
  const [role, setRole] = useState<SignatureRole>('signature');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Draw door.
  const drawRef = useRef<HTMLCanvasElement | null>(null);
  const [strokes, setStrokes] = useState<number[][]>([]);
  const cancelDraw = useRef<(() => void) | null>(null);

  // Type door.
  const [typedText, setTypedText] = useState('');
  const [face, setFace] = useState<SignatureFaceId>(DEFAULT_SIGNATURE_FACE);
  const [facesReady, setFacesReady] = useState(false);

  // Import door.
  const [imported, setImported] = useState<ImportState | null>(null);
  const [stripBackground, setStripBackground] = useState(true);
  const [threshold, setThreshold] = useState(DEFAULT_BACKGROUND_THRESHOLD);
  const importRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setAssets(loadSignatureAssets());
    setError(null);
  }, [open]);

  // The bundled faces are loaded for the whole dialog, not per keystroke: the
  // picker previews each one, and the canvas preview of a PLACED typed
  // signature needs them registered too.
  useEffect(() => {
    if (!open) return;
    let live = true;
    void Promise.all(SIGNATURE_FACES.map((f) => ensureSignatureFaceLoaded(f.id)))
      .then(() => {
        if (live) setFacesReady(true);
      })
      .catch(() => {
        if (live) setError(tChrome('dialog.signature.facesUnavailable'));
      });
    return () => {
      live = false;
    };
  }, [open]);

  // Drawing is cancelled if the dialog goes away mid-stroke — a listener set
  // on `window` outlives this component otherwise.
  useEffect(() => () => cancelDraw.current?.(), []);

  // ── Draw ────────────────────────────────────────────────────────────
  const redrawInk = useCallback((paths: readonly (readonly number[])[]): void => {
    const canvas = drawRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineWidth = PEN_PX;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#111827';
    // Smoothing at RENDER: the stored points are untouched.
    for (const s of smoothStrokes(paths)) {
      if (s.length < 4) {
        if (s.length === 2) {
          ctx.beginPath();
          ctx.arc(s[0], s[1], PEN_PX / 2, 0, Math.PI * 2);
          ctx.fillStyle = '#111827';
          ctx.fill();
        }
        continue;
      }
      ctx.beginPath();
      ctx.moveTo(s[0], s[1]);
      for (let i = 2; i + 1 < s.length; i += 2) ctx.lineTo(s[i], s[i + 1]);
      ctx.stroke();
    }
  }, []);

  useEffect(() => {
    if (open && door === 'draw') redrawInk(strokes);
  }, [open, door, strokes, redrawInk]);

  const handleDrawDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    const canvas = e.currentTarget;
    const at = (cx: number, cy: number): [number, number] => {
      const r = canvas.getBoundingClientRect();
      return [
        ((cx - r.left) / r.width) * CANVAS_W,
        ((cy - r.top) / r.height) * CANVAS_H,
      ];
    };
    let live = [...at(e.clientX, e.clientY)];
    const committed = strokes;
    setStrokes([...committed, live]);
    const onMove = (ev: PointerEvent): void => {
      live = [...live, ...at(ev.clientX, ev.clientY)];
      setStrokes([...committed, live]);
    };
    const finish = (commit: boolean): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('blur', onCancel);
      cancelDraw.current = null;
      setStrokes(commit ? [...committed, live] : committed);
    };
    const onUp = (): void => finish(true);
    const onCancel = (): void => finish(false);
    cancelDraw.current = onCancel;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('blur', onCancel);
  };

  // ── Import ──────────────────────────────────────────────────────────
  /** The imported artwork as the store will hold it: background removed if
   * the user asked, trimmed to what is still visible so the saved aspect is
   * the SIGNATURE's and not the sheet's. */
  const deriveImport = useCallback(
    (state: ImportState): { dataUrl: string; aspect: number } | null => {
      const { width, height, data } = state.original;
      const pixels = stripBackground ? removeBackground(data, threshold) : data;
      const box = stripBackground
        ? visibleBounds(pixels, width, height)
        : { x: 0, y: 0, w: width, h: height };
      if (!box) return null;
      const out = document.createElement('canvas');
      out.width = box.w;
      out.height = box.h;
      const ctx = out.getContext('2d');
      if (!ctx) return null;
      const full = document.createElement('canvas');
      full.width = width;
      full.height = height;
      const fullCtx = full.getContext('2d');
      if (!fullCtx) return null;
      // A fresh, ArrayBuffer-backed copy: ImageData refuses a view whose
      // buffer type is not narrowed to ArrayBuffer, and `pixels` may be the
      // untouched original's view when removal is off.
      const backing = new Uint8ClampedArray(new ArrayBuffer(pixels.length));
      backing.set(pixels);
      fullCtx.putImageData(new ImageData(backing, width, height), 0, 0);
      ctx.drawImage(full, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
      // PNG unconditionally: a removed background is an ALPHA channel, and
      // JPEG has none — re-encoding there would paint the sheet back on.
      return { dataUrl: out.toDataURL('image/png'), aspect: box.h / box.w };
    },
    [stripBackground, threshold],
  );

  const importPreview = useMemo(
    () => (imported ? deriveImport(imported) : null),
    [imported, deriveImport],
  );

  useEffect(() => {
    const canvas = importRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!importPreview) return;
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(canvas.width / img.width, canvas.height / img.height, 1);
      const w = img.width * scale;
      const h = img.height * scale;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
    };
    img.src = importPreview.dataUrl;
  }, [importPreview]);

  const pickImage = async (): Promise<void> => {
    const path = await dialog.pickImageFile();
    if (!path) return;
    try {
      const bytes = await file.readBuffer(path);
      const bmp = await createImageBitmap(new Blob([bytes]));
      const scale = Math.min(1, IMPORT_MAX / Math.max(bmp.width, bmp.height));
      const w = Math.max(1, Math.round(bmp.width * scale));
      const h = Math.max(1, Math.round(bmp.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        setError(tChrome('dialog.signature.imageUnreadable'));
        return;
      }
      ctx.drawImage(bmp, 0, 0, w, h);
      bmp.close();
      setImported({
        original: ctx.getImageData(0, 0, w, h),
        fileStem: path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') ?? '',
      });
      setError(null);
    } catch {
      setError(tChrome('dialog.signature.imageUnreadable'));
    }
  };

  // ── Typed ───────────────────────────────────────────────────────────
  /** The typed name's aspect, measured in the face it will be committed in —
   * so the placement box matches what the appearance stream will fit into it.
   * Falls back to a plausible script ratio only while the face is still
   * loading, and saving is blocked until it is. */
  const typedAspect = useCallback((): number => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return 0.4;
    const size = 100;
    ctx.font = `${size}px "${signatureCssFamily(face)}", cursive`;
    const m = ctx.measureText(typedText);
    const height =
      (m.actualBoundingBoxAscent || size * 0.75) + (m.actualBoundingBoxDescent || size * 0.25);
    const width = m.width || size;
    return height / width;
  }, [face, typedText]);

  // ── Save / delete / place ───────────────────────────────────────────
  const commitAssets = (next: SignatureAsset[]): void => {
    setAssets(persistSignatureAssets(next));
  };

  const defaultLabel = (): string => {
    const trimmed = label.trim();
    if (trimmed) return trimmed;
    if (door === 'type' && typedText.trim()) return typedText.trim();
    if (door === 'import' && imported?.fileStem) return imported.fileStem;
    return tChrome(
      role === 'initials' ? 'dialog.signature.roleInitials' : 'dialog.signature.roleSignature',
    );
  };

  const save = (): void => {
    const base = { id: crypto.randomUUID(), name: defaultLabel(), role, createdAt: Date.now() };
    let asset: SignatureAsset;
    if (door === 'draw') {
      const norm = normalizeStrokes(strokes);
      if (!norm) {
        setError(tChrome('dialog.signature.needDrawing'));
        return;
      }
      asset = { ...base, kind: 'ink', strokes: norm.strokes, aspect: norm.aspect };
    } else if (door === 'type') {
      if (!typedText.trim()) {
        setError(tChrome('dialog.signature.needText'));
        return;
      }
      if (!facesReady) {
        setError(tChrome('dialog.signature.facesUnavailable'));
        return;
      }
      asset = { ...base, kind: 'typed', text: typedText.trim(), face, aspect: typedAspect() };
    } else {
      if (!imported) {
        setError(tChrome('dialog.signature.needImage'));
        return;
      }
      const derived = importPreview;
      if (!derived) {
        setError(tChrome('dialog.signature.imageErased'));
        return;
      }
      asset = { ...base, kind: 'image', imageData: derived.dataUrl, aspect: derived.aspect };
    }
    commitAssets([asset, ...assets]);
    setError(null);
    setLabel('');
    setStrokes([]);
    setTypedText('');
    setImported(null);
  };

  const canSave =
    door === 'draw'
      ? strokes.some((s) => s.length >= 4)
      : door === 'type'
        ? typedText.trim().length > 0 && facesReady
        : !!importPreview;

  return (
    <Dialog.Root open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 z-50" />
        <Dialog.Content
          aria-label={tChrome('dialog.signature.aria')}
          className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl w-[620px] max-h-[88vh] overflow-y-auto p-5"
          onEscapeKeyDown={onClose}
        >
          <Dialog.Title className="text-sm font-semibold text-neutral-100 mb-1">
            {tChrome('dialog.signature.title')}
          </Dialog.Title>
          <Dialog.Description className="text-xs text-neutral-400 mb-4">
            {tChrome('dialog.signature.blurb')}
          </Dialog.Description>

          {/* Saved assets */}
          <div className="mb-5">
            <div className="text-xs font-medium text-neutral-300 mb-2">
              {tChrome('dialog.signature.saved')}
            </div>
            {assets.length === 0 ? (
              <div className="text-xs text-neutral-500">
                {tChrome('dialog.signature.empty')}
              </div>
            ) : (
              <ul className="flex flex-col gap-1" data-testid="signature-list">
                {assets.map((a) => (
                  <li
                    key={a.id}
                    className="flex items-center gap-2 bg-neutral-800 rounded px-2 py-1.5"
                  >
                    <span className="w-24 h-10 shrink-0 flex items-center justify-center overflow-hidden">
                      <SignatureThumb asset={a} />
                    </span>
                    <span className="text-xs text-neutral-200 truncate flex-1">{a.name}</span>
                    <span className="text-[10px] uppercase tracking-wide text-neutral-500">
                      {tChrome(
                        a.role === 'initials'
                          ? 'dialog.signature.roleInitials'
                          : 'dialog.signature.roleSignature',
                      )}
                    </span>
                    <button
                      type="button"
                      data-testid="signature-place"
                      className="px-2 py-1 text-xs font-medium text-neutral-100 bg-blue-600 hover:bg-blue-500 rounded"
                      onClick={() => onPlace(a)}
                    >
                      {tChrome('dialog.signature.place')}
                    </button>
                    <button
                      type="button"
                      data-testid="signature-delete"
                      title={tChrome('dialog.signature.delete')}
                      aria-label={tChrome('dialog.signature.delete')}
                      className="px-2 py-1 text-xs text-neutral-400 hover:text-red-400"
                      onClick={() => commitAssets(assets.filter((s) => s.id !== a.id))}
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* The three doors */}
          <div className="flex gap-1 mb-3" role="tablist">
            {(['draw', 'type', 'import'] as const).map((d) => (
              <button
                key={d}
                type="button"
                role="tab"
                aria-selected={door === d}
                data-testid={`signature-door-${d}`}
                onClick={() => {
                  setDoor(d);
                  setError(null);
                }}
                className={
                  'px-3 py-1.5 text-xs font-medium rounded transition-colors ' +
                  (door === d
                    ? 'bg-neutral-700 text-neutral-100'
                    : 'text-neutral-400 hover:bg-neutral-800')
                }
              >
                {tChrome(
                  d === 'draw'
                    ? 'dialog.signature.tabDraw'
                    : d === 'type'
                      ? 'dialog.signature.tabType'
                      : 'dialog.signature.tabImport',
                )}
              </button>
            ))}
          </div>

          {door === 'draw' && (
            <div>
              <div className="text-xs text-neutral-400 mb-2">
                {tChrome('dialog.signature.drawHint')}
              </div>
              <canvas
                ref={drawRef}
                width={CANVAS_W}
                height={CANVAS_H}
                data-testid="signature-draw-canvas"
                aria-label={tChrome('dialog.signature.drawAria')}
                onPointerDown={handleDrawDown}
                className="w-full bg-white rounded border border-neutral-700 touch-none cursor-crosshair"
              />
              <div className="flex gap-2 mt-2">
                <button
                  type="button"
                  data-testid="signature-undo-stroke"
                  disabled={strokes.length === 0}
                  onClick={() => setStrokes(strokes.slice(0, -1))}
                  className="px-2 py-1 text-xs text-neutral-300 bg-neutral-700 hover:bg-neutral-600 rounded disabled:opacity-40"
                >
                  {tChrome('dialog.signature.undoStroke')}
                </button>
                <button
                  type="button"
                  data-testid="signature-clear"
                  disabled={strokes.length === 0}
                  onClick={() => setStrokes([])}
                  className="px-2 py-1 text-xs text-neutral-300 bg-neutral-700 hover:bg-neutral-600 rounded disabled:opacity-40"
                >
                  {tChrome('dialog.signature.clear')}
                </button>
              </div>
            </div>
          )}

          {door === 'type' && (
            <div>
              <div className="text-xs text-neutral-400 mb-2">
                {tChrome('dialog.signature.typeHint')}
              </div>
              <input
                type="text"
                value={typedText}
                data-testid="signature-typed-text"
                placeholder={tChrome('dialog.signature.typePlaceholder')}
                onChange={(e) => setTypedText(e.target.value)}
                className="w-full px-2 py-1.5 text-sm bg-neutral-800 text-neutral-100 border border-neutral-700 rounded mb-3"
              />
              <div
                className="flex flex-col gap-1"
                role="radiogroup"
                aria-label={tChrome('dialog.signature.faceGroup')}
              >
                {SIGNATURE_FACES.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    role="radio"
                    aria-checked={face === f.id}
                    aria-label={f.familyName}
                    data-testid={`signature-face-${f.id}`}
                    onClick={() => setFace(f.id)}
                    className={
                      'px-3 py-2 bg-white rounded border text-start overflow-hidden whitespace-nowrap ' +
                      (face === f.id ? 'border-blue-500' : 'border-neutral-700')
                    }
                    style={{
                      fontFamily: `"${signatureCssFamily(f.id)}", cursive`,
                      fontSize: 30,
                      lineHeight: 1.3,
                      color: '#111827',
                    }}
                  >
                    {typedText || tChrome('dialog.signature.typePlaceholder')}
                  </button>
                ))}
              </div>
            </div>
          )}

          {door === 'import' && (
            <div>
              <div className="text-xs text-neutral-400 mb-2">
                {tChrome('dialog.signature.importHint')}
              </div>
              <div className="flex items-center gap-2 mb-2">
                <button
                  type="button"
                  data-testid="signature-pick-image"
                  onClick={() => void pickImage()}
                  className="px-3 py-1.5 text-xs font-medium text-neutral-300 bg-neutral-700 hover:bg-neutral-600 rounded"
                >
                  {tChrome('dialog.signature.importChoose')}
                </button>
                <span className="text-xs text-neutral-400 truncate">
                  {imported?.fileStem || tChrome('dialog.signature.importNone')}
                </span>
              </div>
              <canvas
                ref={importRef}
                width={CANVAS_W}
                height={CANVAS_H}
                data-testid="signature-import-preview"
                className="w-full bg-white rounded border border-neutral-700"
              />
              <label className="flex items-center gap-2 mt-2 text-xs text-neutral-300">
                <input
                  type="checkbox"
                  data-testid="signature-strip-background"
                  checked={stripBackground}
                  onChange={(e) => setStripBackground(e.target.checked)}
                />
                {tChrome('dialog.signature.removeBackground')}
              </label>
              {stripBackground && (
                <label className="flex items-center gap-2 mt-2 text-xs text-neutral-300">
                  <span className="shrink-0">{tChrome('dialog.signature.threshold')}</span>
                  <input
                    type="range"
                    min={60}
                    max={250}
                    value={threshold}
                    data-testid="signature-threshold"
                    onChange={(e) => setThreshold(Number(e.target.value))}
                    className="flex-1"
                  />
                  <span className="w-8 text-end tabular-nums">{threshold}</span>
                </label>
              )}
            </div>
          )}

          {/* Shared metadata + save */}
          <div className="flex items-end gap-2 mt-4">
            <label className="flex-1 text-xs text-neutral-300">
              <span className="block mb-1">{tChrome('dialog.signature.nameLabel')}</span>
              <input
                type="text"
                value={label}
                data-testid="signature-label"
                placeholder={tChrome('dialog.signature.namePlaceholder')}
                onChange={(e) => setLabel(e.target.value)}
                className="w-full px-2 py-1.5 text-sm bg-neutral-800 text-neutral-100 border border-neutral-700 rounded"
              />
            </label>
            <label className="text-xs text-neutral-300">
              <span className="block mb-1">{tChrome('dialog.signature.roleGroup')}</span>
              <select
                value={role}
                data-testid="signature-role"
                onChange={(e) => setRole(e.target.value as SignatureRole)}
                className="px-2 py-1.5 text-sm bg-neutral-800 text-neutral-100 border border-neutral-700 rounded"
              >
                <option value="signature">{tChrome('dialog.signature.roleSignature')}</option>
                <option value="initials">{tChrome('dialog.signature.roleInitials')}</option>
              </select>
            </label>
            <button
              type="button"
              data-testid="signature-save"
              disabled={!canSave}
              onClick={save}
              className="px-3 py-1.5 text-xs font-medium text-neutral-100 bg-blue-600 hover:bg-blue-500 rounded disabled:opacity-40"
            >
              {tChrome('dialog.signature.save')}
            </button>
          </div>

          {error && (
            <div data-testid="signature-error" className="mt-3 text-xs text-red-400">
              {error}
            </div>
          )}

          <div className="flex justify-end mt-4">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-xs font-medium text-neutral-300 bg-neutral-700 hover:bg-neutral-600 rounded"
            >
              {tChrome('dialog.common.close')}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** A saved asset's thumbnail, drawn the way the placement will draw it:
 * vector paths for ink, the raster for an import, the chosen face for a typed
 * name. One appearance author — a thumbnail that guessed differently from the
 * commit is a thumbnail that lies. */
export function SignatureThumb({ asset }: { asset: SignatureAsset }): React.ReactElement {
  if (asset.kind === 'image') {
    return (
      <img
        src={asset.imageData}
        alt={asset.name}
        draggable={false}
        className="max-w-full max-h-full object-contain"
      />
    );
  }
  if (asset.kind === 'typed') {
    return (
      <span
        className="text-neutral-100 whitespace-nowrap overflow-hidden"
        style={{ fontFamily: `"${signatureCssFamily(asset.face)}", cursive`, fontSize: 22 }}
      >
        {asset.text}
      </span>
    );
  }
  const paths = placeStrokes(smoothStrokes(asset.strokes), { x: 0, y: 0, w: 100, h: 100 });
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" className="w-full h-full">
      {paths.map((s, i) => (
        <polyline
          key={i}
          points={pointsAttr(s)}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
}

function pointsAttr(flat: readonly number[]): string {
  const out: string[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push(`${flat[i]},${flat[i + 1]}`);
  return out.join(' ');
}

export default SignatureCaptureDialog;
