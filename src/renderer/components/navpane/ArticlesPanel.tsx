import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useEngine } from '../../hooks/useEngine';
import { useOperations } from '../../hooks/useOperations';
import { useAppDispatch, useAppState } from '../../state/AppStateProvider';
import { file } from '../../lib/tauri-bridge';
import { getCanvasServices } from '../../commands/context';
import {
  consumeDrawnBead,
  emptyArticle,
  moveBead,
  stepBead,
  subscribeDrawnBead,
  type Article,
  type DrawnBead,
} from '../../lib/article-beads';
import { TEST_HARNESS_ENABLED, registerCanvasArticles } from '../../testHarness';
import type { OpenFile, PdfBuffer } from '../../state/types';
import type { NavPanelComponentProps } from './types';
import { useTranslation } from 'react-i18next';
import { tChrome } from '../../i18n';

// Articles nav panel — the ONE article-thread surface: read the document's
// /Threads, author new ones by drawing boxes on the page, walk them
// bead by bead, and save.
//
// The panel owns a WORKING COPY of the article list; nothing reaches the
// document until Save, which is one `set_threads` call through the standard
// snapshot -> call -> UPDATE_FILE shape (so it is one undo step, like every
// other panel mutation). Drawing arms `beaddraw`, an ownerless canvas mode:
// the band is a request published through `article-beads`, exactly the
// Page Boxes crop handoff, and the panel disarms the mode when it unmounts so
// a mode cannot outlive the surface that armed it.

