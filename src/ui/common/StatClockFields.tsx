import { useId, useRef, useState } from 'react';

import { STAT_CLOCK_DIGITS, parseKills } from '../../data/statClock';
import { Input } from '../primitives/Input';
import { Switch } from '../primitives/Switch';
import { Control, Row } from './controls';

function KillCountInput({ kills, onCommit }: { kills: number | null; onCommit: (kills: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  // Esc blurs the input before the cleared draft renders, so the blur has to be told not to commit.
  const cancelled = useRef(false);
  const commit = () => {
    const parsed = parseKills(draft ?? '');
    setDraft(null);
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    if (parsed !== null && parsed !== kills) onCommit(parsed);
  };
  return (
    <Input
      className="tabular-nums"
      inputMode="numeric"
      maxLength={STAT_CLOCK_DIGITS}
      placeholder={kills === null ? 'Mixed' : undefined}
      value={draft ?? (kills === null ? '' : String(kills))}
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setDraft(event.currentTarget.value.replace(/\D/g, ''))}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') {
          cancelled.current = true;
          event.currentTarget.blur();
        }
      }}
    />
  );
}

export function StatClockFields({ on, mixedOn = false, kills, lockedReason = null, onToggle, onKills }: {
  on: boolean;
  mixedOn?: boolean;
  kills: number | null;
  lockedReason?: string | null;
  onToggle: (on: boolean) => void;
  onKills: (kills: number) => void;
}) {
  const noteId = useId();
  const locked = lockedReason !== null;
  const note = lockedReason ?? (mixedOn ? 'Mixed' : null);
  return (
    <>
      {/* The note sits in the label row, so that locking moves nothing below it. Spelled out, since touch screens never show the tooltip. */}
      <Row label={<>Stat Clock{note && <span id={noteId} className="text-10">{note}</span>}</>}>
        <Switch
          checked={on && !locked}
          disabled={locked}
          describedBy={locked ? noteId : undefined}
          ariaLabel="Stat Clock"
          onChange={onToggle}
        />
      </Row>
      {(on || mixedOn) && !locked && (
        <Control label="Kill Count">
          <KillCountInput kills={kills} onCommit={onKills} />
        </Control>
      )}
    </>
  );
}
