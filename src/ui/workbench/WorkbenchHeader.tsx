import { Download, Files, Maximize2, Minimize2, PackageOpen, PencilRuler, Plus, ScrollText, Trash2, X } from 'lucide-react';
import { Tabs } from '@base-ui/react/tabs';
import type { CustomDefinitionsState } from '../../protodefs/types';
import type { SourcePackageState } from '../../source/contracts';
import type { WorkbenchTab } from '../../workbench/types';
import { Button, FileButton } from '../primitives/Button';
import { cn } from '../primitives/cn';
import { draftStatusLabel } from './workbenchLabels';
import type { WorkbenchEditor } from './workbenchTypes';

// Hover stays weaker than selected, so only one tab ever reads as chosen.
const TAB = 'group flex cursor-pointer items-center gap-1.25 rounded-sm border-0 bg-transparent px-2.25 py-1.5 text-10.5 font-[650] text-dim transition-fast focus-ring not-data-active:hover:bg-panel-2 not-data-active:hover:text-text/75 data-active:bg-border data-active:text-text';
// At phone width tabs keep their labels and drop their icons, so that source chips do not slide over Edit and Export.
const TAB_ICON = 'flex-none @max-[480px]:hidden';
const TAB_BADGE = 'inline-flex items-center gap-0.75 rounded-sm bg-panel px-1.25 py-px text-9 text-dim tabular-nums group-data-active:text-text';
const SOURCE = '@max-[480px]:px-1.75';
const SOURCE_ICON = 'flex-none opacity-85';
const SOURCE_LABEL = 'min-w-0 overflow-hidden text-ellipsis @max-[720px]:hidden';

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
    <header className="flex min-h-8.5 flex-none items-center gap-1.5 border-b border-border py-1 pr-1.5 pl-1">
      <Tabs.List className="flex min-w-0 flex-[1_1_auto] items-stretch gap-0.5 @max-[480px]:shrink-0">
        <Tabs.Tab value="files" className={TAB} data-slot="workbench-tab">
          <Files className={TAB_ICON} size={13} />
          <span>Files</span>
          <span className={TAB_BADGE}>{filesBadge}</span>
        </Tabs.Tab>
        <Tabs.Tab
          value="editor"
          className={TAB}
          data-slot="workbench-tab"
          data-dirty={editor?.dirty ? '' : undefined}
        >
          <PencilRuler className={TAB_ICON} size={13} />
          <span>Edit</span>
          {editor?.dirty && (
            <span
              className="size-1.25 rounded-full bg-warn data-[state=error]:bg-fail data-[state=saved]:bg-pass forced-colors:bg-[Highlight]"
              data-slot="workbench-dirty-dot"
              data-state={editor.draft.status}
              aria-label={draftStatusLabel(editor.draft.status) ?? 'Changes waiting to save'}
            />
          )}
        </Tabs.Tab>
        <Tabs.Tab value="export" className={TAB} data-slot="workbench-tab">
          <Download className={TAB_ICON} size={13} />
          <span>Export</span>
          {replacedCount > 0 && (
            <span className={TAB_BADGE}>{replacedCount}</span>
          )}
        </Tabs.Tab>
      </Tabs.List>

      {/* Imported state stays visible from every tab, which a tab would hide. */}
      <div className="ml-auto flex min-w-0 flex-[0_1_auto] items-center gap-1.5 pr-2 @max-[480px]:pr-0.5">
        {/* Leads the row, which is anchored right, so that the chips stay put when it appears. */}
        {onClearWorkspace && (
          <Button
            variant="danger"
            size="chip"
            className="relative flex-none self-stretch bg-transparent px-1.5 before:absolute before:-inset-0.75"
            title="Clear everything imported into this browser"
            aria-label="Clear workspace"
            onClick={onClearWorkspace}
          >
            <Trash2 size={12} />
          </Button>
        )}
        {/* Plain buttons: base-ui tab triggers must sit inside Tabs.List.
            The controlled Root value still shows the chosen panel. */}
        <Button
          variant="chip"
          size="chip"
          className={SOURCE}
          data-slot="workbench-source"
          data-loaded={sourcePackage.status === 'mounted' ? '' : undefined}
          aria-pressed={tab === 'package'}
          onClick={() => onTabChange('package')}
          title={packageSummary ? `${packageSummary.name} (${packageSummary.format.toUpperCase()})` : 'No archive mounted'}
        >
          <PackageOpen className={SOURCE_ICON} size={12} />
          <span className={SOURCE_LABEL}>
            {packageSummary
              ? `${packageSummary.name} · ${packageSummary.usedCount || packageSummary.entryCount} files`
              : 'No archive'}
          </span>
        </Button>
        <Button
          variant="chip"
          size="chip"
          className={SOURCE}
          data-slot="workbench-source"
          data-loaded={definitions.status === 'loaded' ? '' : undefined}
          aria-pressed={tab === 'definitions'}
          onClick={() => onTabChange('definitions')}
          title={definitions.fileName ?? 'No definitions imported'}
        >
          <ScrollText className={SOURCE_ICON} size={12} />
          <span className={SOURCE_LABEL}>
            {definitions.status === 'loaded'
              ? `${loadedDefinitionCount || definitions.kits.length} paint${(loadedDefinitionCount || definitions.kits.length) === 1 ? '' : 's'}`
              : 'No definitions'}
          </span>
        </Button>
        {/* The chips before it report state; Import is a command. */}
        <span className="h-4 w-px flex-none bg-border @max-[480px]:hidden" aria-hidden="true" />
        <FileButton
          variant="chip"
          size="chip"
          className={cn(SOURCE, 'text-text')}
          data-slot="workbench-source"
          label="Import an archive or war paint definitions"
          accept=".zip,.vpk,.vpd,.json"
          multiple
          title="Import an archive or a war paint's definitions"
          onFiles={onRouteFiles}
        >
          <Plus className={SOURCE_ICON} size={12} />
          <span className="min-w-0 overflow-hidden text-ellipsis @max-[480px]:hidden">Import</span>
        </FileButton>
      </div>

      {/* Its slot stays on every tab, so that the chips do not move when switching. */}
      {tab === 'editor' ? (
        <Button
          variant="ghost"
          size="icon-lg"
          className="flex-none aria-pressed:bg-panel-2 aria-pressed:text-text"
          title={expanded ? 'Exit full-screen editor (Esc)' : 'Open full-screen editor'}
          aria-label={expanded ? 'Exit full-screen editor' : 'Open full-screen editor'}
          aria-pressed={expanded}
          onClick={() => onExpandedChange(!expanded)}
        >
          {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </Button>
      ) : (
        <span className="size-8 flex-none" aria-hidden="true" />
      )}

      <Button
        variant="ghost"
        size="icon-lg"
        className="flex-none"
        title="Close war paint workbench"
        aria-label="Close war paint workbench"
        onClick={onClose}
      >
        <X size={16} />
      </Button>
    </header>
  );
}
