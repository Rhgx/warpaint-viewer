import { Dialog } from '@base-ui/react/dialog';
import { Settings, X } from 'lucide-react';
import { SwitchField } from '../common/controls';
import { useSettings } from '../../settings';
// Shares the Controls modal's frame so the two toolbar dialogs read as a pair.
import './ControlsHelpModal.css';
import './SettingsDialog.css';

const TEXTURE_DIRECTORY_URL = 'https://pyxell.neocities.org/paintersworkshop/texturedirectory';

// Toolbar button plus the modal it opens. Self-contained so the toolbar only
// has to place it.
export function SettingsDialog() {
  const showPaintkitDetails = useSettings((s) => s.showPaintkitDetails);
  const setShowPaintkitDetails = useSettings((s) => s.setShowPaintkitDetails);

  return (
    <Dialog.Root>
      <Dialog.Trigger className="stage-toolbar-btn" title="Settings" aria-label="Open settings">
        <Settings size={15} />
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Viewport className="controls-help-backdrop">
          <Dialog.Popup className="controls-help-modal" data-camera-input-suspended="">
            <header className="controls-help-header">
              <Dialog.Title>Settings</Dialog.Title>
              <Dialog.Close className="controls-help-close" aria-label="Close settings">
                <X size={16} />
              </Dialog.Close>
            </header>

            <div className="controls-help-body">
              <section className="controls-help-section" aria-labelledby="settings-workshopper-heading">
                <h3 id="settings-workshopper-heading">Workshopper tools</h3>
                <div className="settings-row">
                  <div className="settings-row-text">
                    <span>Show paint kit details</span>
                    <span className="settings-row-description">
                      Adds a details button to the selected or hovered war paint with its paintkit_proto_def_index,
                      and texture paths, bases, and features from{' '}
                      <a href={TEXTURE_DIRECTORY_URL} target="_blank" rel="noreferrer">Pyxell's TF2 Warpaint Texture Directory</a>.
                      Click the ID or a texture path to copy it.
                    </span>
                  </div>
                  <SwitchField checked={showPaintkitDetails} onChange={setShowPaintkitDetails} ariaLabel="Show paint kit details" />
                </div>
              </section>
            </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
