import { useState } from 'react';
import { WORKSHOP_ENABLED } from '../device';
import type { WorkbenchTab } from '../workbench/types';

export function useWorkbenchDrawer() {
  const [workbenchOpen, setWorkbenchOpen] = useState(false);
  const [workbenchMounted, setWorkbenchMounted] = useState(false);
  const [workbenchExpanded, setWorkbenchExpanded] = useState(false);
  // 0 keeps the CSS default drawer height; anything else is a user drag.
  const [workbenchHeight, setWorkbenchHeight] = useState(0);
  // The drawer is keyed to remount per paint/weapon, so its tab lives out here.
  const [workbenchTab, setWorkbenchTab] = useState<WorkbenchTab>('files');

  const toggleWorkbench = () => {
    // The only way in, so the workbench is never imported or mounted without the workshop.
    if (!WORKSHOP_ENABLED) return;
    setWorkbenchMounted(true);
    setWorkbenchOpen((open) => !open);
  };

  const changeWorkbenchTab = (nextTab: WorkbenchTab) => {
    setWorkbenchTab(nextTab);
    if (nextTab !== 'editor') setWorkbenchExpanded(false);
  };

  const closeWorkbench = () => {
    setWorkbenchExpanded(false);
    setWorkbenchOpen(false);
  };

  return {
    workbenchOpen,
    setWorkbenchOpen,
    workbenchMounted,
    setWorkbenchMounted,
    workbenchExpanded,
    setWorkbenchExpanded,
    workbenchHeight,
    setWorkbenchHeight,
    workbenchTab,
    setWorkbenchTab,
    toggleWorkbench,
    changeWorkbenchTab,
    closeWorkbench,
  };
}
