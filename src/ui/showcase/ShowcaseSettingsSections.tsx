import { memo } from 'react';

import { SelectField, SliderField, SwitchField } from '../common/controls';
import type { ShowcaseBoard } from '../../showcase/ShowcaseBoard';
import { LightPad, Row, Section, Segmented, SliderRow } from './ShowcaseControls';
import {
  EXPORT_KEYS, LOOK_KEYS, OUTPUT_WIDTHS, PLACEMENT_KEYS, ROTATION_SNAPS, defaultsFor, exportsBackdrop, settingsChanged, type ShowcaseSettings,
} from './showcaseSettings';

// Board-wide settings sections, shown when no weapon is selected.

type SettingsSectionProps = { settings: ShowcaseSettings; onChange: (patch: Partial<ShowcaseSettings>) => void };

export const PlacementSection = memo(function PlacementSection({ settings, onChange: set }: SettingsSectionProps) {
  return (
    <Section title="Placement" canReset={settingsChanged(settings, PLACEMENT_KEYS)} onReset={() => set(defaultsFor(PLACEMENT_KEYS))}>
      <Row label="Snap to grid">
        <SwitchField checked={settings.snapToGrid} onChange={(snapToGrid) => set({ snapToGrid })} ariaLabel="Snap to grid" />
      </Row>
      {settings.snapToGrid && (
        <SliderRow label="Grid size" value={null}>
          <Segmented label="Grid size" value={settings.grid} onChange={(grid) => set({ grid })}
            options={[{ value: 'fine', label: 'Fine' }, { value: 'normal', label: 'Normal' }, { value: 'coarse', label: 'Coarse' }]} />
        </SliderRow>
      )}
      <Row label="Keep weapons apart">
        <SwitchField checked={settings.keepApart} onChange={(keepApart) => set({ keepApart })} ariaLabel="Keep weapons apart" />
      </Row>
      {settings.keepApart && (
        <SliderRow label="Spacing" value={`${settings.spacing} ${settings.spacing === 1 ? 'cell' : 'cells'}`}>
          <SliderField value={settings.spacing} min={0} max={4} step={1} ariaLabel="Spacing" onChange={(spacing) => set({ spacing })} />
        </SliderRow>
      )}
      <Row label="Keep inside the board">
        <SwitchField checked={settings.keepInside} onChange={(keepInside) => set({ keepInside })} ariaLabel="Keep inside the board" />
      </Row>
      <SliderRow label="Rotation snap" value={null}>
        <Segmented label="Rotation snap" value={settings.rotationSnap} onChange={(rotationSnap) => set({ rotationSnap })}
          options={ROTATION_SNAPS.map((degrees) => ({ value: degrees, label: degrees ? `${degrees}°` : 'Free' }))} />
      </SliderRow>
      <Row label="Show footprints">
        <SwitchField checked={settings.showFootprints} onChange={(showFootprints) => set({ showFootprints })} ariaLabel="Show footprints" />
      </Row>
    </Section>
  );
});

export const LookSection = memo(function LookSection({ settings, onChange: set }: SettingsSectionProps) {
  return (
    <Section title="Look" canReset={settingsChanged(settings, LOOK_KEYS)} onReset={() => set(defaultsFor(LOOK_KEYS))}>
      <Row label="Light">
        <LightPad azimuth={settings.lightAzimuth} elevation={settings.lightElevation}
          onChange={(lightAzimuth, lightElevation) => set({ lightAzimuth, lightElevation })} />
      </Row>
      <Row label="Shadows">
        <SwitchField checked={settings.shadows} onChange={(shadows) => set({ shadows })} ariaLabel="Shadows" />
      </Row>
      {settings.shadows && (
        <SliderRow label="Shadow strength" value={`${settings.shadow}%`}>
          <SliderField value={settings.shadow} min={0} max={100} step={5} ariaLabel="Shadow strength" onChange={(shadow) => set({ shadow })} />
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
    <Section title="Export" canReset={settingsChanged(settings, EXPORT_KEYS)} onReset={() => set(defaultsFor(EXPORT_KEYS))}>
      <Row label="Resolution">
        <SelectField value={String(settings.outputWidth)} onChange={(value) => set({ outputWidth: Number(value) })}
          options={OUTPUT_WIDTHS.map((width) => {
            const size = board?.outputSize(width, exportsBackdrop(settings)) ?? { width, height: Math.round(width * 9 / 16) };
            return { value: String(width), label: `${size.width} × ${size.height}` };
          })} />
      </Row>
      {settings.background !== 'transparent' && (
        <Row label="Include backdrop">
          <SwitchField checked={settings.exportBackdrop} onChange={(exportBackdrop) => set({ exportBackdrop })} ariaLabel="Include backdrop" />
        </Row>
      )}
    </Section>
  );
});
