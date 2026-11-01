import type { EditorDraftStatus } from '../../editor/useEditorDraft';

export const MIN_PANEL_HEIGHT = 190;
export const RESET_CONFIRM_MS = 3000;
export const TEXTURE_FILE_ACCEPT = '.png,.jpg,.jpeg,.webp,.tga,.vtf';

/** A definition texture reference without its materials/ root or extension. */
export function referenceStem(reference: string): string {
  return reference.trim().replace(/\\/g, '/').replace(/^materials\//i, '').replace(/\.(vtf|tga|psd|png|webp)$/i, '');
}

export function referenceLabel(reference: string): string {
  return (referenceStem(reference).split('/').at(-1) ?? reference).replaceAll('_', ' ');
}

export function draftStatusLabel(status: EditorDraftStatus): string | null {
  if (status === 'pending' || status === 'saving') return 'Saving...';
  if (status === 'saved') return 'Saved locally';
  if (status === 'error') return 'Autosave failed';
  return null;
}
