import { useState } from 'react';
import type { OpenDocument } from '../../state/types';
import { ANNOTATION_PALETTE } from './PageCell';

interface CommentEntry {
  docId: string;
  docName: string;
  pageId: string;
  pageNumber: number; // 1-based position within the document's own pages
  annotationId: string;
  kind: string;
  color: string;
  note: string;
}

function collectComments(docs: OpenDocument[]): CommentEntry[] {
  const entries: CommentEntry[] = [];
  for (const doc of docs) {
    doc.pages.forEach((page, index) => {
      for (const a of page.annotations ?? []) {
        if (!a.note) continue;
        entries.push({
          docId: doc.id,
          docName: doc.name,
          pageId: page.id,
          pageNumber: index + 1,
          annotationId: a.id,
          kind: a.kind,
          color: a.color,
          note: a.note,
        });
      }
    });
  }
  return entries;
}

interface CommentSidebarProps {
  docs: OpenDocument[];
  onSelectPage: (docId: string, pageId: string) => void;
  onJumpToPage: (pageId: string) => void;
  onUpdateAnnotation: (docId: string, pageId: string, annotationId: string, note: string) => void;
  onRecolorAnnotation: (docId: string, pageId: string, annotationId: string, color: string) => void;
  onRemoveAnnotation: (docId: string, pageId: string, annotationId: string) => void;
  onClose: () => void;
}

// Lists every annotation with a note (highlight popups, freetext bodies,
// stamp labels) across the open workspace. Clicking an entry highlights its
// page (onSelectPage) and scrolls the canvas to it (onJumpToPage → centerOn,
// the handle added in 2m).
export function CommentSidebar({
  docs,
  onSelectPage,
  onJumpToPage,
  onUpdateAnnotation,
  onRecolorAnnotation,
  onRemoveAnnotation,
  onClose,
}: CommentSidebarProps): React.JSX.Element {
  const [editing, setEditing] = useState<string | null>(null);
  const entries = collectComments(docs);

  return (
    <div className="comment-sidebar" data-testid="comment-sidebar">
      <div className="comment-sidebar-header">
        <span>Comments ({entries.length})</span>
        <button className="comment-sidebar-close" onClick={onClose} title="Close">
          ×
        </button>
      </div>
      <div className="comment-sidebar-list">
        {entries.length === 0 && (
          <p className="comment-sidebar-empty">No notes yet — highlight, text, or stamp annotations with content show up here.</p>
        )}
        {entries.map((e) => (
          <div
            key={e.annotationId}
            className="comment-sidebar-item"
            style={{ borderLeftColor: e.color }}
            onClick={() => {
              onSelectPage(e.docId, e.pageId);
              onJumpToPage(e.pageId);
            }}
          >
            <div className="comment-sidebar-item-meta">
              <span className="comment-sidebar-item-kind">{e.kind}</span>
              <span>{e.docName} — p.{e.pageNumber}</span>
            </div>
            {editing === e.annotationId ? (
              <textarea
                className="comment-sidebar-item-editor"
                autoFocus
                defaultValue={e.note}
                onClick={(ev) => ev.stopPropagation()}
                onBlur={(ev) => {
                  setEditing(null);
                  const value = ev.currentTarget.value.trim();
                  if (!value) onRemoveAnnotation(e.docId, e.pageId, e.annotationId); // matches PageCell's finishEditing
                  else if (value !== e.note) onUpdateAnnotation(e.docId, e.pageId, e.annotationId, value);
                }}
                onKeyDown={(ev) => {
                  if (ev.key === 'Escape') {
                    ev.preventDefault();
                    setEditing(null);
                  } else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
                    ev.preventDefault();
                    ev.currentTarget.blur();
                  }
                }}
              />
            ) : (
              <p
                className="comment-sidebar-item-note"
                onDoubleClick={(ev) => {
                  ev.stopPropagation();
                  if (e.kind !== 'stamp') setEditing(e.annotationId);
                }}
              >
                {e.note}
              </p>
            )}
            <div className="comment-sidebar-item-actions">
              <div className="comment-sidebar-item-recolor">
                {ANNOTATION_PALETTE.map((c) => (
                  <button
                    key={c}
                    className="comment-sidebar-item-recolor-dot"
                    title={`Recolor to ${c}`}
                    style={{ backgroundColor: c }}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      onRecolorAnnotation(e.docId, e.pageId, e.annotationId, c);
                    }}
                  />
                ))}
              </div>
              <button
                className="comment-sidebar-item-remove"
                title="Remove"
                onClick={(ev) => {
                  ev.stopPropagation();
                  onRemoveAnnotation(e.docId, e.pageId, e.annotationId);
                }}
              >
                Remove
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
