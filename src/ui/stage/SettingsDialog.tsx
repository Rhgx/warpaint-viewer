import { Settings } from 'lucide-react';
import type { ReactNode } from 'react';

import { Switch } from '../primitives/Switch';
import { useSettings } from '../../settings';
import { WORKSHOP_ENABLED } from '../../device';
import { Dialog, DialogBody, DialogPopup, DialogSection, DialogTrigger } from '../primitives/Dialog';
import { ToolbarButton } from '../primitives/Toolbar';

const TEXTURE_DIRECTORY_URL = 'https://pyxell.neocities.org/paintersworkshop/texturedirectory';

const DESCRIPTION = 'text-11 leading-[1.4] text-dim';

function SettingRow({ label, description, checked, onChange }: {
  label: string;
  description: ReactNode;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div data-slot="setting-row" className="flex items-center justify-between gap-4 py-2 text-12 [&>[role=switch]]:flex-none">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span>{label}</span>
        <span className={DESCRIPTION}>{description}</span>
      </div>
      <Switch checked={checked} onChange={onChange} ariaLabel={label} />
    </div>
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
      <DialogPopup title="Settings" closeLabel="Close settings" data-camera-input-suspended="">
        <DialogBody>
          <DialogSection id="settings-workshopper-heading" title="Workshopper tools">
            <SettingRow
              label="Show paint kit details"
              checked={showPaintkitDetails}
              onChange={setShowPaintkitDetails}
              description={(
                <>
                  Adds a details button to the selected or hovered war paint with its paintkit_proto_def_index,
                  and texture paths, bases, and features from{' '}
                  <a className="text-accent underline" href={TEXTURE_DIRECTORY_URL} target="_blank" rel="noreferrer">Pyxell's TF2 Warpaint Texture Directory</a>.
                  Click the ID or a texture path to copy it.
                </>
              )}
            />
            <SettingRow
              label="Advanced catalog search"
              checked={advancedCatalogSearch}
              onChange={setAdvancedCatalogSearch}
              description={(
                <>
                  Lets the warpaint filter match an exact paint kit ID (400 or #400) and list every paint that
                  uses an operation (op:name, for example op:yeti_multiply_skin_with_stickers).
                </>
              )}
            />
            {WORKSHOP_ENABLED && (
              <SettingRow
                label="Showcase board"
                checked={showcaseBoard}
                onChange={setShowcaseBoard}
                description="Arrange painted weapons on a pegboard and save it as one image."
              />
            )}
            {!WORKSHOP_ENABLED && (
              <div className={DESCRIPTION}>
                Custom war paint files, the visual editor, definitions import and the showcase board are desktop
                features. Open the
                viewer on a computer to use them.
              </div>
            )}
          </DialogSection>
        </DialogBody>
      </DialogPopup>
    </Dialog>
  );
}
