import { Menu as MenuPrimitive } from '@base-ui/react/menu';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from './cn';

export const Menu = MenuPrimitive.Root;
export const MenuTrigger = MenuPrimitive.Trigger;

type PositionerProps = Pick<MenuPrimitive.Positioner.Props, 'side' | 'align' | 'sideOffset' | 'collisionPadding'>;

export function MenuPopup({ className, side = 'bottom', align = 'center', sideOffset = 4, collisionPadding = 10, ...props }: MenuPrimitive.Popup.Props & PositionerProps) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner className="z-1100" data-slot="menu-positioner" side={side} align={align} sideOffset={sideOffset} collisionPadding={collisionPadding}>
        <MenuPrimitive.Popup
          className={cn('min-w-42.5 rounded-md border border-strong bg-panel p-1 text-12 shadow-pop outline-none', className)}
          data-slot="menu-popup"
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

const menuItemVariants = cva(
  // group: a detail line inside an item follows the item's highlight.
  'group flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.25 outline-none select-none data-disabled:cursor-default data-disabled:opacity-45',
  {
    defaultVariants: { variant: 'default' },
    variants: {
      variant: {
        default: 'text-text data-highlighted:bg-accent data-highlighted:text-accent-text',
        danger: 'text-fail data-highlighted:bg-fail data-highlighted:text-white',
      },
    },
  },
);

export function MenuItem({ className, variant, ...props }: MenuPrimitive.Item.Props & VariantProps<typeof menuItemVariants>) {
  return <MenuPrimitive.Item className={cn(menuItemVariants({ variant }), className)} data-slot="menu-item" {...props} />;
}

export function MenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
  return <MenuPrimitive.Separator className={cn('my-1 h-px bg-border', className)} data-slot="menu-separator" {...props} />;
}
