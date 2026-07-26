import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { file } from '../lib/tauri-bridge';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import { getDocumentProxy } from '../lib/pdfDocCache';
import { mergeUntouched } from '../lib/late-read';
import {
  STANDARD_STRUCT_TYPES,
  pathKey,
  nodePreview,
  pageMcidText,
  subtreePages,
  type StructNode,
  type StructTree,
} from '../lib/struct-tree';

// The Tags panel (§ I.6) — the structure-tree editor. View the tag tree,
// retag/retitle/set alt text, reorder (up/down) and renest (indent/outdent),
// create empty tags, and delete tags (content stays; it becomes untagged).
// Reading order for one page at a time lives next door in Reading Order.

const EMPTY_DRAFT = { type: '', title: '', alt: '', actual_text: '', lang: '' };
type Draft = typeof EMPTY_DRAFT;

function findByKey(nodes: StructNode[], key: string): StructNode | null {
  for (const n of nodes) {
    if (pathKey(n.path) === key) return n;
    const hit = findByKey(n.children, key);
    if (hit) return hit;
  }
  return null;
}

function draftOf(node: StructNode): Draft {
  return {
    type: node.type,
    title: node.title,
    alt: node.alt,
    actual_text: node.actual_text,
    lang: node.lang,
  };
}

