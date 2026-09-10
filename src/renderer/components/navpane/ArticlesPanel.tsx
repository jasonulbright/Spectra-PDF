import React, { useCallback, useEffect, useRef } from 'react';
import { useEngine } from '../../hooks/useEngine';
import { useOperations } from '../../hooks/useOperations';
import { useAppDispatch, useAppState, useArticleDrafts } from '../../state/AppStateProvider';
import { getCanvasServices } from '../../commands/context';
import {
  consumeDrawnBead, emptyArticle, moveBead, stepBead, subscribeDrawnBead,
  type Article, type DrawnBead,
} from '../../lib/article-beads';
import { TEST_HARNESS_ENABLED, registerCanvasArticles } from '../../testHarness';
import type { NavPanelComponentProps } from './types';
import { useTranslation } from 'react-i18next';
import { tChrome } from '../../i18n';

// Draft lifetime is the open document's working session, not this mounted
// panel. Every callback captures that draft, never a list plus a new target.
export function ArticlesPanel({ activeFile }: NavPanelComponentProps): React.ReactElement {
  useTranslation();
  const { call } = useEngine();
  const { performOperation } = useOperations();
  const dispatch = useAppDispatch();
  const state = useAppState();
  const drafts = useArticleDrafts();
  const draft = drafts.get(activeFile);
  const draftRef = useRef(draft); draftRef.current = draft;
  const tool = state.ui.tool;
  const articles = draft?.articles ?? [];
  const selected = draft?.selected ?? 0;
  const bead = draft?.bead ?? 0;
  const dirty = draft?.dirty ?? false;
  const busy = draft?.busy ?? false;
  const editable = !!draft && drafts.editable(draft);
  const conflict = !!draft?.dirty && !drafts.current(draft);
  const status = busy ? tChrome('nav.articles.saving')
    : conflict ? tChrome('nav.articles.sourceChanged')
    : draft?.error ? tChrome('panel.common.error', { message: draft.error })
    : draft?.loading ? tChrome('dialog.common.loading')
    : dirty ? tChrome('nav.articles.unsaved') : '';

  // load() is idempotent while pending and only a clean, stale draft reloads.
  // Cleanup invalidates a read even when useEngine's listener unmounts.
  useEffect(() => { if (draft) void drafts.load(draft, call); });
  useEffect(() => () => { if (draft) drafts.cancelLoad(draft); }, [draft, drafts]);

  const appendBead = useCallback((drawn: DrawnBead) => {
    const target = draftRef.current;
    if (target) drafts.append(target, drawn, () => emptyArticle(tChrome('nav.articles.untitled')));
  }, [drafts]);
  useEffect(() => {
    const pending = consumeDrawnBead();
    if (pending) appendBead(pending);
    return subscribeDrawnBead(appendBead);
  }, [appendBead]);
  useEffect(() => () => { dispatch({ type: 'UI_SET_TOOL', tool: 'select' }); }, [dispatch]);
  useEffect(() => {
    if (!editable && tool === 'beaddraw') dispatch({ type: 'UI_SET_TOOL', tool: 'select' });
  }, [editable, tool, dispatch]);
  const toggleDraw = useCallback(() => {
    if (editable) dispatch({ type: 'UI_SET_TOOL', tool: tool === 'beaddraw' ? 'select' : 'beaddraw' });
  }, [dispatch, tool, editable]);

  const setSelected = (index: number) => { if (draft) drafts.select(draft, index, 0); };
  const setBead = (index: number) => { if (draft) drafts.select(draft, draft.selected, index); };
  const addArticle = () => {
    if (draft) drafts.change(draft, prev => {
      draft.selected = prev.length; draft.bead = 0;
      return [...prev, emptyArticle(tChrome('nav.articles.untitled'))];
    });
  };
  const editArticle = (index: number, patch: Partial<Article>) => {
    if (draft) drafts.change(draft, prev => prev.map((a, i) => i === index ? { ...a, ...patch } : a));
  };
  const removeArticle = (index: number) => {
    if (draft) drafts.change(draft, prev => {
      draft.selected = Math.max(0, draft.selected > index ? draft.selected - 1 : draft.selected);
      draft.bead = 0; return prev.filter((_, i) => i !== index);
    });
  };
  const removeBead = (index: number, beadIndex: number) => {
    if (draft) drafts.change(draft, prev => prev.map((a, i) => i === index
      ? { ...a, beads: a.beads.filter((_, j) => j !== beadIndex) } : a));
  };
  const shiftBead = (index: number, beadIndex: number, delta: number) => {
    if (draft) drafts.change(draft, prev => prev.map((a, i) => i === index
      ? { ...a, beads: moveBead(a.beads, beadIndex, delta) } : a));
  };
  const jumpToBead = (index: number, beadIndex: number) => {
    const box = draft?.articles[index]?.beads[beadIndex];
    if (!draft || !drafts.current(draft) || !box) return;
    drafts.select(draft, index, beadIndex);
    getCanvasServices()?.jumpToFilePage(draft.path, box.page);
  };
  const walk = (delta: number) => {
    const article = articles[selected];
    if (article?.beads.length) jumpToBead(selected, stepBead(article.beads.length, bead, delta));
  };
  const save = useCallback(async () => {
    if (draft) await drafts.save(draft, performOperation);
  }, [draft, drafts, performOperation]);
  const saveRef = useRef(save); saveRef.current = save;
  useEffect(() => {
    if (!TEST_HARNESS_ENABLED) return;
    registerCanvasArticles({
      list: () => (draftRef.current?.articles ?? []).map(a => ({
        title: a.title, beads: a.beads.map(b => ({ page: b.page, rect: [...b.rect] })),
      })),
      addBead: (page, rect) => {
        const d = draftRef.current;
        if (d?.buffer) appendBead({ page, rect: rect as [number, number, number, number],
          path: d.path, workingPath: d.workingPath, buffer: d.buffer });
      },
      save: async () => { await saveRef.current(); },
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
        {draft?.loaded && !draft.loading && !conflict && articles.length === 0 && (
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
                readOnly={!editable}
                className="article-title-input"
                value={article.title}
                placeholder={tChrome('nav.articles.untitled')}
                onChange={(e) => editArticle(index, { title: e.target.value })}
              />
              <button
                data-testid="article-delete"
                disabled={!editable}
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
                    disabled={!editable}
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
                    disabled={!editable}
                    title={tChrome('nav.articles.moveUp')}
                    onClick={() => shiftBead(index, j, -1)}
                  >
                    ↑
                  </button>
                  <button
                    className="bookmark-btn"
                    disabled={!editable}
                    title={tChrome('nav.articles.moveDown')}
                    onClick={() => shiftBead(index, j, 1)}
                  >
                    ↓
                  </button>
                  <button
                    className="bookmark-btn bookmark-btn-danger"
                    disabled={!editable}
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
        <button data-testid="article-add" disabled={!editable} onClick={addArticle} className="bookmark-add-btn">
          {tChrome('nav.articles.add')}
        </button>
        <button
          data-testid="article-draw"
          disabled={!editable}
          onClick={toggleDraw}
          className={'bookmark-add-btn' + (tool === 'beaddraw' ? ' is-armed' : '')}
          aria-pressed={tool === 'beaddraw'}
        >
          {tool === 'beaddraw' ? tChrome('nav.articles.drawing') : tChrome('nav.articles.draw')}
        </button>
        <button
          data-testid="article-prev"
          onClick={() => walk(-1)}
          disabled={!editable || !current || current.beads.length === 0}
          className="bookmark-add-btn disabled:opacity-60"
          title={tChrome('nav.articles.previousBox')}
        >
          ‹
        </button>
        <button
          data-testid="article-next"
          onClick={() => walk(1)}
          disabled={!editable || !current || current.beads.length === 0}
          className="bookmark-add-btn disabled:opacity-60"
          title={tChrome('nav.articles.nextBox')}
        >
          ›
        </button>
        <button
          data-testid="article-save"
          onClick={() => void save()}
          disabled={busy || !dirty || !editable}
          className="bookmark-add-btn disabled:opacity-60"
        >
          {tChrome('nav.articles.save')}
        </button>
        {draft && (conflict || draft.error) && <button
          data-testid="article-reload" disabled={busy}
          onClick={() => drafts.reset(draft)} className="bookmark-add-btn">
          {dirty ? tChrome('nav.articles.discardReload') : tChrome('app.commit.retry')}
        </button>}
        {status && <span data-testid="article-status" className="bookmark-status">{status}</span>}
      </div>
    </div>
  );
}
