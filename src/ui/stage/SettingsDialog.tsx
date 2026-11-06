import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import { Check, Palette, Settings, Wrench } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '../primitives/cn';
import { Switch } from '../primitives/Switch';
import { THEMES, useSettings } from '../../settings';
import { WORKSHOP_ENABLED } from '../../device';
import { Dialog, DialogBody, DialogPopup, DialogSection, DialogTrigger } from '../primitives/Dialog';
import { ToolbarButton } from '../primitives/Toolbar';

const TEXTURE_DIRECTORY_URL = 'https://pyxell.neocities.org/paintersworkshop/texturedirectory';

const DESCRIPTION = 'text-11.5 leading-[1.4] text-dim';

function SettingRow({ label, description, checked, onChange }: {
  label: string;
  description: ReactNode;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div data-slot="setting-row" className="flex items-center justify-between gap-4 px-3 py-2 text-13 [&>[role=switch]]:flex-none">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span>{label}</span>
        <span className={DESCRIPTION}>{description}</span>
      </div>
      <Switch checked={checked} onChange={onChange} ariaLabel={label} />
    </div>
  );
}

function ThemePicker() {
  const theme = useSettings((s) => s.theme);
  const setTheme = useSettings((s) => s.setTheme);

  return (
    <RadioGroup
      aria-labelledby="settings-appearance-heading"
      className="mt-2.5 grid grid-cols-5 gap-1"
      value={theme}
      onValueChange={setTheme}
    >
      {THEMES.map(({ id, label }) => (
        <Radio.Root
          key={id}
          value={id}
          data-slot="theme-card"
          className="group/theme flex min-w-0 cursor-pointer flex-col items-center gap-1.5 rounded-sm text-11.5 focus-ring"
        >
          <span
            data-theme-preview={id}
            className="grid size-11 place-items-center rounded-full border border-strong bg-bg p-0.75 transition-fast group-hover/theme:border-text/55"
            aria-hidden="true"
          >
            <span className="grid size-full place-items-center rounded-full bg-accent text-accent-text">
              <Check className="invisible group-data-checked/theme:visible" size={18} strokeWidth={2.5} />
            </span>
          </span>
          <span className="max-w-full truncate">{label}</span>
        </Radio.Root>
      ))}
    </RadioGroup>
  );
}

// Toolbar button plus the modal it opens; self-contained so the toolbar only places it.
export function SettingsDialog() {
  const showPaintkitDetails = useSettings((s) => s.showPaintkitDetails);
  const setShowPaintkitDetails = useSettings((s) => s.setShowPaintkitDetails);
  const advancedCatalogSearch = useSettings((s) => s.advancedCatalogSearch);
  const setAdvancedCatalogSearch = useSettings((s) => s.setAdvancedCatalogSearch);
  const showcaseBoard = useSettings((s) => s.showcaseBoard);
  const setShowcaseBoard = useSettings((s) => s.setShowcaseBoard);

  return (
    <Dialog>
      <DialogTrigger title="Settings" aria-label="Open settings" render={<ToolbarButton />}>
        <Settings size={15} />
      </DialogTrigger>
      <DialogPopup title="Settings" closeLabel="Close settings" surfaceClassName="w-[min(460px,100%)]" data-camera-input-suspended="">
        <DialogBody>
          <DialogSection id="settings-appearance-heading" title="Appearance" icon={Palette}>
            <ThemePicker />
          </DialogSection>
          <DialogSection id="settings-workshopper-heading" title="Workshopper Tools" icon={Wrench} className="mt-4">
            <div data-slot="settings-group" className="mt-2 divide-y divide-border rounded-md border border-border">
              <SettingRow
                label="Show Paint Kit Details"
                checked={showPaintkitDetails}
                onChange={setShowPaintkitDetails}
                description={(
                  <>
                    IDs, texture paths and features on the selected paint.
                    <span className="block">
                      From <a className="text-accent underline" href={TEXTURE_DIRECTORY_URL} target="_blank" rel="noreferrer">Pyxell's TF2 Warpaint Texture Directory</a>.
                    </span>
                  </>
                )}
              />
              <SettingRow
                label="Advanced Catalog Search"
                checked={advancedCatalogSearch}
                onChange={setAdvancedCatalogSearch}
                description="Match by paint kit ID (#400) or operation (op:name)."
              />
              {WORKSHOP_ENABLED && (
                <SettingRow
                  label="Showcase Board"
                  checked={showcaseBoard}
                  onChange={setShowcaseBoard}
                  description="Arrange weapons on a pegboard and save them as one image."
                />
              )}
            </div>
            {!WORKSHOP_ENABLED && (
              <p className={cn('mt-2', DESCRIPTION)}>
                Custom war paints, the editor, definitions and the showcase board need a computer.
              </p>
            )}
          </DialogSection>
        </DialogBody>
      </DialogPopup>
    </Dialog>
  );
}
