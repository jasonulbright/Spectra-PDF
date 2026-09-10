import React, { createContext, useContext, useEffect, useState, useSyncExternalStore, type Dispatch } from 'react';
import { AppState, AppAction } from './types';
import { initialState } from './reducer';
import { createAppStore } from './store';
import { readRecent } from '../lib/recent-files';
import { readWorkbenchUi } from '../lib/workbench-ui';
import { readToolbarOverrides } from '../lib/toolbar-layout';
import { createArticleDrafts, type ArticleDrafts } from '../lib/article-drafts';
import { createLinkDrafts, type LinkDrafts } from '../lib/link-drafts';
import { createFormDrafts, type FormDrafts } from '../lib/form-drafts';
import { createBookmarkDrafts, type BookmarkDrafts } from '../lib/bookmark-drafts';
import { registerFileSaveBarrier } from '../lib/file-save-barrier';
import { createPageLabelDrafts, type PageLabelDrafts } from '../lib/page-label-drafts';
import { createDocumentJsDrafts, type DocumentJsDrafts } from '../lib/document-js-drafts';
import { createLayerSessions, type LayerSessions } from '../lib/layer-session';
import { consumeDrawnLink, consumePickedLink, subscribeDrawnLink, subscribePickedLink } from '../lib/links';

const StateContext = createContext<AppState>(initialState);
const DispatchContext = createContext<Dispatch<AppAction>>(() => {});
const ReadContext = createContext<() => AppState>(() => initialState);
const ArticleDraftContext = createContext<ArticleDrafts | null>(null);
const LinkDraftContext = createContext<LinkDrafts | null>(null);
const FormDraftContext = createContext<FormDrafts | null>(null);
const BookmarkDraftContext = createContext<BookmarkDrafts | null>(null);
const PageLabelDraftContext = createContext<PageLabelDrafts | null>(null);
const DocumentJsDraftContext = createContext<DocumentJsDrafts | null>(null);
const LayerSessionContext = createContext<LayerSessions | null>(null);

// Boot lands on Home unless something is being opened (shell-open/CLI/tray
// flows focus their doc tab themselves) — Home is a tab you leave, not a
// gate you disable, so `spectra-skip-welcome` is no longer read (keys are
// never repurposed). Recent files hydrate from the same
// `spectra-recent` key App has always persisted. Lazy so the reads happen
// once per mount, not per render.
function bootState(base: AppState): AppState {
  // Hydrate persisted chrome state through the validated readers, so a corrupt
  // entry can't propagate a bad shape into state (recent-files precedent):
  // readRecent (spectra-recent) and readWorkbenchUi (workbench-ui, nav pane).
  const recentFiles = readRecent();
  const { navPane, toolDock, toolLock } = readWorkbenchUi({
    navPane: base.ui.navPane,
    toolDock: base.ui.toolDock,
    toolLock: base.ui.toolLock,
  });
  const toolbarOverrides = readToolbarOverrides();
  return {
    ...base,
    ui: { ...base.ui, recentFiles, navPane, toolDock, toolLock, toolbarOverrides },
  };
}

