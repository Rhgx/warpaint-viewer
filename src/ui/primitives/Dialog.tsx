import { AlertDialog as AlertDialogPrimitive } from '@base-ui/react/alert-dialog';
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';

import { Button } from './Button';
import { cn } from './cn';
import { SECTION_TITLE } from './textStyles';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const AlertDialog = AlertDialogPrimitive.Root;

// Exported because the Controls reference manages its own focus, without a Base UI root, and must look the same.
export const DIALOG_VIEWPORT = 'fixed inset-0 z-1200 grid place-items-center bg-black/60 p-5 animate-dialog-backdrop motion-reduce:animate-none';
export const DIALOG_SURFACE = 'max-h-[calc(100dvh-40px)] w-[min(420px,100%)] origin-top overflow-auto rounded-lg border border-strong bg-panel text-text shadow-pop animate-dialog focus-ring motion-reduce:animate-none';
export const DIALOG_TITLE = 'm-0 text-13 leading-[1.2] font-semibold';

export function DialogHeader({ className, ...props }: ComponentProps<'header'>) {
  return <header className={cn('flex min-h-13.25 items-center justify-between gap-4 border-b border-border py-3 pr-3 pl-4', className)} data-slot="dialog-header" {...props} />;
}

export function DialogCloseButton(props: ComponentProps<typeof Button>) {
  return (
    <Button variant="ghost" size="icon-md" className="flex-none" data-slot="dialog-close" {...props}>
      <X size={16} />
    </Button>
  );
}

export function DialogBody({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('px-4 pt-3 pb-4', className)} data-slot="dialog-body" {...props} />;
}

/** A titled group inside a dialog. Sections settle in one after another rather than the whole card sliding as one block. */
export function DialogSection({ id, title, icon: Icon, className, children }: {
  id: string;
  title: string;
  icon?: LucideIcon;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn('animate-dialog-section first:[animation-delay:40ms] last:[animation-delay:80ms] motion-reduce:animate-none', className)} data-slot="dialog-section" aria-labelledby={id}>
      <h3 id={id} className={cn('mt-0 mb-0.5', SECTION_TITLE, Icon && 'flex items-center gap-1.5')}>
        {Icon && <Icon size={14} className="flex-none text-dim" aria-hidden="true" />}
        {title}
      </h3>
      {children}
    </section>
  );
}

/** Works under either root: Base UI builds AlertDialog out of these same Dialog parts. */
export function DialogPopup({ title, closeLabel, viewportClassName, surfaceClassName, children, ...props }: DialogPrimitive.Popup.Props & {
  title: string;
  /** Leave out when the dialog's own buttons include a way out: focus then lands on those first. */
  closeLabel?: string;
  viewportClassName?: string;
  surfaceClassName?: string;
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Viewport className={cn(DIALOG_VIEWPORT, viewportClassName)}>
        <DialogPrimitive.Popup className={cn(DIALOG_SURFACE, surfaceClassName)} data-slot="dialog-popup" {...props}>
          <DialogHeader>
            <DialogPrimitive.Title className={DIALOG_TITLE}>{title}</DialogPrimitive.Title>
            {closeLabel && <DialogPrimitive.Close aria-label={closeLabel} render={<DialogCloseButton />} />}
          </DialogHeader>
          {children}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Viewport>
    </DialogPrimitive.Portal>
  );
}
