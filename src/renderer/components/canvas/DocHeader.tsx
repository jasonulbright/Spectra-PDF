import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { OpenDocument } from '../../state/types';
import { ChevronUpIcon, ChevronDownIcon, CloseIcon, MergeUpIcon } from './icons';
import { useTranslation } from 'react-i18next';
import { tChrome, tChromeCount } from '../../i18n';

interface DocHeaderProps {
  doc: OpenDocument;
  index: number;
  total: number;
  onMove: (docId: string, direction: -1 | 1) => void;
  onRemove: (docId: string) => void;
  onRename: (docId: string, name: string) => void;
  // Merge-up (2o): append a COPY of this document's pages to the document
  // above (disabled for the first document; reorder + repeat composes any
  // merge order). This document's strip stays until the user removes it.
  onMergeUp: (docId: string) => void;
}

function DocHeaderImpl({
  doc,
  index,
  total,
  onMove,
  onRemove,
  onRename,
  onMergeUp,
}: DocHeaderProps): React.JSX.Element {
  useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(doc.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setDraft(doc.name);
  }, [doc.name, editing]);

  useLayoutEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commit = (): void => {
    const name = draft.trim();
    if (name && name !== doc.name) onRename(doc.id, name);
    else setDraft(doc.name);
    setEditing(false);
  };
  const cancel = (): void => {
    setDraft(doc.name);
    setEditing(false);
  };

  return (
    <header className="doc-header">
      <span className="doc-index">{String(index + 1).padStart(2, '0')}</span>
      {editing ? (
        <input
          ref={inputRef}
          className="doc-name doc-name-input"
          value={draft}
          size={Math.max(draft.length, 1)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              cancel();
            }
          }}
        />
      ) : (
        <span
          className="doc-name"
          title={doc.name}
          onClick={(e) => {
            e.stopPropagation();
            setEditing(true);
          }}
        >
          {doc.name}
        </span>
      )}
      <span className="doc-pages">
        {tChromeCount('panel.common.pageCount', doc.pages.length)}
      </span>
      <div className="doc-actions">
        <button
          className="icon-btn"
          title={tChrome('canvas.doc.moveUp')}
          disabled={index === 0}
          onClick={() => onMove(doc.id, -1)}
        >
          <ChevronUpIcon size={14} />
        </button>
        <button
          className="icon-btn"
          title={tChrome('canvas.doc.moveDown')}
          disabled={index === total - 1}
          onClick={() => onMove(doc.id, 1)}
        >
          <ChevronDownIcon size={14} />
        </button>
        <button
          className="icon-btn"
          data-testid={`merge-up-${doc.id}`}
          title={tChrome('canvas.doc.mergeUp')}
          disabled={index === 0}
          onClick={() => onMergeUp(doc.id)}
        >
          <MergeUpIcon size={14} />
        </button>
        <button
          className="icon-btn"
          title={tChrome('canvas.doc.remove')}
          onClick={() => onRemove(doc.id)}
        >
          <CloseIcon size={14} />
        </button>
      </div>
    </header>
  );
}

export const DocHeader = memo(DocHeaderImpl);
