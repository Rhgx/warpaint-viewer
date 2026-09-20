const activities: Record<string, [group: string, label: string]> = {
  ACT_VM_IDLE: ['Basic', 'Idle'],
  ACT_VM_DRAW: ['Basic', 'Draw'],
  ACT_VM_INSPECT_START: ['Inspect', 'Inspect Start'],
  ACT_VM_INSPECT_IDLE: ['Inspect', 'Inspect'],
  ACT_VM_INSPECT_END: ['Inspect', 'Inspect End'],
  ACT_VM_PRIMARYATTACK: ['Attack', 'Primary Attack'],
  ACT_VM_SECONDARYATTACK: ['Attack', 'Secondary Attack'],
  ACT_VM_HITCENTER: ['Attack', 'Swing'],
  ACT_VM_SWINGHARD: ['Attack', 'Heavy Swing'],
  ACT_VM_PULLBACK: ['Attack', 'Charge'],
  ACT_MP_ATTACK_STAND_PREFIRE: ['Attack', 'Spin Up'],
  ACT_MP_ATTACK_STAND_POSTFIRE: ['Attack', 'Spin Down'],
  ACT_RELOAD_START: ['Reload', 'Reload Start'],
  ACT_VM_RELOAD: ['Reload', 'Reload'],
  ACT_RELOAD_FINISH: ['Reload', 'Reload End'],
  ACT_BACKSTAB_VM_UP: ['Special', 'Backstab Ready'],
  ACT_BACKSTAB_VM_IDLE: ['Special', 'Backstab Idle'],
  ACT_BACKSTAB_VM_DOWN: ['Special', 'Backstab Lower'],
  ACT_VM_STUN: ['Special', 'Stun'],
};

/** Keep activity identities across weapons, while exposing every alternate clip. */
export function firstPersonAnimationGroups(clips: Record<string, string | string[]>) {
  const keys = [...Object.keys(activities), ...Object.keys(clips).filter(key => !activities[key])];
  const options = keys.flatMap(key => {
    const value = clips[key];
    if (!value) return [];
    const variants = Array.isArray(value) ? value : [value];
    const [group, label] = activities[key] ?? ['Other', key.replace(/^ACT_/, '').split('_')
      .map(word => word[0] + word.slice(1).toLowerCase()).join(' ')];
    return variants.map((clip, index) => ({
      id: `${key}:${index}`, clip, group,
      label: variants.length > 1 ? `${label} ${index + 1}` : label,
    }));
  });
  return [...new Set(options.map(option => option.group))].map(label => ({
    label, options: options.filter(option => option.group === label),
  }));
}
