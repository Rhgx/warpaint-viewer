import { Download, Files, Maximize2, Minimize2, PackageOpen, PencilRuler, Plus, ScrollText, Trash2, X } from 'lucide-react';
import { Tabs } from '@base-ui/react/tabs';
import type { CustomDefinitionsState } from '../../protodefs/types';
import type { SourcePackageState } from '../../source/contracts';
import type { WorkbenchTab } from '../../workbench/types';
import { draftStatusLabel } from './workbenchLabels';
import type { WorkbenchEditor } from './workbenchTypes';

export function WorkbenchHeader({
  tab,
  onTabChange,
  slotCount,
  replacedCount,
  editor,
  sourcePackage,
  definitions,
  onRouteFiles,
  onClearWorkspace,
  expanded,
  onExpandedChange,
  onClose,
}: {
  tab: WorkbenchTab;
  onTabChange: (tab: WorkbenchTab) => void;
  slotCount: number;
  replacedCount: number;
  editor?: WorkbenchEditor;
  sourcePackage: SourcePackageState;
  definitions: CustomDefinitionsState;
  onRouteFiles: (files: File[]) => void;
  onClearWorkspace?: () => void;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onClose: () => void;
}) {
  // Tab badges show the other tabs' state without switching to them.
  const filesBadge =
    replacedCount > 0 ? `${replacedCount}/${slotCount}` : `${slotCount}`;
  const packageSummary =
    sourcePackage.status === 'mounted' ? sourcePackage.summary : undefined;
  const loadedDefinitionCount = definitions.kits.filter(
    (kit) => kit.loaded,
  ).length;

  return (
    <header className="custom-workbench-header">
      <Tabs.List className="custom-workbench-tablist">
        <Tabs.Tab value="files" className="custom-workbench-tab">
          <Files size={13} />
          <span>Files</span>
          <span className="custom-workbench-tab-badge">{filesBadge}</span>
        </Tabs.Tab>
        <Tabs.Tab
          value="editor"
          className="custom-workbench-tab"
          data-dirty={editor?.dirty ? '' : undefined}
        >
          <PencilRuler size={13} />
          <span>Edit</span>
          {editor?.dirty && (
            <span
              className="visual-warpaint-editor-dirty-dot"
              data-state={editor.draft.status}
              aria-label={draftStatusLabel(editor.draft.status) ?? 'Changes waiting to save'}
            />
          )}
        </Tabs.Tab>
        <Tabs.Tab value="export" className="custom-workbench-tab">
          <Download size={13} />
          <span>Export</span>
          {replacedCount > 0 && (
            <span className="custom-workbench-tab-badge">{replacedCount}</span>
          )}
        </Tabs.Tab>
      </Tabs.List>

      {/* Imported state stays visible from every tab, which a tab would hide. */}
      <div className="workbench-sources">
        {/* Plain buttons: base-ui tab triggers must sit inside Tabs.List.
            The controlled Root value still shows the chosen panel. */}
        <button
          type="button"
          className="workbench-source"
          data-loaded={sourcePackage.status === 'mounted' ? '' : undefined}
          data-selected={tab === 'package' ? '' : undefined}
          aria-pressed={tab === 'package'}
          onClick={() => onTabChange('package')}
          title={packageSummary ? `${packageSummary.name} (${packageSummary.format.toUpperCase()})` : 'No archive mounted'}
        >
          <PackageOpen size={12} />
          <span>
            {packageSummary
              ? `${packageSummary.name} · ${packageSummary.usedCount || packageSummary.entryCount} files`
              : 'No archive'}
          </span>
        </button>
        <button
          type="button"
          className="workbench-source"
          data-loaded={definitions.status === 'loaded' ? '' : undefined}
          data-selected={tab === 'definitions' ? '' : undefined}
          aria-pressed={tab === 'definitions'}
          onClick={() => onTabChange('definitions')}
          title={definitions.fileName ?? 'No definitions imported'}
        >
          <ScrollText size={12} />
          <span>
            {definitions.status === 'loaded'
              ? `${loadedDefinitionCount || definitions.kits.length} paint${(loadedDefinitionCount || definitions.kits.length) === 1 ? '' : 's'}`
              : 'No definitions'}
          </span>
        </button>
        <label className="workbench-source workbench-source-import" title="Import an archive or a war paint's definitions">
          <Plus size={12} />
          <span>Import</span>
          <input
            type="file"
            accept=".zip,.vpk,.vpd,.json"
            multiple
            aria-label="Import an archive or war paint definitions"
            onChange={(event) => {
              const files = [...(event.target.files ?? [])];
              event.target.value = '';
              if (files.length) onRouteFiles(files);
            }}
          />
        </label>
        {onClearWorkspace && (
          <button
            type="button"
            className="workbench-source workbench-source-clear"
            title="Clear everything imported into this browser"
            aria-label="Clear workspace"
            onClick={onClearWorkspace}
          >
            <Trash2 size={12} />
          </button>
        )}
      </div>

      {tab === 'editor' && (
        <button
          type="button"
          className="custom-workbench-expand"
          title={expanded ? 'Exit full-screen editor (Esc)' : 'Open full-screen editor'}
          aria-label={expanded ? 'Exit full-screen editor' : 'Open full-screen editor'}
          aria-pressed={expanded}
          onClick={() => onExpandedChange(!expanded)}
        >
          {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </button>
      )}

      <button
        type="button"
        className="custom-workbench-close"
        title="Close war paint workbench"
        aria-label="Close war paint workbench"
        onClick={onClose}
      >
        <X size={16} />
      </button>
    </header>
  );
}
