import React, { useState, useCallback } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { file, app } from '../lib/tauri-bridge';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import { useTranslation } from 'react-i18next';
import { tChrome, tChromeCount } from '../i18n';
import type { PanelKey } from '../i18n-panels';

// Six placement slots (top/bottom × left/center/right); an empty slot isn't
// stamped. Text may contain {page}, {pages}, {bates} — the engine substitutes
// per page. Bates numbering is just a slot whose text uses {bates}.
const SLOTS: { pos: string; label: PanelKey }[] = [
  { pos: 'tl', label: 'panel.hf.slot.tl' as PanelKey },
  { pos: 'tc', label: 'panel.hf.slot.tc' as PanelKey },
  { pos: 'tr', label: 'panel.hf.slot.tr' as PanelKey },
  { pos: 'bl', label: 'panel.hf.slot.bl' as PanelKey },
  { pos: 'bc', label: 'panel.hf.slot.bc' as PanelKey },
  { pos: 'br', label: 'panel.hf.slot.br' as PanelKey },
];

const COLORS = ['#16161a', '#5b6270', '#e0393e', '#2f6fed'];

export function HeaderFooterPanel(): React.ReactElement {
  // Re-render on language change; strings resolve via tChrome.
  useTranslation();
  const { activeFile, openNewFiles, dispatch } = useActiveFile();
  const { call } = useEngine();
  const [slots, setSlots] = useState<Record<string, string>>({});
  const [fontSize, setFontSize] = useState(10);
  const [margin, setMargin] = useState(24);
  const [color, setColor] = useState(COLORS[0]);
  const [pageInput, setPageInput] = useState('all');
  const [batesStart, setBatesStart] = useState(1);
  const [batesDigits, setBatesDigits] = useState(6);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const setSlot = useCallback((pos: string, text: string) => {
    setSlots((prev) => ({ ...prev, [pos]: text }));
  }, []);

  const handleApply = useCallback(async () => {
    if (!activeFile) return;
    const placements = SLOTS.filter((s) => (slots[s.pos] ?? '').trim().length > 0).map((s) => ({
      position: s.pos,
      text: slots[s.pos],
    }));
    if (placements.length === 0) {
      setStatus(tChrome('panel.hf.enterText'));
      return;
    }
    // Page range: "all" or a first-last from a comma/dash list (the header/footer
    // op takes a contiguous range, unlike watermark's page set).
    let first = 1;
    let last: number | undefined;
    const trimmed = pageInput.trim().toLowerCase();
    if (trimmed !== 'all') {
      const nums = trimmed.split(/[,-]/).map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
      if (nums.length === 0) {
        setStatus(tChrome('panel.hf.badRange'));
        return;
      }
      first = Math.min(...nums);
      last = Math.max(...nums);
    }
    setBusy(true);
    setStatus(tChrome('panel.hf.applying'));
    try {
      const snapshotPath = await file.snapshot(activeFile.workingPath);
      const result = await call('add_header_footer', {
        file: activeFile.workingPath,
        output: activeFile.workingPath,
        placements,
        first_page: first,
        ...(last !== undefined ? { last_page: last } : {}),
        font_size: fontSize,
        margin,
        color,
        bates_start: batesStart,
        bates_digits: batesDigits,
        font_dir: await app.getEditFontPath(),
      });
      const buffer = await file.readBuffer(activeFile.workingPath);
      const info = await call('get_page_count', { file: activeFile.workingPath });
      dispatch({ type: 'UPDATE_FILE', path: activeFile.path, pageCount: info.pages, buffer, snapshotPath });
      const n = (result as unknown as { pages_stamped: number }).pages_stamped;
      setStatus(tChromeCount('panel.hf.stamped', n));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : JSON.stringify(e);
      setStatus(tChrome('panel.common.error', { message: msg }));
    } finally {
      setBusy(false);
    }
  }, [activeFile, slots, fontSize, margin, color, pageInput, batesStart, batesDigits, call, dispatch]);

  if (!activeFile) {
    return <NoFileOpen onOpen={openNewFiles} message={tChrome('panel.hf.open')} />;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="text-sm text-neutral-400">
        {tChrome('panel.common.workingOn')} <span className="text-neutral-200">{activeFile.name}</span> ({tChromeCount('panel.common.pageCount', activeFile.pageCount)})
      </div>
      <p className="text-xs text-neutral-500">
        {tChrome('panel.hf.tokensPrefix')} <code>{'{page}'}</code> {tChrome('panel.hf.tokenPage')} ·{' '}
        <code>{'{pages}'}</code> {tChrome('panel.hf.tokenPages')} · <code>{'{bates}'}</code>{' '}
        {tChrome('panel.hf.tokenBates')}. {tChrome('panel.hf.emptySkips')}
      </p>
      <div className="grid grid-cols-3 gap-2">
        {SLOTS.map((s) => (
          <div key={s.pos}>
            <label className="block text-xs text-neutral-400 mb-1">{tChrome(s.label)}</label>
            <input
              data-testid={`hf-${s.pos}`}
              type="text"
              value={slots[s.pos] ?? ''}
              onChange={(e) => setSlot(s.pos, e.target.value)}
              placeholder="—"
              className="w-full px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500"
            />
          </div>
        ))}
      </div>
      <div className="flex gap-6 items-end flex-wrap">
        <div>
          <label className="block text-sm text-neutral-400 mb-1">{tChrome('panel.hf.fontSize')}</label>
          <input
            data-testid="hf-font-size"
            aria-label={tChrome('panel.hf.fontSize')}
            type="number"
            min={4}
            max={72}
            value={fontSize}
            onChange={(e) => setFontSize(Number(e.target.value))}
            className="w-20 px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500"
          />
        </div>
        <div>
          <label className="block text-sm text-neutral-400 mb-1">{tChrome('panel.hf.margin')}</label>
          <input
            data-testid="hf-margin"
            aria-label={tChrome('panel.hf.margin')}
            type="number"
            min={0}
            max={144}
            value={margin}
            onChange={(e) => setMargin(Number(e.target.value))}
            className="w-20 px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500"
          />
        </div>
        <div>
          <label className="block text-sm text-neutral-400 mb-1">{tChrome('panel.hf.color')}</label>
          <div className="flex items-center gap-1.5 py-1.5">
            {COLORS.map((c) => (
              <button
                key={c}
                title={c}
                onClick={() => setColor(c)}
                className="w-5 h-5 rounded-full"
                style={{
                  backgroundColor: c,
                  outline: color === c ? '2px solid white' : '1px solid rgba(255,255,255,0.3)',
                  outlineOffset: 1,
                }}
              />
            ))}
          </div>
        </div>
        <div>
          <label className="block text-sm text-neutral-400 mb-1">{tChrome('panel.hf.pagesLabel')}</label>
          <input
            data-testid="hf-pages"
            aria-label={tChrome('panel.hf.pagesAria')}
            type="text"
            value={pageInput}
            onChange={(e) => setPageInput(e.target.value)}
            className="w-32 px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500"
          />
        </div>
      </div>
      <div className="flex gap-6 items-end flex-wrap">
        <div>
          <label className="block text-sm text-neutral-400 mb-1">{tChrome('panel.hf.batesStart')}</label>
          <input
            data-testid="hf-bates-start"
            aria-label={tChrome('panel.hf.batesStartAria')}
            type="number"
            min={0}
            value={batesStart}
            onChange={(e) => setBatesStart(Number(e.target.value))}
            className="w-24 px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500"
          />
        </div>
        <div>
          <label className="block text-sm text-neutral-400 mb-1">{tChrome('panel.hf.batesDigits')}</label>
          <input
            data-testid="hf-bates-digits"
            aria-label={tChrome('panel.hf.batesDigitsAria')}
            type="number"
            min={1}
            max={12}
            value={batesDigits}
            onChange={(e) => setBatesDigits(Number(e.target.value))}
            className="w-24 px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500"
          />
        </div>
      </div>
      <button
        data-testid="hf-apply"
        onClick={handleApply}
        disabled={busy}
        className="self-start px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm font-medium"
      >
        {busy ? tChrome('panel.hf.applying') : tChrome('panel.hf.apply')}
      </button>
      <StatusBar message={status} busy={busy} />
    </div>
  );
}
