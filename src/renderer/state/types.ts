// Bytes read over Tauri IPC arrive as a JSON number[] (read_file_buffer),
// but may also be an ArrayBuffer/Uint8Array depending on the source. pdf.js
// accepts any of these; this union avoids unsafe ArrayBuffer casts.
export type PdfBuffer = ArrayBuffer | Uint8Array | number[];

export interface OpenFile {
  path: string;           // original file path
  workingPath: string;    // temp working copy path
  name: string;
  pageCount: number;
  buffer: PdfBuffer | null;
  dirty: boolean;
  undoStack: string[];    // snapshot paths (most recent last)
  redoStack: string[];    // snapshot paths for redo
}

// Pending (uncommitted) annotation, display-normalized: x/y/w/h are 0..1
// relative to the rendered cell (inherent /Rotate + pending rotation baked
// in), so capture space equals render space. The commit builder maps these
// into PDF user space.
export interface PageAnnotation {
  id: string;
  kind: 'highlight' | 'freetext' | 'ink' | 'stamp';
  x: number;
  y: number;
  w: number;
  h: number;
  // highlight: fill color. freetext: text color. ink: stroke color.
  // stamp: border/text color (fixed per preset — see STAMP_PRESETS).
  color: string; // #rrggbb
  // highlight: optional popup note. freetext: the drawn text. stamp: the
  // preset label (e.g. "APPROVED"). All three land in /Contents at commit,
  // and are what the comment sidebar lists.
  note?: string;
  // ink only: flat [x0,y0,x1,y1,...] stroke path, display-normalized in the
  // same space as x/y/w/h (which store the path's bounding box). Re-projected
  // point-by-point alongside the bbox on rotation.
  points?: number[];
}

export interface PageRef {
  id: string;              // stable synthetic id, survives reorder
  sourceDocId: string;     // files-map key of the file this page's bytes come from
  sourcePageIndex: number; // 0-based index into that source file's original pages
  rotation: 0 | 90 | 180 | 270;
  width: number;           // page size at scale 1, from the pdf.js viewport
  height: number;
  annotations?: PageAnnotation[]; // pending only — baked into the file at commit
}

// A document as composed in the workspace. Usually one per open file; a .pdfx
// manifest partitions a single file into several documents, which then share
// the same path/workingPath/buffer and differ only in id/name/pages.
export interface OpenDocument extends OpenFile {
  id: string;       // unique within the workspace — path alone can't distinguish manifest partitions
  pages: PageRef[]; // page-level index, mutated in memory by page-level ops
}

export interface Workspace {
  documents: OpenDocument[]; // ordered — the canvas view renders these as strips
}

// One entry of the in-memory page-edit undo tier: whole workspace snapshots
// are cheap (arrays of references, no bytes).
export interface PageEditSnapshot {
  documents: OpenDocument[];
  dirtyPaths: string[];
}

export interface AppState {
  files: Map<string, OpenFile>;
  activeFileId: string | null;
  // Parallel page-level view of `files`, kept in sync asynchronously by
  // useWorkspaceIndexer. The canvas view renders it; other views still read
  // `files` directly.
  workspace: Workspace;
  // In-memory page-edit tier. Pending edits are always newer than the last
  // disk snapshot (the commit bridge drains this tier before any whole-file
  // op), so undo pops here first, then falls back to snapshot undo.
  pageUndoStack: PageEditSnapshot[];
  pageRedoStack: PageEditSnapshot[];
  pageDirtyPaths: string[]; // open files whose content must be rebuilt at commit
}

export type AppAction =
  | { type: 'OPEN_FILE'; path: string; workingPath: string; name: string; pageCount: number; buffer: PdfBuffer }
  | { type: 'CLOSE_FILE'; path: string }
  | { type: 'SET_ACTIVE_FILE'; path: string }
  | { type: 'UPDATE_FILE'; path: string; pageCount: number; buffer: PdfBuffer; snapshotPath: string }
  // Atomic variant dispatched by the commit bridge after all files are
  // rebuilt on disk: applies every file update and clears the page-edit tier
  // in one step, so no intermediate state is observable.
  | { type: 'COMMIT_PAGE_EDITS'; updates: { path: string; pageCount: number; buffer: PdfBuffer; snapshotPath: string }[] }
  // Snapshot-tier history. UNDO carries a snapshot of the pre-restore state
  // so REDO can return to it; the caller performs the disk restore and then
  // refreshes the buffer via REFRESH_BUFFER (which must not touch history —
  // that was the original multi-level-undo bug: refreshing via OPEN_FILE
  // reset the stacks after every undo).
  | { type: 'UNDO'; path: string; redoSnapshot: string }
  | { type: 'REDO'; path: string; undoSnapshot: string }
  | { type: 'REFRESH_BUFFER'; path: string; pageCount: number; buffer: PdfBuffer }
  | { type: 'MARK_SAVED'; path: string }
  // Workspace actions. SET_WORKSPACE_DOCUMENTS is dispatched by
  // useWorkspaceIndexer after a file is opened or its buffer changes. The
  // page-level mutations below are the in-memory tier: each pushes onto
  // pageUndoStack and marks the touched files dirty for the commit bridge.
  | { type: 'SET_WORKSPACE_DOCUMENTS'; path: string; documents: OpenDocument[] }
  | { type: 'REORDER_PAGES'; docId: string; order: string[] } // permutation of PageRef ids
  | { type: 'MOVE_PAGE'; fromDocId: string; toDocId: string; pageId: string; toIndex: number }
  | { type: 'MOVE_PAGE_TO_NEW_DOC'; fromDocId: string; pageId: string; docIndex: number; newDocId: string; newName: string }
  | { type: 'DELETE_PAGE_REF'; docId: string; pageId: string }
  | { type: 'ADD_ANNOTATION'; docId: string; pageId: string; annotation: PageAnnotation }
  | { type: 'UPDATE_ANNOTATION'; docId: string; pageId: string; annotationId: string; note: string }
  | { type: 'RECOLOR_ANNOTATION'; docId: string; pageId: string; annotationId: string; color: string }
  | { type: 'REMOVE_ANNOTATION'; docId: string; pageId: string; annotationId: string }
  | { type: 'SPLIT_DOC'; docId: string; atIndex: number; newDocId: string; newName: string }
  | { type: 'ROTATE_PAGE_REF'; docId: string; pageId: string; rotation: 0 | 90 | 180 | 270 }
  | { type: 'REORDER_DOCS'; docId: string; direction: -1 | 1 }
  | { type: 'RENAME_DOC'; docId: string; name: string }
  | { type: 'REMOVE_DOC'; docId: string }
  | { type: 'UNDO_PAGE_OP' }
  | { type: 'REDO_PAGE_OP' }
  | { type: 'CLEAR_PAGE_EDITS' };
