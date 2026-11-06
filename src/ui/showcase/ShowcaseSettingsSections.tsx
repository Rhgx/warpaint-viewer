import { Download, Move, Palette } from 'lucide-react';
import { memo } from 'react';

import { SelectField } from '../common/controls';
import { Slider } from '../primitives/Slider';
import { Switch } from '../primitives/Switch';
import type { ShowcaseBoard } from '../../showcase/ShowcaseBoard';
import { Row } from '../common/controls';
import { LightPad, Section, Segmented, SliderRow } from './ShowcaseControls';
import {
  EXPORT_KEYS, LOOK_KEYS, OUTPUT_WIDTHS, PLACEMENT_KEYS, ROTATION_SNAPS, defaultsFor, settingsChanged, type ShowcaseSettings,
} from './showcaseSettings';

// Board-wide settings sections, shown when no weapon is selected.

type SettingsSectionProps = { settings: ShowcaseSettings; onChange: (patch: Partial<ShowcaseSettings>) => void };

export const PlacementSection = memo(function PlacementSection({ settings, onChange: set }: SettingsSectionProps) {
  return (
    <Section title="Placement" icon={Move} canReset={settingsChanged(settings, PLACEMENT_KEYS)} onReset={() => set(defaultsFor(PLACEMENT_KEYS))}>
      <Row label="Snap to Grid">
        <Switch checked={settings.snapToGrid} onChange={(snapToGrid) => set({ snapToGrid })} ariaLabel="Snap to Grid" />
      </Row>
      {settings.snapToGrid && (
        <SliderRow label="Grid Size" value={null}>
          <Segmented label="Grid Size" value={settings.grid} onChange={(grid) => set({ grid })}
            options={[{ value: 'fine', label: 'Fine' }, { value: 'normal', label: 'Normal' }, { value: 'coarse', label: 'Coarse' }]} />
        </SliderRow>
      )}
      <Row label="Keep Weapons Apart">
        <Switch checked={settings.keepApart} onChange={(keepApart) => set({ keepApart })} ariaLabel="Keep Weapons Apart" />
      </Row>
      {settings.keepApart && (
        <SliderRow label="Spacing" value={`${settings.spacing} ${settings.spacing === 1 ? 'cell' : 'cells'}`}>
          <Slider value={settings.spacing} min={0} max={4} step={1} ariaLabel="Spacing" onChange={(spacing) => set({ spacing })} />
        </SliderRow>
      )}
      <Row label="Keep Inside the Board">
        <Switch checked={settings.keepInside} onChange={(keepInside) => set({ keepInside })} ariaLabel="Keep Inside the Board" />
      </Row>
      <SliderRow label="Rotation Snap" value={null}>
        <Segmented label="Rotation Snap" value={settings.rotationSnap} onChange={(rotationSnap) => set({ rotationSnap })}
          options={ROTATION_SNAPS.map((degrees) => ({ value: degrees, label: degrees ? `${degrees}°` : 'Free' }))} />
      </SliderRow>
      <Row label="Show Footprints">
        <Switch checked={settings.showFootprints} onChange={(showFootprints) => set({ showFootprints })} ariaLabel="Show Footprints" />
      </Row>
    </Section>
  );
});

export const LookSection = memo(function LookSection({ settings, onChange: set }: SettingsSectionProps) {
  return (
    <Section title="Look" icon={Palette} canReset={settingsChanged(settings, LOOK_KEYS)} onReset={() => set(defaultsFor(LOOK_KEYS))}>
      <Row label="Light">
        <LightPad azimuth={settings.lightAzimuth} elevation={settings.lightElevation}
          onChange={(lightAzimuth, lightElevation) => set({ lightAzimuth, lightElevation })} />
      </Row>
      <Row label="Shadows">
        <Switch checked={settings.shadows} onChange={(shadows) => set({ shadows })} ariaLabel="Shadows" />
      </Row>
      {settings.shadows && (
        <SliderRow label="Shadow Strength" value={`${settings.shadow}%`}>
          <Slider value={settings.shadow} min={0} max={100} step={5} ariaLabel="Shadow Strength" onChange={(shadow) => set({ shadow })} />
        </SliderRow>
      )}
      <SliderRow label="Background" value={null}>
        <Segmented label="Background" value={settings.background} onChange={(background) => set({ background })}
          options={[
            { value: 'framed', label: 'Framed' },
            { value: 'pegboard', label: 'Pegboard' },
            { value: 'transparent', label: 'Transparent' },
          ]} />
      </SliderRow>
    </Section>
  );
});

export const ExportSection = memo(function ExportSection({ board, settings, onChange: set }: SettingsSectionProps & {
  board: ShowcaseBoard | null;
}) {
  return (
    <Section title="Export" icon={Download} canReset={settingsChanged(settings, EXPORT_KEYS)} onReset={() => set(defaultsFor(EXPORT_KEYS))}>
      <Row label="Resolution">
        <SelectField value={String(settings.outputWidth)} onChange={(value) => set({ outputWidth: Number(value) })}
          options={OUTPUT_WIDTHS.map((width) => {
            const size = board?.outputSize(width) ?? { width, height: Math.round(width * 9 / 16) };
            return { value: String(width), label: `${size.width} × ${size.height}` };
          })} />
      </Row>
    </Section>
  );
});
