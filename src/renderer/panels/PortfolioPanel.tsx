import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { file, dialog, app } from '../lib/tauri-bridge';
import { getCommandContext } from '../commands/context';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import { TEST_HARNESS_ENABLED, registerPortfolioHandlers } from '../testHarness';
import { useTranslation } from 'react-i18next';
import { tChrome, tChromeCount } from '../i18n';

interface Member {
  name: string;
  size: number;
  description: string;
  mime: string;
}

interface PortfolioInfo {
  is_portfolio: boolean;
  view: string;
  members: Member[];
  count: number;
}

function human(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

const isPdfMember = (m: Member): boolean =>
  m.mime === 'application/pdf' || /\.pdf$/i.test(m.name);

export function PortfolioPanel(): React.ReactElement {
  // N12: re-render on language change; strings resolve via tChrome.
  useTranslation();
  const { activeFile, openNewFiles, dispatch } = useActiveFile();
  const { call, callRaw, saveFile } = useEngine();
  const [info, setInfo] = useState<PortfolioInfo | null>(null);
  const [title, setTitle] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const buffer = activeFile?.buffer ?? null;
  const workingPath = activeFile?.workingPath ?? null;

  const refresh = useCallback(async () => {
    if (!workingPath) return;
    try {
      const res = await call('get_portfolio', { file: workingPath });
      setInfo(res as unknown as PortfolioInfo);
    } catch {
      setInfo(null);
    }
  }, [workingPath, call]);

  useEffect(() => {
    if (!buffer || !workingPath) {
      setInfo(null);
      return;
    }
    void refresh();
  }, [buffer, workingPath, refresh]);

  const reloadFile = useCallback(
    async (snapshotPath: string) => {
      if (!activeFile) return;
      const buf = await file.readBuffer(activeFile.workingPath);
      const pages = await call('get_page_count', { file: activeFile.workingPath });
      dispatch({
        type: 'UPDATE_FILE',
        path: activeFile.path,
        pageCount: pages.pages,
        buffer: buf,
        snapshotPath,
      });
    },
    [activeFile, call, dispatch],
  );

  /** The create core (paths in hand): build, then open through the funnel. */
  const createWithPaths = useCallback(
    async (output: string, sources: string[], titleArg?: string) => {
      setBusy(true);
      setStatus(tChrome('panel.portfolio.creating'));
      try {
        // callRaw, deliberately: the members are PICKED DISK FILES
        // (non-workspace targets — the batch-OCR precedent) and the output is
        // a new file.
        const t = (titleArg ?? title).trim();
        await callRaw('create_portfolio', {
          output,
          sources,
          ...(t ? { title: t } : {}),
        });
        setStatus(tChrome('panel.portfolio.created'));
        setTitle('');
        await getCommandContext()?.app?.openPath(output);
      } catch (e: unknown) {
        setStatus(tChrome('panel.common.error', { message: e instanceof Error ? e.message : String(e) }));
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [callRaw, title],
  );

  /** The one create flow (docless or not): pick members → pick output → open. */
  const handleCreate = useCallback(async () => {
    const sources = await dialog.pickAnyFiles();
    if (sources.length === 0) return;
    const output = await saveFile('portfolio.pdf');
    if (!output) return;
    await createWithPaths(output, sources).catch(() => {});
  }, [createWithPaths, saveFile]);

  const handleConvert = useCallback(async () => {
    if (!activeFile) return;
    setBusy(true);
    setStatus(tChrome('panel.portfolio.converting'));
    try {
      const snapshotPath = await file.snapshot(activeFile.workingPath);
      await call('make_portfolio', {
        file: activeFile.workingPath,
        output: activeFile.workingPath,
      });
      await reloadFile(snapshotPath);
      await refresh();
      setStatus(tChrome('panel.portfolio.converted'));
    } catch (e: unknown) {
      setStatus(tChrome('panel.common.error', { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  }, [activeFile, call, reloadFile, refresh]);

  const addWithSource = useCallback(
    async (source: string) => {
      if (!activeFile) return;
      setBusy(true);
      setStatus(tChrome('panel.portfolio.adding'));
      try {
        const snapshotPath = await file.snapshot(activeFile.workingPath);
        const r = await call('add_attachment', {
          file: activeFile.workingPath,
          output: activeFile.workingPath,
          source,
        });
        await reloadFile(snapshotPath);
        await refresh();
        setStatus(tChrome('panel.portfolio.added', { name: (r as unknown as { name: string }).name }));
      } catch (e: unknown) {
        setStatus(tChrome('panel.common.error', { message: e instanceof Error ? e.message : String(e) }));
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [activeFile, call, reloadFile, refresh],
  );

  const handleAddMember = useCallback(async () => {
    const source = await dialog.pickAnyFile();
    if (!source) return;
    await addWithSource(source).catch(() => {});
  }, [addWithSource]);

  const handleOpenMember = useCallback(
    async (name: string) => {
      if (!activeFile) return;
      setBusy(true);
      setStatus(tChrome('panel.portfolio.opening'));
      try {
        // Extract to the managed per-portfolio folder (Rust owns the path),
        // then open the REAL file through the one open funnel — a real tab,
        // and File ▸ Save writes to that real extracted file.
        const dir = await app.portfolioMemberDir(activeFile.path);
        const r = await call('extract_member_to_dir', {
          file: activeFile.workingPath,
          name,
          dest_dir: dir,
        });
        await getCommandContext()?.app?.openPath(
          (r as unknown as { output: string }).output,
        );
        setStatus(tChrome('panel.portfolio.opened', { name }));
      } catch (e: unknown) {
        setStatus(tChrome('panel.common.error', { message: e instanceof Error ? e.message : String(e) }));
      } finally {
        setBusy(false);
      }
    },
    [activeFile, call],
  );

  // Non-PDF members open with the OS default app:
  // extract to the same managed dir the in-app open uses, then a Rust
  // command scoped to THAT dir shell-opens it — never an arbitrary path.
  const handleOpenMemberExternal = useCallback(
    async (name: string) => {
      if (!activeFile) return;
      setBusy(true);
      setStatus(tChrome('panel.portfolio.opening'));
      try {
        const dir = await app.portfolioMemberDir(activeFile.path);
        const r = await call('extract_member_to_dir', {
          file: activeFile.workingPath,
          name,
          dest_dir: dir,
        });
        await app.openPortfolioMemberFile((r as unknown as { output: string }).output);
        setStatus(tChrome('panel.portfolio.openedExternally', { name }));
      } catch (e: unknown) {
        setStatus(tChrome('panel.common.error', { message: e instanceof Error ? e.message : String(e) }));
      } finally {
        setBusy(false);
      }
    },
    [activeFile, call],
  );

  const saveMemberTo = useCallback(
    async (name: string, output: string) => {
      if (!activeFile) return;
      setBusy(true);
      setStatus(tChrome('panel.portfolio.saving'));
      try {
        await call('extract_attachment', { file: activeFile.workingPath, name, output });
        setStatus(tChrome('panel.portfolio.saved', { name }));
      } catch (e: unknown) {
        setStatus(tChrome('panel.common.error', { message: e instanceof Error ? e.message : String(e) }));
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [activeFile, call],
  );

  const handleSaveMember = useCallback(
    async (name: string) => {
      const output = await saveFile(name);
      if (!output) return;
      await saveMemberTo(name, output).catch(() => {});
    },
    [saveFile, saveMemberTo],
  );

  const updateWithSource = useCallback(
    async (name: string, source: string) => {
      if (!activeFile) return;
      setBusy(true);
      setStatus(tChrome('panel.portfolio.updating'));
      try {
        const snapshotPath = await file.snapshot(activeFile.workingPath);
        await call('update_portfolio_member', {
          file: activeFile.workingPath,
          output: activeFile.workingPath,
          name,
          source,
        });
        await reloadFile(snapshotPath);
        await refresh();
        setStatus(tChrome('panel.portfolio.updated', { name }));
      } catch (e: unknown) {
        setStatus(tChrome('panel.common.error', { message: e instanceof Error ? e.message : String(e) }));
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [activeFile, call, reloadFile, refresh],
  );

  const handleUpdateMember = useCallback(
    async (name: string) => {
      const source = await dialog.pickAnyFile();
      if (!source) return;
      await updateWithSource(name, source).catch(() => {});
    },
    [updateWithSource],
  );

  // Harness bridge: the pickers and save dialogs are native and undrivable —
  // e2e injects the paths and runs these REAL flows (the export-images
  // precedent).
  const bridgeRef = useRef({ createWithPaths, addWithSource, updateWithSource, saveMemberTo });
  bridgeRef.current = { createWithPaths, addWithSource, updateWithSource, saveMemberTo };
  useEffect(() => {
    if (!TEST_HARNESS_ENABLED) return;
    registerPortfolioHandlers({
      create: (output, sources, titleArg) =>
        bridgeRef.current.createWithPaths(output, sources, titleArg),
      add: (source) => bridgeRef.current.addWithSource(source),
      update: (name, source) => bridgeRef.current.updateWithSource(name, source),
      saveMember: (name, output) => bridgeRef.current.saveMemberTo(name, output),
    });
    return () => registerPortfolioHandlers(null);
  }, []);

  const handleRemoveMember = useCallback(
    async (name: string) => {
      if (!activeFile) return;
      setBusy(true);
      setStatus(tChrome('panel.portfolio.removing'));
      try {
        const snapshotPath = await file.snapshot(activeFile.workingPath);
        await call('remove_attachment', {
          file: activeFile.workingPath,
          output: activeFile.workingPath,
          name,
        });
        await reloadFile(snapshotPath);
        await refresh();
        setStatus(tChrome('panel.portfolio.removed', { name }));
      } catch (e: unknown) {
        setStatus(tChrome('panel.common.error', { message: e instanceof Error ? e.message : String(e) }));
      } finally {
        setBusy(false);
      }
    },
    [activeFile, call, reloadFile, refresh],
  );

  const createSection = (
    <div className="flex flex-col gap-2" data-testid="portfolio-create-section">
      <div className="text-sm font-medium text-neutral-300">{tChrome('panel.portfolio.createHeading')}</div>
      <input
        type="text"
        data-testid="portfolio-title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={tChrome('panel.portfolio.titlePlaceholder')}
        disabled={busy}
        className="px-2 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm text-neutral-200 placeholder-neutral-500"
      />
      <div>
        <button
          data-testid="portfolio-create"
          onClick={handleCreate}
          disabled={busy}
          className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm font-medium"
        >
          {tChrome('panel.portfolio.pickAndCreate')}
        </button>
      </div>
      <p className="text-xs text-neutral-500">
        {tChrome('panel.portfolio.createBlurb')}
      </p>
    </div>
  );

  if (!activeFile) {
    return (
      <div className="flex flex-col gap-6">
        {createSection}
        <NoFileOpen
          onOpen={openNewFiles}
          message={tChrome('panel.portfolio.openAlt')}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="text-sm text-neutral-400">
        {tChrome('panel.common.workingOn')} <span className="text-neutral-200">{activeFile.name}</span>
      </div>

      {info && !info.is_portfolio && (
        <div className="flex flex-col gap-2" data-testid="portfolio-not">
          <p className="text-sm text-neutral-500">{tChrome('panel.portfolio.notPortfolio')}</p>
          <div>
            <button
              data-testid="portfolio-convert"
              onClick={handleConvert}
              disabled={busy}
              className="px-3 py-1.5 bg-neutral-700 hover:bg-neutral-600 disabled:opacity-50 rounded text-sm"
            >
              {tChrome('panel.portfolio.convert')}
            </button>
          </div>
          <p className="text-xs text-neutral-500">
            {tChrome('panel.portfolio.convertBlurb')}
          </p>
        </div>
      )}

      {info?.is_portfolio && (
        <div className="flex flex-col gap-2" data-testid="portfolio-members">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium text-neutral-300" data-testid="portfolio-count">
              {tChromeCount('panel.portfolio.count', info.count)}
            </div>
            <button
              data-testid="portfolio-add"
              onClick={handleAddMember}
              disabled={busy}
              className="px-2.5 py-1 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded font-medium"
            >
              {tChrome('panel.portfolio.addFile')}
            </button>
          </div>
          {info.members.length === 0 ? (
            <p className="text-sm text-neutral-500" data-testid="portfolio-empty">
              {tChrome('panel.portfolio.empty')}
            </p>
          ) : (
            <div className="flex flex-col gap-1" data-testid="portfolio-list">
              {info.members.map((m) => (
                <div
                  key={m.name}
                  data-testid="portfolio-item"
                  className="flex items-center gap-2 px-3 py-2 bg-neutral-800/60 border border-neutral-800 rounded"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-neutral-200 truncate" title={m.name}>
                      {m.name}
                    </div>
                    <div className="text-xs text-neutral-500">
                      {human(m.size)}
                      {m.mime ? ` · ${m.mime}` : ''}
                      {m.description ? ` · ${m.description}` : ''}
                    </div>
                  </div>
                  {isPdfMember(m) ? (
                    <button
                      data-testid={`portfolio-open-${m.name}`}
                      onClick={() => handleOpenMember(m.name)}
                      disabled={busy}
                      className="px-2 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 disabled:opacity-50 rounded"
                    >
                      {tChrome('panel.portfolio.openBtn')}
                    </button>
                  ) : (
                    <button
                      data-testid={`portfolio-open-os-${m.name}`}
                      title={tChrome('panel.portfolio.openOsTitle')}
                      onClick={() => handleOpenMemberExternal(m.name)}
                      disabled={busy}
                      className="px-2 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 disabled:opacity-50 rounded"
                    >
                      {tChrome('panel.portfolio.openBtn')}
                    </button>
                  )}
                  <button
                    data-testid={`portfolio-save-${m.name}`}
                    onClick={() => handleSaveMember(m.name)}
                    disabled={busy}
                    className="px-2 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 disabled:opacity-50 rounded"
                  >
                    {tChrome('panel.portfolio.saveBtn')}
                  </button>
                  <button
                    data-testid={`portfolio-update-${m.name}`}
                    onClick={() => handleUpdateMember(m.name)}
                    disabled={busy}
                    className="px-2 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 disabled:opacity-50 rounded"
                    title={tChrome('panel.portfolio.updateTitle')}
                  >
                    {tChrome('panel.portfolio.updateBtn')}
                  </button>
                  <button
                    data-testid={`portfolio-remove-${m.name}`}
                    onClick={() => handleRemoveMember(m.name)}
                    disabled={busy}
                    className="px-2 py-1 text-xs text-neutral-400 hover:text-red-400 disabled:opacity-50"
                  >
                    {tChrome('panel.portfolio.removeBtn')}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="border-t border-neutral-800 pt-4">{createSection}</div>
      <StatusBar message={status} busy={busy} />
    </div>
  );
}

/**
 * "Opening a portfolio shows its members" (§ I.6): the first time a document
 * becomes the visible document this session, ask the engine whether it is a
 * portfolio and open the Portfolio panel if so. Mounted once in App; keyed on
 * the SHOWABLE file (the selectors' ghost-safe answer), once per path, so tab
 * switches and re-focuses don't re-trigger it. get_portfolio is an INTERNAL
 * (ungated) read — this must never flush pending page edits just because a
 * file was opened.
 */
export function PortfolioAutoOpen(): null {
  const { activeFile, state, dispatch } = useActiveFile();
  const { call } = useEngine();
  const checked = React.useRef<Set<string>>(new Set());

  // A CLOSED file leaves the checked set, so re-opening a portfolio later in
  // the session shows its members again — the set exists to stop tab-switch
  // re-triggers, not to make the story once-per-session.
  useEffect(() => {
    for (const path of checked.current) {
      if (!state.files.has(path)) checked.current.delete(path);
    }
  }, [state.files]);

  useEffect(() => {
    if (!activeFile || checked.current.has(activeFile.path)) return;
    checked.current.add(activeFile.path);
    const workingPath = activeFile.workingPath;
    let stale = false;
    void (async () => {
      try {
        const r = await call('get_portfolio', { file: workingPath });
        if (!stale && (r as unknown as PortfolioInfo).is_portfolio) {
          dispatch({ type: 'UI_OPEN_TOOL', toolId: 'portfolio' });
        }
      } catch {
        // Unreadable → not a portfolio as far as the shell is concerned.
      }
    })();
    return () => {
      stale = true;
    };
  }, [activeFile, call, dispatch]);

  return null;
}
