import React, { useState, useEffect, useCallback, useRef } from 'react';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';

interface DropZoneProps {
  onFilesDropped: (paths: string[]) => void;
  children: React.ReactNode;
}

export function DropZone({ onFilesDropped, children }: DropZoneProps): React.ReactElement {
  const [dragging, setDragging] = useState(false);
  const callbackRef = useRef(onFilesDropped);
  callbackRef.current = onFilesDropped;

  useEffect(() => {
    const appWindow = getCurrentWebviewWindow();
    const unlisten = appWindow.onDragDropEvent((event) => {
      if (event.payload.type === 'enter' || event.payload.type === 'over') {
        setDragging(true);
      } else if (event.payload.type === 'leave') {
        setDragging(false);
      } else if (event.payload.type === 'drop') {
        setDragging(false);
        const paths = event.payload.paths.filter((p) =>
          /\.pdfx?$/i.test(p)
        );
        if (paths.length > 0) callbackRef.current(paths);
      }
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  // Prevent default browser drop behavior (would navigate to the file)
  const preventDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  return (
    <div
      onDragOver={preventDrop}
      onDrop={preventDrop}
      className="relative h-full"
    >
      {children}
      {dragging && (
        <div className="absolute inset-0 bg-blue-600/20 border-2 border-dashed border-blue-500 rounded-lg flex items-center justify-center z-40 pointer-events-none">
          <div className="text-blue-300 text-lg font-medium">Drop PDF files here</div>
        </div>
      )}
    </div>
  );
}
