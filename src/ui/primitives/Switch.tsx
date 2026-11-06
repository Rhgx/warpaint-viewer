import { Switch as SwitchPrimitive } from '@base-ui/react/switch';

export function Switch({ checked, onChange, ariaLabel }: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  ariaLabel?: string;
}) {
  return (
    <SwitchPrimitive.Root
      className="h-4.5 w-8.5 cursor-pointer rounded-[9px] border border-strong bg-border p-px transition-fast focus-ring data-checked:bg-accent"
      data-slot="switch"
      checked={checked}
      onCheckedChange={onChange}
      aria-label={ariaLabel}
    >
      <SwitchPrimitive.Thumb className="block size-3.5 rounded-full bg-white [transition:translate_120ms] data-checked:translate-x-4" />
    </SwitchPrimitive.Root>
  );
}