export function AppStateProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [store] = useState(() => createAppStore(bootState(initialState)));
  const [articleDrafts] = useState(() => {
    const drafts = createArticleDrafts(store.getState);
    store.subscribe(drafts.reconcile);
    return drafts;
  });
  const [formDrafts] = useState(() => {
    const drafts = createFormDrafts(store.getState);
    store.subscribe(drafts.reconcile);
    return drafts;
  });
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const [bookmarkDrafts] = useState(() => {
    const drafts = createBookmarkDrafts(store.getState);
    store.subscribe(drafts.reconcile);
    return drafts;
  });
  const [pageLabelDrafts] = useState(() => {
    const drafts = createPageLabelDrafts(store.getState);
    store.subscribe(drafts.reconcile);
    return drafts;
  });
  useEffect(() => registerFileSaveBarrier(bookmarkDrafts.beforeSave), [bookmarkDrafts]);
  const [linkDrafts] = useState(() => {
    const drafts = createLinkDrafts(store.getState);
    store.subscribe(drafts.reconcile);
    return drafts;
  });
  const [documentJsDrafts] = useState(() => {
    const drafts = createDocumentJsDrafts(store.getState);
    store.subscribe(drafts.reconcile);
    return drafts;
  });
  const [layerSessions] = useState(() => {
    const sessions = createLayerSessions(store.getState);
    store.subscribe(sessions.reconcile);
    return sessions;
  });
  useEffect(() => {
    const drawn = consumeDrawnLink(), picked = consumePickedLink();
    if (drawn) linkDrafts.receiveDraw(drawn);
    if (picked) linkDrafts.receivePick(picked);
    const offDraw = subscribeDrawnLink(linkDrafts.receiveDraw), offPick = subscribePickedLink(linkDrafts.receivePick);
    return () => { offDraw(); offPick(); };
  }, [linkDrafts]);
  return (
    <StateContext.Provider value={state}>
      <DispatchContext.Provider value={store.dispatch}>
        <ReadContext.Provider value={store.getState}>
          <ArticleDraftContext.Provider value={articleDrafts}>
            <LinkDraftContext.Provider value={linkDrafts}>
              <FormDraftContext.Provider value={formDrafts}>
                <BookmarkDraftContext.Provider value={bookmarkDrafts}>
                  <PageLabelDraftContext.Provider value={pageLabelDrafts}>
                    <DocumentJsDraftContext.Provider value={documentJsDrafts}>
                      <LayerSessionContext.Provider value={layerSessions}>{children}</LayerSessionContext.Provider>
                    </DocumentJsDraftContext.Provider>
                  </PageLabelDraftContext.Provider>
                </BookmarkDraftContext.Provider>
              </FormDraftContext.Provider>
            </LinkDraftContext.Provider>
          </ArticleDraftContext.Provider>
        </ReadContext.Provider>
      </DispatchContext.Provider>
    </StateContext.Provider>
  );
}

export function useAppState(): AppState {
  return useContext(StateContext);
}

export function useAppDispatch(): Dispatch<AppAction> {
  return useContext(DispatchContext);
}

export function useBookmarkDrafts(): BookmarkDrafts {
  const drafts = useContext(BookmarkDraftContext);
  if (!drafts) throw new Error('Bookmark draft provider is missing');
  useSyncExternalStore(drafts.subscribe, drafts.snapshot, drafts.snapshot);
  return drafts;
}
export function usePageLabelDrafts(): PageLabelDrafts {
  const drafts = useContext(PageLabelDraftContext);
  if (!drafts) throw new Error('Page label draft provider is missing');
  useSyncExternalStore(drafts.subscribe, drafts.snapshot, drafts.snapshot);
  return drafts;
}

export function useReadAppState(): () => AppState {
  return useContext(ReadContext);
}
export function useDocumentJsDrafts(): DocumentJsDrafts {
  const drafts = useContext(DocumentJsDraftContext);
  if (!drafts) throw new Error('Document JavaScript draft provider is missing');
  useSyncExternalStore(drafts.subscribe, drafts.snapshot, drafts.snapshot);
  return drafts;
}
export function useLayerSessions(): LayerSessions {
  const sessions = useContext(LayerSessionContext);
  if (!sessions) throw new Error('Layer session provider is missing');
  useSyncExternalStore(sessions.subscribe, sessions.snapshot, sessions.snapshot);
  return sessions;
}

export function useArticleDrafts(): ArticleDrafts {
  const drafts = useContext(ArticleDraftContext);
  if (!drafts) throw new Error('Article draft provider is missing');
  useSyncExternalStore(drafts.subscribe, drafts.snapshot, drafts.snapshot);
  return drafts;
}

export function useReadLinkDrafts(): LinkDrafts {
  const drafts = useContext(LinkDraftContext);
  if (!drafts) throw new Error('Link draft provider is missing');
  return drafts;
}
export function useLinkDrafts(): LinkDrafts {
  const drafts = useReadLinkDrafts();
  useSyncExternalStore(drafts.subscribe, drafts.snapshot, drafts.snapshot);
  return drafts;
}
export function useFormDrafts(): FormDrafts {
  const drafts = useContext(FormDraftContext);
  if (!drafts) throw new Error('Form draft provider is missing');
  useSyncExternalStore(drafts.subscribe, drafts.snapshot, drafts.snapshot);
  return drafts;
}
