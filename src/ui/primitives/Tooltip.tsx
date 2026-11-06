import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip';

import { cn } from './cn';

export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

/** A hint popover wears this too, so that hints look the same however they open. */
export const TOOLTIP_SURFACE = 'max-w-[min(260px,var(--available-width))] rounded-sm border border-strong bg-panel px-2.5 py-2 text-12 leading-[1.45] text-text shadow-pop';

type PositionerProps = Pick<TooltipPrimitive.Positioner.Props, 'side' | 'align' | 'sideOffset' | 'collisionPadding'>;

export function TooltipPopup({ className, side = 'top', align = 'center', sideOffset = 6, collisionPadding = 10, ...props }: TooltipPrimitive.Popup.Props & PositionerProps) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner className="z-1100" data-slot="tooltip-positioner" side={side} align={align} sideOffset={sideOffset} collisionPadding={collisionPadding}>
        <TooltipPrimitive.Popup
          className={cn(TOOLTIP_SURFACE, className)}
          data-slot="tooltip-popup"
          {...props}
        />
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}
