import React, { useState, useCallback } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { file, app } from '../lib/tauri-bridge';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';

// Six placement slots (top/bottom × left/center/right); an empty slot isn't
// stamped. Text may contain {page}, {pages}, {bates} — the engine substitutes
// per page. Bates numbering is just a slot whose text uses {bates}.
const SLOTS: { pos: string; label: string }[] = [
  { pos: 'tl', label: 'Top left' },
  { pos: 'tc', label: 'Top center' },
  { pos: 'tr', label: 'Top right' },
  { pos: 'bl', label: 'Bottom left' },
  { pos: 'bc', label: 'Bottom center' },
  { pos: 'br', label: 'Bottom right' },
];

const COLORS = ['#16161a', '#5b6270', '#e0393e', '#2f6fed'];

export function HeaderFooterPanel(): React.ReactElement {
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
      setStatus('Enter text in at least one position');
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
        setStatus('Error: page range must be e.g. 1-5 or all');
        return;
      }
      first = Math.min(...nums);
      last = Math.max(...nums);
    }
    setBusy(true);
    setStatus('Applying…');
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
      setStatus(`Stamped ${n} page${n === 1 ? '' : 's'}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : JSON.stringify(e);
      setStatus(`Error: ${msg}`);
    } finally {
      setBusy(false);
    }
  }, [activeFile, slots, fontSize, margin, color, pageInput, batesStart, batesDigits, call, dispatch]);

  if (!activeFile) {
    return <NoFileOpen onOpen={openNewFiles} message="Open a PDF to add headers, footers, or Bates numbers" />;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="text-sm text-neutral-400">
        Working on: <span className="text-neutral-200">{activeFile.name}</span> ({activeFile.pageCount} pages)
      </div>
      <p className="text-xs text-neutral-500">
        Tokens: <code>{'{page}'}</code> page number, <code>{'{pages}'}</code> total, <code>{'{bates}'}</code> Bates
        number. Leave a box empty to skip it.
      </p>
      <div className="grid grid-cols-3 gap-2">
        {SLOTS.map((s) => (
          <div key={s.pos}>
            <label className="block text-xs text-neutral-400 mb-1">{s.label}</label>
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
          <label className="block text-sm text-neutral-400 mb-1">Font size</label>
          <input
            data-testid="hf-font-size"
            type="number"
            min={4}
            max={72}
            value={fontSize}
            onChange={(e) => setFontSize(Number(e.target.value))}
            className="w-20 px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500"
          />
        </div>
        <div>
          <label className="block text-sm text-neutral-400 mb-1">Margin</label>
          <input
            data-testid="hf-margin"
            type="number"
            min={0}
            max={144}
            value={margin}
            onChange={(e) => setMargin(Number(e.target.value))}
            className="w-20 px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500"
          />
        </div>
        <div>
          <label className="block text-sm text-neutral-400 mb-1">Color</label>
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
          <label className="block text-sm text-neutral-400 mb-1">Pages (e.g. 1-5 or all)</label>
          <input
            data-testid="hf-pages"
            type="text"
            value={pageInput}
            onChange={(e) => setPageInput(e.target.value)}
            className="w-32 px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500"
          />
        </div>
      </div>
      <div className="flex gap-6 items-end flex-wrap">
        <div>
          <label className="block text-sm text-neutral-400 mb-1">Bates start</label>
          <input
            data-testid="hf-bates-start"
            type="number"
            min={0}
            value={batesStart}
            onChange={(e) => setBatesStart(Number(e.target.value))}
            className="w-24 px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500"
          />
        </div>
        <div>
          <label className="block text-sm text-neutral-400 mb-1">Bates digits</label>
          <input
            data-testid="hf-bates-digits"
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
        {busy ? 'Applying…' : 'Apply'}
      </button>
      <StatusBar message={status} busy={busy} />
    </div>
  );
}
