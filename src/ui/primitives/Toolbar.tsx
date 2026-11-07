import type { ComponentProps } from 'react';

import { Button } from './Button';
import { cn } from './cn';

// A blur over the live canvas is redone on every frame, which a phone's GPU pays for during gestures.
export const STAGE_PANEL = 'flex gap-1 rounded-md border border-strong bg-panel/82 p-1 shadow-pop backdrop-blur-[6px] touch:gap-1.5 touch:bg-panel/92 touch:backdrop-blur-none';

/** The icon row floating over a stage. Its button size is what overlays under it offset by. */
export function Toolbar({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(STAGE_PANEL, 'absolute top-2.5 right-2.5 z-2 mobile:top-[calc(10px+env(safe-area-inset-top))] mobile:right-[calc(10px+env(safe-area-inset-right))]', className)}
      data-slot="toolbar"
      {...props}
    />
  );
}

export function ToolbarButton(props: ComponentProps<typeof Button>) {
  return <Button variant="toolbar" size="icon" {...props} />;
}

export function ToolbarDivider() {
  return <span className="mx-px my-0.75 w-px self-stretch bg-border" aria-hidden="true" />;
}
