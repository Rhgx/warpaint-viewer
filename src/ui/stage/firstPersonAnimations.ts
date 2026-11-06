const activities: Record<string, [group: string, label: string]> = {
  ACT_VM_IDLE: ['Basic', 'Idle'],
  ACT_VM_DRAW: ['Basic', 'Draw'],
  ACT_VM_INSPECT_START: ['Basic', 'Inspect Start'],
  ACT_VM_INSPECT_IDLE: ['Basic', 'Inspect'],
  ACT_VM_INSPECT_END: ['Basic', 'Inspect End'],
  ACT_VM_PRIMARYATTACK: ['Attack', 'Primary Attack'],
  ACT_VM_SECONDARYATTACK: ['Attack', 'Secondary Attack'],
  ACT_VM_HITCENTER: ['Attack', 'Swing'],
  ACT_VM_SWINGHARD: ['Attack', 'Heavy Swing'],
  ACT_VM_PULLBACK: ['Attack', 'Charge'],
  ACT_MP_ATTACK_STAND_PREFIRE: ['Attack', 'Spin Up'],
  ACT_MP_ATTACK_STAND_POSTFIRE: ['Attack', 'Spin Down'],
  ACT_RELOAD_START: ['Basic', 'Reload Start'],
  ACT_VM_RELOAD: ['Basic', 'Reload'],
  ACT_RELOAD_FINISH: ['Basic', 'Reload End'],
  ACT_BACKSTAB_VM_UP: ['Special', 'Backstab Ready'],
  ACT_BACKSTAB_VM_IDLE: ['Special', 'Backstab Idle'],
  ACT_BACKSTAB_VM_DOWN: ['Special', 'Backstab Lower'],
  ACT_VM_STUN: ['Special', 'Stun'],
};

// What the game chains into one action, keyed by the loop in the middle. Spin Up and Spin Down stay apart: a minigun
// moves between its spinning and firing loops at will, so they are not one line.
const sequences: Record<string, { label: string; start: string; end: string }> = {
  ACT_VM_INSPECT_IDLE: { label: 'Inspect', start: 'ACT_VM_INSPECT_START', end: 'ACT_VM_INSPECT_END' },
  ACT_VM_RELOAD: { label: 'Reload', start: 'ACT_RELOAD_START', end: 'ACT_RELOAD_FINISH' },
  ACT_BACKSTAB_VM_IDLE: { label: 'Backstab', start: 'ACT_BACKSTAB_VM_UP', end: 'ACT_BACKSTAB_VM_DOWN' },
};

/** Keep activity identities across weapons, while exposing every alternate clip. */
export function firstPersonAnimationGroups(clips: Record<string, string | string[]>, weaponKey?: string) {
  const chargeable = weaponKey === 'c_demo_cannon' || weaponKey === 'c_stickybomb_launcher';
  const firstClip = (key: string) => [clips[key]].flat()[0];
  const sequenceOf = (key: string) => {
    const sequence = sequences[key];
    return sequence && clips[key] && clips[sequence.start] && clips[sequence.end] ? sequence : undefined;
  };
  const merged = new Set(Object.keys(sequences).flatMap(key => {
    const sequence = sequenceOf(key);
    return sequence ? [sequence.start, sequence.end] : [];
  }));
  const keys = [
    ...Object.keys(activities).filter(key => key !== 'ACT_VM_PULLBACK' || chargeable),
    ...Object.keys(clips).filter(key => key !== 'ACT_VM_PULLBACK' || chargeable).filter(key => !activities[key]),
  ].filter(key => !merged.has(key));
  const options = keys.flatMap(key => {
    const value = clips[key];
    if (!value) return [];
    const variants = Array.isArray(value) ? value : [value];
    const [group, label] = activities[key] ?? ['Other', key.replace(/^ACT_/, '').split('_')
      .map(word => word[0] + word.slice(1).toLowerCase()).join(' ')];
    const sequence = sequenceOf(key);
    // Shares its id with a plain Reload, so that a chosen Reload carries over between weapons with and without one.
    if (sequence) return [{ id: `${key}:0`, clips: [firstClip(sequence.start), firstClip(key), firstClip(sequence.end)], group, label: sequence.label }];
    return variants.map((clip, index) => ({
      id: `${key}:${index}`, clips: [clip], group,
      label: variants.length > 1 ? `${label} ${index + 1}` : label,
    }));
  });
  return [...new Set(options.map(option => option.group))].map(label => ({
    label, options: options.filter(option => option.group === label),
  }));
}

/** Rounded down, with a little slack so that a binary 2.3 does not read as 2.2. */
export function formatPlaybackTime(seconds: number): string {
  const tenths = Math.floor(Math.max(seconds, 0) * 10 + 1e-6);
  const minutes = Math.floor(tenths / 600);
  const rest = (tenths - minutes * 600) / 10;
  return `${minutes}:${rest.toFixed(1).padStart(4, '0')}`;
}
