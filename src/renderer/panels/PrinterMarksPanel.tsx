import React, { useCallback, useEffect, useState } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { useOperations } from '../hooks/useOperations';
import { app } from '../lib/tauri-bridge';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import { useTranslation } from 'react-i18next';
import { tChrome } from '../i18n';
import type { PanelKey } from '../i18n-panels';
import {
  MARK_KINDS,
  MARK_STYLES,
  MARK_WEIGHTS,
  type MarkKind,
  type MarkStyle,
  type PrinterMarkReport,
  markGrowth,
  trimSourceKey,
} from '../lib/printer-marks';

const KIND_LABELS: Record<MarkKind, PanelKey> = {
  crop: 'panel.printerMarks.crop' as PanelKey,
  registration: 'panel.printerMarks.registration' as PanelKey,
  colorbars: 'panel.printerMarks.colorbars' as PanelKey,
  pageinfo: 'panel.printerMarks.pageinfo' as PanelKey,
};

const STYLE_LABELS: Record<MarkStyle, PanelKey> = {
  western: 'panel.printerMarks.styleWestern' as PanelKey,
  japanese: 'panel.printerMarks.styleJapanese' as PanelKey,
};

export function PrinterMarksPanel(): React.ReactElement {
  useTranslation();
  const { activeFile, openNewFiles } = useActiveFile();
  const { call } = useEngine();
  const { performOperation } = useOperations();

  const [report, setReport] = useState<PrinterMarkReport | null>(null);
  const [kinds, setKinds] = useState<MarkKind[]>([...MARK_KINDS]);
  const [style, setStyle] = useState<MarkStyle>('western');
  const [weight, setWeight] = useState<number>(0.25);
  const [offset, setOffset] = useState(9);
  const [length, setLength] = useState(18);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const workingPath = activeFile?.workingPath ?? null;
  const filePath = activeFile?.path ?? null;
  const buffer = activeFile?.buffer ?? null;

  useEffect(() => {
    if (!workingPath) {
      setReport(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await call('list_printer_marks', { file: workingPath });
        if (!cancelled) setReport(res as unknown as PrinterMarkReport);
      } catch (e: unknown) {
        if (!cancelled) {
          setStatus(tChrome('panel.common.error', {
            message: e instanceof Error ? e.message : String(e),
          }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workingPath, buffer, call]);

  const toggle = useCallback((kind: MarkKind) => {
    setKinds((current) => (current.includes(kind)
      ? current.filter((k) => k !== kind)
      : MARK_KINDS.filter((k) => k === kind || current.includes(k))));
  }, []);

  const addMarks = useCallback(async () => {
    if (!filePath) return;
    setBusy(true);
    setStatus(tChrome('panel.printerMarks.adding'));
    try {
      await performOperation(filePath, 'add_printer_marks', {
        marks: kinds,
        style,
        weight,
        offset,
        length,
        font_dir: await app.getEditFontPath(),
      });
      setStatus(tChrome('panel.printerMarks.added', { growth: markGrowth(offset, length) }));
    } catch (e: unknown) {
      setStatus(tChrome('panel.common.error', {
        message: e instanceof Error ? e.message : String(e),
      }));
    } finally {
      setBusy(false);
    }
  }, [filePath, performOperation, kinds, style, weight, offset, length]);

  const removeMarks = useCallback(async () => {
    if (!filePath) return;
    setBusy(true);
    setStatus(tChrome('panel.printerMarks.removing'));
    try {
      await performOperation(filePath, 'remove_printer_marks', {});
      setStatus(tChrome('panel.printerMarks.removed'));
    } catch (e: unknown) {
      setStatus(tChrome('panel.common.error', {
        message: e instanceof Error ? e.message : String(e),
      }));
    } finally {
      setBusy(false);
    }
  }, [filePath, performOperation]);

  if (!activeFile) {
    return <NoFileOpen onOpen={openNewFiles} message={tChrome('panel.printerMarks.open')} />;
  }

  const marked = report?.marked ?? 0;
  const withoutTrim = report?.without_trim_box ?? 0;
  const firstSource = report?.pages?.[0]?.trim_source ?? 'media';

  return (
    <div className="flex flex-col gap-4">
      <div className="text-sm text-neutral-400">
        {tChrome('panel.common.workingOn')}{' '}
        <span className="text-neutral-200">{activeFile.name}</span>
      </div>
      <p className="text-xs text-neutral-500">{tChrome('panel.printerMarks.blurb')}</p>

      <div className="text-xs text-neutral-400" data-testid="printer-marks-trim-source">
        {tChrome(trimSourceKey(firstSource) as PanelKey)}
      </div>
      {withoutTrim > 0 && (
        <div className="text-xs text-amber-400" data-testid="printer-marks-no-trim">
          {tChrome('panel.printerMarks.noTrimBox', { pages: withoutTrim })}
        </div>
      )}
      {marked > 0 && (
        <div className="text-xs text-neutral-400" data-testid="printer-marks-present">
          {tChrome('panel.printerMarks.present', { pages: marked })}
        </div>
      )}

      <div className="flex flex-col gap-1" data-testid="printer-marks-kinds">
        {MARK_KINDS.map((kind) => (
          <label key={kind} className="flex items-center gap-2 text-sm text-neutral-300">
            <input
              type="checkbox"
              data-testid={`printer-marks-kind-${kind}`}
              checked={kinds.includes(kind)}
              onChange={() => toggle(kind)}
            />
            {tChrome(KIND_LABELS[kind])}
          </label>
        ))}
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <label className="flex items-center gap-1 text-xs text-neutral-500">
          {tChrome('panel.printerMarks.style')}
          <select
            data-testid="printer-marks-style"
            className="px-2 py-1 text-sm bg-neutral-900 border border-neutral-700 rounded text-neutral-200"
            value={style}
            onChange={(e) => setStyle(e.target.value as MarkStyle)}
          >
            {MARK_STYLES.map((s) => (
              <option key={s} value={s}>{tChrome(STYLE_LABELS[s])}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1 text-xs text-neutral-500">
          {tChrome('panel.printerMarks.weight')}
          <select
            data-testid="printer-marks-weight"
            className="px-2 py-1 text-sm bg-neutral-900 border border-neutral-700 rounded text-neutral-200"
            value={String(weight)}
            onChange={(e) => setWeight(Number(e.target.value))}
          >
            {MARK_WEIGHTS.map((w) => (
              <option key={w} value={String(w)}>
                {tChrome('panel.printerMarks.points', { value: w })}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1 text-xs text-neutral-500">
          {tChrome('panel.printerMarks.offset')}
          <input
            type="number"
            data-testid="printer-marks-offset"
            className="w-16 px-1 py-0.5 bg-neutral-900 border border-neutral-700 rounded text-neutral-200"
            min={0}
            step={1}
            value={offset}
            onChange={(e) => setOffset(Number(e.target.value))}
          />
        </label>
        <label className="flex items-center gap-1 text-xs text-neutral-500">
          {tChrome('panel.printerMarks.length')}
          <input
            type="number"
            data-testid="printer-marks-length"
            className="w-16 px-1 py-0.5 bg-neutral-900 border border-neutral-700 rounded text-neutral-200"
            min={1}
            step={1}
            value={length}
            onChange={(e) => setLength(Number(e.target.value))}
          />
        </label>
      </div>

      <p className="text-xs text-neutral-500" data-testid="printer-marks-growth">
        {tChrome('panel.printerMarks.growthNote', { growth: markGrowth(offset, length) })}
      </p>

      <div className="flex items-center gap-2">
        <button
          data-testid="printer-marks-add"
          disabled={busy || kinds.length === 0}
          onClick={() => void addMarks()}
          className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 rounded disabled:opacity-50"
        >
          {tChrome('panel.printerMarks.add')}
        </button>
        <button
          data-testid="printer-marks-remove"
          disabled={busy}
          onClick={() => void removeMarks()}
          className="px-3 py-1.5 text-sm bg-neutral-800 border border-neutral-700 rounded hover:bg-neutral-700 disabled:opacity-50"
        >
          {tChrome('panel.printerMarks.remove')}
        </button>
      </div>

      <StatusBar message={status} busy={busy} />
    </div>
  );
}
