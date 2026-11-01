import { useMemo } from 'react';
import type { PaintkitEntry } from '../data/types';
import type { CustomDefinitionsState } from '../protodefs/types';
import { isCustomKitId } from '../protodefs/types';
import type { useCustomDefinitions } from '../hooks/useCustomDefinitions';
import type { useStockDefinitions } from '../hooks/useStockDefinitions';

interface UseGuardedDefinitionsStateOptions {
  definitionsState: ReturnType<typeof useCustomDefinitions>['state'];
  exportStockKit: ReturnType<typeof useStockDefinitions>['exportKit'];
  editorDirty: boolean;
  onSelectKit: (id: number) => void;
  selectedKit: PaintkitEntry | null;
}

export function useGuardedDefinitionsState({
  definitionsState,
  exportStockKit,
  editorDirty,
  onSelectKit,
  selectedKit,
}: UseGuardedDefinitionsStateOptions) {
  // Selecting a kit belongs to the app, so the hook leaves that hole for it.
  return useMemo<CustomDefinitionsState>(() => {
    // Only a stock paint can be copied; an imported paint is already a file the user owns.
    const stockKit = selectedKit && !isCustomKitId(selectedKit.id) ? selectedKit : null;
    return {
      ...definitionsState,
      onSelectKit,
      onImport: (files) => {
        if (editorDirty && !window.confirm('Discard unsaved edits and replace the imported definitions?')) return;
        definitionsState.onImport(files);
      },
      onCreateWarPaint: async (templateDefindex, name) => {
        if (editorDirty && !window.confirm('Discard unsaved edits and create a new war paint?')) return false;
        return definitionsState.onCreateWarPaint(templateDefindex, name);
      },
      onCreateWarPaintCopy: async (messages, name) => {
        // The exported messages carry the open edits, so the copy keeps them.
        if (editorDirty && !window.confirm('The copy will include your unsaved edits, which are then discarded from this paint. Create the copy?')) return false;
        return definitionsState.onCreateWarPaintCopy(messages, name);
      },
      selectedStockKit: stockKit ? { id: stockKit.id, name: stockKit.name } : undefined,
      exportSelectedStockKit: stockKit ? () => exportStockKit(stockKit.id) : undefined,
      onRemove: () => {
        if (editorDirty && !window.confirm('Discard unsaved edits and remove the imported definitions?')) return;
        definitionsState.onRemove();
      },
    };
  }, [definitionsState, editorDirty, onSelectKit, selectedKit, exportStockKit]);
}