export function TagsPanel(): React.ReactElement {
  const { activeFile, openNewFiles, dispatch } = useActiveFile();
  const { call } = useEngine();
  const [tree, setTree] = useState<StructTree | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [newType, setNewType] = useState('P');
  const [texts, setTexts] = useState<Map<number, Map<number, string>>>(() => new Map());
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  // Expansion is seeded once per document (path), then user-owned — mutations
  // swap the buffer on every edit, so buffer identity can't key the seeding.
  const seededFor = useRef<string | null>(null);
  const pendingSelect = useRef<string | null>(null);
  // Which tag the draft was last seeded for — distinguishes "the user picked a
  // different tag" (always reseed) from "the tree was re-read" (protect typing).
  const seededKeyRef = useRef<string | null>(null);

  const buffer = activeFile?.buffer ?? null;
  const workingPath = activeFile?.workingPath ?? null;
  const path = activeFile?.path ?? null;

  const refresh = useCallback(async () => {
    if (!workingPath) return;
    try {
      const res = (await call('get_struct_tree', { file: workingPath })) as unknown as StructTree;
      setTree(res);
      if (seededFor.current !== workingPath) {
        seededFor.current = workingPath;
        const seed = new Set<string>();
        const walk = (nodes: StructNode[]) => {
          for (const n of nodes) {
            if (n.path.length <= 2) {
              seed.add(pathKey(n.path));
              walk(n.children);
            }
          }
        };
        walk(res.root);
        setExpanded(seed);
      }
      const wanted = pendingSelect.current;
      pendingSelect.current = null;
      const next = wanted ?? selectedKeyRef.current;
      setSelectedKey(next !== null && findByKey(res.root, next) ? next : null);
    } catch {
      setTree(null);
    }
  }, [workingPath, call]);

  // The selection the refresh should try to keep, without making refresh
  // depend on selection state (that would refetch on every row click).
  const selectedKeyRef = useRef<string | null>(null);
  selectedKeyRef.current = selectedKey;

  useEffect(() => {
    if (!buffer || !workingPath) {
      setTree(null);
      setSelectedKey(null);
      return;
    }
    setTexts(new Map()); // page text is per buffer — an edit invalidates it
    void refresh();
  }, [buffer, workingPath, refresh]);

  const selected = tree && selectedKey !== null ? findByKey(tree.root, selectedKey) : null;

  // Draft fields the user has typed into since the draft was last seeded. The
  // tree is re-read on every buffer change, and this effect seeds the draft
  // FROM the tree — so a refresh landing mid-edit used to silently revert the
  // alt text (or type, or language) someone was half way through typing, after
  // which Apply reported "No changes to apply". Same class as the page-labels
  // data loss, one severity down: the document is safe because Apply diffs
  // against the node, but the user's work was not. See `lib/late-read.ts`.
  const touchedDraft = useRef<Set<string>>(new Set());
  useEffect(() => {
    // A NEW selection is always seeded outright — it is a different tag, so
    // there is no in-progress edit of it to protect. Only a same-selection
    // reseed (a tree refresh) has to respect what is being typed.
    const keyChanged = seededKeyRef.current !== selectedKey;
    seededKeyRef.current = selectedKey;
    const base = selected ? draftOf(selected) : EMPTY_DRAFT;
    if (keyChanged) {
      touchedDraft.current.clear();
      setDraft(base);
      return;
    }
    setDraft((prev) => mergeUntouched(base, prev, touchedDraft.current));
  }, [selectedKey, tree]); // eslint-disable-line react-hooks/exhaustive-deps

  // Every draft input goes through this, so "touched" means exactly "the user
  // typed here" — not "state changed", which a reseed also does.
  const editDraft = useCallback((patch: Partial<Draft>) => {
    for (const key of Object.keys(patch)) touchedDraft.current.add(key);
    setDraft((d) => ({ ...d, ...patch }));
  }, []);

  // Fetch MCID text for the SELECTED node's pages (bounded by its own direct
  // content — the Reading Order panel is the whole-page preview surface).
  useEffect(() => {
    if (!selected || !path || !buffer) return;
    const pages = [
      ...new Set(
        selected.content
          .filter((c) => typeof c.page === 'number' && typeof c.mcid === 'number')
          .map((c) => c.page as number),
      ),
    ].filter((p) => !texts.has(p));
    if (pages.length === 0) return;
    let stale = false;
    void (async () => {
      try {
        const proxy = await getDocumentProxy(path, buffer);
        for (const pageNo of pages) {
          const map = await pageMcidText(proxy, pageNo);
          if (stale) return;
          setTexts((prev) => new Map(prev).set(pageNo, map));
        }
      } catch {
        // no preview — the tree stays fully usable without it
      }
    })();
    return () => {
      stale = true;
    };
  }, [selected, path, buffer, texts]);

  const runMutation = useCallback(
    async (
      method: string,
      params: Record<string, unknown>,
      done: string,
      reselect: string | null,
    ) => {
      if (!activeFile) return;
      setBusy(true);
      setStatus('Working…');
      pendingSelect.current = reselect;
      // The refresh this mutation triggers SHOULD resync the draft: the values
      // are being written, so the tree that comes back is the new truth.
      touchedDraft.current.clear();
      try {
        const snapshotPath = await file.snapshot(activeFile.workingPath);
        await call(method, { file: activeFile.workingPath, output: activeFile.workingPath, ...params });
        const buf = await file.readBuffer(activeFile.workingPath);
        const info = await call('get_page_count', { file: activeFile.workingPath });
        dispatch({ type: 'UPDATE_FILE', path: activeFile.path, pageCount: info.pages, buffer: buf, snapshotPath });
        setStatus(done);
      } catch (e: unknown) {
        pendingSelect.current = null;
        setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setBusy(false);
      }
    },
    [activeFile, call, dispatch],
  );

  const applyProps = useCallback(() => {
    if (!selected) return;
    const props: Record<string, string> = {};
    const before = draftOf(selected);
    for (const key of Object.keys(EMPTY_DRAFT) as (keyof Draft)[]) {
      if (draft[key] !== before[key]) props[key] = draft[key];
    }
    if (Object.keys(props).length === 0) {
      setStatus('No changes to apply');
      return;
    }
    if ('type' in props && !props.type.trim()) {
      setStatus('The tag type must not be empty');
      return;
    }
    void runMutation(
      'set_struct_props',
      { path: selected.path, props },
      'Tag updated',
      pathKey(selected.path),
    );
  }, [selected, draft, runMutation]);

  const move = useCallback(
    (direction: 'up' | 'down' | 'indent' | 'outdent') => {
      if (!selected || !tree) return;
      const p = selected.path;
      const last = p[p.length - 1];
      let after: number[] | null;
      if (direction === 'up') after = [...p.slice(0, -1), last - 1];
      else if (direction === 'down') after = [...p.slice(0, -1), last + 1];
      else if (direction === 'outdent') after = [...p.slice(0, -2), p[p.length - 2] + 1];
      else {
        // Nested under the previous sibling, as its last child.
        const prev = findByKey(tree.root, pathKey([...p.slice(0, -1), last - 1]));
        after = prev ? [...prev.path, prev.children.length] : null;
      }
      void runMutation(
        'move_struct_node',
        { path: p, direction },
        'Tag moved',
        after ? pathKey(after) : null,
      );
    },
    [selected, tree, runMutation],
  );

  const addTag = useCallback(() => {
    const parent = selected ? selected.path : [];
    const key = selected ? pathKey(selected.path) : null;
    if (key !== null) setExpanded((prev) => new Set(prev).add(key));
    void runMutation(
      'add_struct_node',
      { parent_path: parent, stype: newType },
      `${newType} tag added`,
      // The engine appends: the new node's child index is the parent's
      // current child count.
      pathKey([...parent, selected ? selected.children.length : (tree?.root.length ?? 0)]),
    );
  }, [selected, newType, tree, runMutation]);

  const deleteTag = useCallback(() => {
    if (!selected) return;
    void runMutation(
      'delete_struct_node',
      { path: selected.path },
      'Tag deleted (its content is now untagged)',
      null,
    );
  }, [selected, runMutation]);

  if (!activeFile) return <NoFileOpen onOpen={openNewFiles} message="Open a PDF to edit its structure tags" />;

  const siblingCount = (p: number[]): number => {
    if (!tree) return 0;
    if (p.length === 1) return tree.root.length;
    const parent = findByKey(tree.root, pathKey(p.slice(0, -1)));
    return parent ? parent.children.length : 0;
  };

  const renderNode = (node: StructNode): React.ReactElement => {
    const key = pathKey(node.path);
    const isOpen = expanded.has(key);
    const isSelected = key === selectedKey;
    const pages = subtreePages(node);
    return (
      <li key={key}>
        <div
          className={
            'flex items-center gap-1 rounded px-1 py-0.5 ' +
            (isSelected ? 'bg-blue-600/30 border border-blue-500/60' : 'border border-transparent')
          }
          data-testid={`tag-row-${key}`}
        >
          {node.children.length > 0 ? (
            <button
              type="button"
              data-testid={`tag-toggle-${key}`}
              aria-expanded={isOpen}
              aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${node.type}`}
              onClick={() =>
                setExpanded((prev) => {
                  const next = new Set(prev);
                  if (isOpen) next.delete(key);
                  else next.add(key);
                  return next;
                })
              }
              className="w-4 text-neutral-400 hover:text-neutral-200 shrink-0"
            >
              {isOpen ? '▾' : '▸'}
            </button>
          ) : (
            <span className="w-4 shrink-0" />
          )}
          <button
            type="button"
            data-testid={`tag-select-${key}`}
            aria-pressed={isSelected}
            onClick={() => setSelectedKey(key)}
            className="flex-1 min-w-0 flex items-center gap-2 text-left"
          >
            <span className="text-sm text-neutral-200">&lt;{node.type}&gt;</span>
            {node.title && <span className="text-xs text-neutral-400 truncate">{node.title}</span>}
            {node.alt && (
              <span className="text-xs text-emerald-500/80" title={`Alt text: ${node.alt}`}>
                alt
              </span>
            )}
            {pages.length > 0 && (
              <span className="text-xs text-neutral-500 shrink-0">
                p{pages.length === 1 ? pages[0] : `${pages[0]}–${pages[pages.length - 1]}`}
              </span>
            )}
          </button>
        </div>
        {isOpen && node.children.length > 0 && (
          <ul className="pl-4 border-l border-neutral-800 ml-2 flex flex-col gap-0.5">
            {node.children.map(renderNode)}
          </ul>
        )}
      </li>
    );
  };

  const last = selected ? selected.path[selected.path.length - 1] : 0;
  const mapped = selected && tree ? tree.role_map[selected.type] : undefined;

  return (
    <div className="flex flex-col gap-4 h-full min-h-0">
      <div className="text-sm text-neutral-400 shrink-0">
        Working on: <span className="text-neutral-200">{activeFile.name}</span>
      </div>
      {!tree || !tree.tagged ? (
        <p className="text-sm text-neutral-500" data-testid="tags-untagged">
          This document has no structure tags. Tag editing needs a tagged PDF — tags are what
          assistive technology reads, and this file was produced without them.
        </p>
      ) : (
        <div className="flex flex-col gap-3 flex-1 min-h-0">
          <div className="flex items-center gap-2 shrink-0">
            <div className="text-sm text-neutral-300" data-testid="tags-summary">
              {tree.count} tag{tree.count === 1 ? '' : 's'}
            </div>
            <div className="flex-1" />
            <select
              data-testid="tags-new-type"
              value={newType}
              onChange={(e) => setNewType(e.target.value)}
              disabled={busy}
              aria-label="Type for the new tag"
              className="px-1 py-0.5 bg-neutral-900 border border-neutral-700 rounded text-xs"
            >
              {STANDARD_STRUCT_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
            <button
              type="button"
              data-testid="tags-new"
              onClick={addTag}
              disabled={busy}
              title={selected ? `Add an empty child tag under <${selected.type}>` : 'Add an empty top-level tag'}
              className="px-2 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 disabled:opacity-50 rounded"
            >
              {selected ? 'New child' : 'New tag'}
            </button>
          </div>
          <ul className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-0.5" data-testid="tags-tree">
            {tree.root.map(renderNode)}
          </ul>
          {selected && (
            <div
              className="shrink-0 flex flex-col gap-2 p-3 bg-neutral-800/60 border border-neutral-800 rounded"
              data-testid="tag-detail"
            >
              <div className="flex items-center gap-1">
                <span className="text-sm text-neutral-200 flex-1">
                  &lt;{selected.type}&gt;{mapped ? ` — maps to ${mapped}` : ''}
                </span>
                <button type="button" data-testid="tags-move-up" onClick={() => move('up')}
                  disabled={busy || last === 0}
                  title="Move before the previous sibling" aria-label="Move up"
                  className="px-1.5 py-0.5 text-xs bg-neutral-700 hover:bg-neutral-600 disabled:opacity-40 rounded">↑</button>
                <button type="button" data-testid="tags-move-down" onClick={() => move('down')}
                  disabled={busy || last >= siblingCount(selected.path) - 1}
                  title="Move after the next sibling" aria-label="Move down"
                  className="px-1.5 py-0.5 text-xs bg-neutral-700 hover:bg-neutral-600 disabled:opacity-40 rounded">↓</button>
                <button type="button" data-testid="tags-move-out" onClick={() => move('outdent')}
                  disabled={busy || selected.path.length < 2}
                  title="Move out — becomes the parent's next sibling" aria-label="Outdent"
                  className="px-1.5 py-0.5 text-xs bg-neutral-700 hover:bg-neutral-600 disabled:opacity-40 rounded">⇤</button>
                <button type="button" data-testid="tags-move-in" onClick={() => move('indent')}
                  disabled={busy || last === 0}
                  title="Nest under the previous sibling" aria-label="Indent"
                  className="px-1.5 py-0.5 text-xs bg-neutral-700 hover:bg-neutral-600 disabled:opacity-40 rounded">⇥</button>
                <button type="button" data-testid="tags-delete" onClick={deleteTag}
                  disabled={busy}
                  title="Delete this tag and its child tags — the page content stays, untagged"
                  className="px-2 py-0.5 text-xs text-neutral-400 hover:text-red-400 disabled:opacity-40">
                  Delete
                </button>
              </div>
              {(() => {
                const preview = nodePreview(selected, texts);
                return preview ? (
                  <div className="text-xs text-neutral-400 italic truncate" data-testid="tag-preview" title={preview}>
                    “{preview}”
                  </div>
                ) : null;
              })()}
              <div className="grid grid-cols-2 gap-2">
                <label className="flex flex-col gap-0.5 text-xs text-neutral-400">
                  Type
                  <input data-testid="tag-type-input" type="text" list="struct-types" value={draft.type}
                    onChange={(e) => editDraft({ type: e.target.value })}
                    onKeyDown={(e) => { if (e.key === 'Enter') applyProps(); }}
                    className="px-2 py-1 bg-neutral-900 border border-neutral-700 rounded text-sm text-neutral-200" />
                </label>
                <label className="flex flex-col gap-0.5 text-xs text-neutral-400">
                  Title
                  <input data-testid="tag-title-input" type="text" value={draft.title}
                    onChange={(e) => editDraft({ title: e.target.value })}
                    onKeyDown={(e) => { if (e.key === 'Enter') applyProps(); }}
                    className="px-2 py-1 bg-neutral-900 border border-neutral-700 rounded text-sm text-neutral-200" />
                </label>
                <label className="flex flex-col gap-0.5 text-xs text-neutral-400 col-span-2">
                  Alt text (what assistive technology reads for a figure)
                  <input data-testid="tag-alt-input" type="text" value={draft.alt}
                    onChange={(e) => editDraft({ alt: e.target.value })}
                    onKeyDown={(e) => { if (e.key === 'Enter') applyProps(); }}
                    className="px-2 py-1 bg-neutral-900 border border-neutral-700 rounded text-sm text-neutral-200" />
                </label>
                <label className="flex flex-col gap-0.5 text-xs text-neutral-400">
                  Actual text
                  <input data-testid="tag-actualtext-input" type="text" value={draft.actual_text}
                    onChange={(e) => editDraft({ actual_text: e.target.value })}
                    onKeyDown={(e) => { if (e.key === 'Enter') applyProps(); }}
                    className="px-2 py-1 bg-neutral-900 border border-neutral-700 rounded text-sm text-neutral-200" />
                </label>
                <label className="flex flex-col gap-0.5 text-xs text-neutral-400">
                  Language (e.g. en-US)
                  <input data-testid="tag-lang-input" type="text" value={draft.lang}
                    onChange={(e) => editDraft({ lang: e.target.value })}
                    onKeyDown={(e) => { if (e.key === 'Enter') applyProps(); }}
                    className="px-2 py-1 bg-neutral-900 border border-neutral-700 rounded text-sm text-neutral-200" />
                </label>
              </div>
              <datalist id="struct-types">
                {STANDARD_STRUCT_TYPES.map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
              <div>
                <button type="button" data-testid="tags-apply" onClick={applyProps} disabled={busy}
                  className="px-3 py-1 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded">
                  Apply
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      <StatusBar message={status} busy={busy} />
    </div>
  );
}