export function ArticlesPanel({ activeFile }: NavPanelComponentProps): React.ReactElement {
  useTranslation();
  const { call } = useEngine();
  const { confirmSignedEdit } = useOperations();
  const dispatch = useAppDispatch();
  const state = useAppState();
  const tool = state.ui.tool;
  const [articles, setArticles] = useState<Article[]>([]);
  // The buffer whose real /Threads populate `articles`. Buffer identity is a
  // timing-independent "is this list current for what is on disk?" signal —
  // the Bookmarks panel's rule, and for the same reason: every op that
  // rewrites the working file installs a new buffer.
  const [loadedBuffer, setLoadedBuffer] = useState<PdfBuffer | null>(null);
  const [selected, setSelected] = useState(0);
  const [bead, setBead] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const articlesRef = useRef(articles);
  articlesRef.current = articles;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const activeFileRef = useRef<OpenFile | null>(activeFile);
  activeFileRef.current = activeFile;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  // (Re)load when the shown file's bytes change to something the list does not
  // already reflect. An UNSAVED list is never reloaded over — a whole-file op
  // elsewhere must not silently discard boxes the user just drew; the panel
  // says so instead.
  useEffect(() => {
    if (!activeFile || activeFile.buffer == null) {
      setArticles([]);
      setLoadedBuffer(null);
      setDirty(false);
      return;
    }
    if (activeFile.buffer === loadedBuffer) return;
    if (dirtyRef.current) return;
    const targetBuffer = activeFile.buffer;
    let cancelled = false;
    call('list_threads', { file: activeFile.workingPath })
      .then((res) => {
        if (cancelled) return;
        if (activeFileRef.current?.buffer !== targetBuffer) return;
        const rows = ((res as unknown as { threads?: Article[] }).threads ?? []).map((t) => ({
          title: t.title ?? '',
          author: t.author ?? '',
          subject: t.subject ?? '',
          keywords: t.keywords ?? '',
          beads: (t.beads ?? []).map((b) => ({ page: b.page, rect: b.rect })),
        }));
        setArticles(rows);
        setLoadedBuffer(targetBuffer);
        setSelected(0);
        setBead(0);
        setStatus('');
      })
      .catch((e: unknown) =>
        setStatus(
          tChrome('panel.common.error', {
            message: e instanceof Error ? e.message : String(e),
          }),
        ),
      );
    return () => {
      cancelled = true;
    };
  }, [activeFile, loadedBuffer, call]);

  // A drawn box lands on the SELECTED article. The publish carries the file it
  // was drawn against, so a box drawn before a tab switch cannot be appended
  // to a different document's article.
  const appendBead = useCallback((drawn: DrawnBead) => {
    const target = activeFileRef.current;
    if (!target || drawn.path !== target.path) return;
    setArticles((prev) => {
      const list = prev.length > 0 ? prev : [emptyArticle(tChrome('nav.articles.untitled'))];
      const index = Math.min(selectedRef.current, list.length - 1);
      return list.map((article, i) =>
        i === index
          ? { ...article, beads: [...article.beads, { page: drawn.page, rect: drawn.rect }] }
          : article,
      );
    });
    setDirty(true);
    setStatus(tChrome('nav.articles.unsaved'));
  }, []);

  useEffect(() => {
    const pending = consumeDrawnBead();
    if (pending) appendBead(pending);
    return subscribeDrawnBead((drawn) => appendBead(drawn));
  }, [appendBead]);

  // The mode belongs to no tool, so this panel is what turns it off: leaving
  // the panel with `beaddraw` still armed would put a box-drawing cursor on a
  // document with no surface to receive the boxes.
  useEffect(
    () => () => {
      dispatch({ type: 'UI_SET_TOOL', tool: 'select' });
    },
    [dispatch],
  );

  const toggleDraw = useCallback(() => {
    dispatch({ type: 'UI_SET_TOOL', tool: tool === 'beaddraw' ? 'select' : 'beaddraw' });
  }, [dispatch, tool]);

  const addArticle = useCallback(() => {
    setArticles((prev) => {
      const next = [...prev, emptyArticle(tChrome('nav.articles.untitled'))];
      setSelected(next.length - 1);
      return next;
    });
    setBead(0);
    setDirty(true);
  }, []);

  const editArticle = useCallback((index: number, patch: Partial<Article>) => {
    setArticles((prev) => prev.map((a, i) => (i === index ? { ...a, ...patch } : a)));
    setDirty(true);
  }, []);

  const removeArticle = useCallback((index: number) => {
    setArticles((prev) => prev.filter((_, i) => i !== index));
    setSelected((s) => Math.max(0, s > index ? s - 1 : s));
    setBead(0);
    setDirty(true);
  }, []);

  const removeBead = useCallback((articleIndex: number, beadIndex: number) => {
    setArticles((prev) =>
      prev.map((a, i) =>
        i === articleIndex ? { ...a, beads: a.beads.filter((_, j) => j !== beadIndex) } : a,
      ),
    );
    setDirty(true);
  }, []);

  const shiftBead = useCallback((articleIndex: number, beadIndex: number, delta: number) => {
    setArticles((prev) =>
      prev.map((a, i) => (i === articleIndex ? { ...a, beads: moveBead(a.beads, beadIndex, delta) } : a)),
    );
    setDirty(true);
  }, []);

  const jumpToBead = useCallback(
    (articleIndex: number, beadIndex: number) => {
      const target = activeFileRef.current;
      const article = articlesRef.current[articleIndex];
      const box = article?.beads[beadIndex];
      if (!target || !box) return;
      setBead(beadIndex);
      // jumpToFilePage, not centerOn: a bead addresses a page of the FILE,
      // which may sit in a `.pdfx` partition the reading view is not showing.
      getCanvasServices()?.jumpToFilePage(target.path, box.page);
    },
    [],
  );

  const walk = useCallback(
    (delta: number) => {
      const article = articlesRef.current[selectedRef.current];
      if (!article || article.beads.length === 0) return;
      jumpToBead(selectedRef.current, stepBead(article.beads.length, bead, delta));
    },
    [bead, jumpToBead],
  );

  const save = useCallback(async () => {
    const target = activeFileRef.current;
    if (!target) return;
    setBusy(true);
    setStatus(tChrome('nav.articles.saving'));
    try {
      // `set_threads` rewrites the catalog's /Threads, which coalesces the
      // file — structural, whatever a certification permits. Asked before the
      // snapshot: `file.snapshot` runs the commit gate, so a decision taken
      // after it would have flushed pending page edits on the way to refusing.
      // Kept here rather than routed through `performOperation` because the
      // save advances `loadedBuffer` to the EXACT bytes it dispatched, which
      // is what stops the reload effect from self-reloading.
      if (!(await confirmSignedEdit(target.path, target.workingPath, 'structural'))) {
        setStatus('');
        return;
      }
      const snapshotPath = await file.snapshot(target.workingPath);
      await call('set_threads', {
        file: target.workingPath,
        output: target.workingPath,
        threads: articlesRef.current,
      });
      const buffer = await file.readBuffer(target.workingPath);
      dispatch({
        type: 'UPDATE_FILE',
        path: target.path,
        pageCount: target.pageCount,
        buffer,
        snapshotPath,
      });
      setLoadedBuffer(buffer);
      setDirty(false);
      setStatus('');
    } catch (e: unknown) {
      setStatus(
        tChrome('panel.common.error', {
          message: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setBusy(false);
    }
  }, [call, dispatch, confirmSignedEdit]);

  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    if (!TEST_HARNESS_ENABLED) return;
    registerCanvasArticles({
      list: () =>
        articlesRef.current.map((a) => ({
          title: a.title,
          beads: a.beads.map((b) => ({ page: b.page, rect: [...b.rect] as number[] })),
        })),
      addBead: (page, rect) => {
        appendBead({ page, rect: rect as [number, number, number, number], path: activeFileRef.current?.path ?? '' });
      },
      save: async () => {
        await saveRef.current();
      },
    });
    return () => registerCanvasArticles(null);
  }, [appendBead]);

  if (!activeFile) {
    return (
      <div className="navpanel-empty" data-testid="articles-panel">
        {tChrome('nav.common.noDocument')}
      </div>
    );
  }

  const current = articles[Math.min(selected, Math.max(articles.length - 1, 0))];

  return (
    <div className="articles-panel flex flex-col h-full min-h-0" data-testid="articles-panel">
      <div className="navpanel-scroll flex-1">
        <p className="navpanel-note" data-testid="articles-note">
          {tChrome('nav.articles.readerNote')}
        </p>
        {articles.length === 0 && (
          <p className="navpanel-empty" data-testid="articles-empty">
            {tChrome('nav.articles.empty')}
          </p>
        )}
        {articles.map((article, index) => (
          <div
            key={index}
            data-testid="article-row"
            className={'article-row' + (index === selected ? ' article-row-active' : '')}
          >
            <div className="article-head">
              <input
                type="radio"
                name="article-selected"
                checked={index === selected}
                onChange={() => {
                  setSelected(index);
                  setBead(0);
                }}
                aria-label={tChrome('nav.articles.select')}
              />
              <input
                data-testid="article-title"
                className="article-title-input"
                value={article.title}
                placeholder={tChrome('nav.articles.untitled')}
                onChange={(e) => editArticle(index, { title: e.target.value })}
              />
              <button
                data-testid="article-delete"
                className="bookmark-btn bookmark-btn-danger"
                title={tChrome('nav.articles.delete')}
                onClick={() => removeArticle(index)}
              >
                ×
              </button>
            </div>
            <div className="article-beads">
              {article.beads.length === 0 && (
                <span className="article-bead-empty">{tChrome('nav.articles.noBoxes')}</span>
              )}
              {article.beads.map((box, j) => (
                <div key={j} className="article-bead-row" data-testid="article-bead">
                  <button
                    className="article-bead-jump"
                    onClick={() => {
                      setSelected(index);
                      jumpToBead(index, j);
                    }}
                    title={tChrome('nav.articles.jumpToBox', { index: j + 1, page: box.page })}
                  >
                    {tChrome('nav.articles.boxLabel', { index: j + 1, page: box.page })}
                  </button>
                  <button
                    className="bookmark-btn"
                    title={tChrome('nav.articles.moveUp')}
                    onClick={() => shiftBead(index, j, -1)}
                  >
                    ↑
                  </button>
                  <button
                    className="bookmark-btn"
                    title={tChrome('nav.articles.moveDown')}
                    onClick={() => shiftBead(index, j, 1)}
                  >
                    ↓
                  </button>
                  <button
                    className="bookmark-btn bookmark-btn-danger"
                    title={tChrome('nav.articles.deleteBox')}
                    onClick={() => removeBead(index, j)}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="articles-footer">
        <button data-testid="article-add" onClick={addArticle} className="bookmark-add-btn">
          {tChrome('nav.articles.add')}
        </button>
        <button
          data-testid="article-draw"
          onClick={toggleDraw}
          className={'bookmark-add-btn' + (tool === 'beaddraw' ? ' is-armed' : '')}
          aria-pressed={tool === 'beaddraw'}
        >
          {tool === 'beaddraw' ? tChrome('nav.articles.drawing') : tChrome('nav.articles.draw')}
        </button>
        <button
          data-testid="article-prev"
          onClick={() => walk(-1)}
          disabled={!current || current.beads.length === 0}
          className="bookmark-add-btn disabled:opacity-60"
          title={tChrome('nav.articles.previousBox')}
        >
          ‹
        </button>
        <button
          data-testid="article-next"
          onClick={() => walk(1)}
          disabled={!current || current.beads.length === 0}
          className="bookmark-add-btn disabled:opacity-60"
          title={tChrome('nav.articles.nextBox')}
        >
          ›
        </button>
        <button
          data-testid="article-save"
          onClick={() => void save()}
          disabled={busy || !dirty}
          className="bookmark-add-btn disabled:opacity-60"
        >
          {tChrome('nav.articles.save')}
        </button>
        {status && <span className="bookmark-status">{status}</span>}
      </div>
    </div>
  );
}
