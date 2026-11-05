import { useEffect, useState } from 'react';

import { isLayoutFileName, LAYOUT_FILE_EXTENSION } from '../showcase/boardFileName';

/**
 * Whoever was sent a board file has no board open, and it is off by default, so files dropped on the viewer are
 * handled here. An open board has its own handling, and a drop something else has already taken is left to it.
 */
export function useBoardFileDrop(enabled: boolean, onBoardFile: () => void) {
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const onDragOver = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes('Files')) return;
      setDragging(!event.defaultPrevented);
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    };
    const onDragLeave = (event: DragEvent) => {
      if (!event.relatedTarget) setDragging(false);
    };
    const onDrop = (event: DragEvent) => {
      setDragging(false);
      const files = event.dataTransfer?.files;
      if (event.defaultPrevented || !files?.length) return;
      // The browser would otherwise navigate to the file, losing the session.
      event.preventDefault();
      if (files.length > 1) {
        setProblem(`Drop one ${LAYOUT_FILE_EXTENSION} file at a time.`);
      } else if (isLayoutFileName(files[0].name)) {
        onBoardFile();
        setFile(files[0]);
      } else {
        setProblem(`Only a ${LAYOUT_FILE_EXTENSION} file can be dropped here.`);
      }
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [enabled, onBoardFile]);

  return { file, takeFile: () => setFile(null), dragging, problem, clearProblem: () => setProblem(null) };
}
