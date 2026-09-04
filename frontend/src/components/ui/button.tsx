import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

/**
 * Restrained button variants for an incident-command surface: the primary
 * action is neutral near-black (not a brand blue), and severity/action intent
 * is carried by `confirm` (muted green) and `destructive` (muted red) rather
 * than saturated candy colors or pill shapes. No shadow, no gradient.
 */
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-[12px] font-semibold ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
        outline: 'border border-input bg-background hover:bg-accent hover:text-accent-foreground',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
        confirm: 'bg-state-confirmed text-white hover:bg-state-confirmed/90',
        // Pastel variants for a binary decision pair (approve/reject a
        // proposed action) where a solid destructive fill would be louder
        // than the moment warrants -- the tint carries the meaning.
        reject: 'bg-state-critical/10 text-state-critical border border-state-critical/25 hover:bg-state-critical/15',
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-7 rounded-md px-3 text-[11px]',
        xs: 'h-6 rounded px-2 text-[10.5px]',
        lg: 'h-10 rounded-md px-8',
        icon: 'h-9 w-9',
        // Exact pixel matches for the two compact sizes voice-test's control
        // deck already used (.vcc-btn-compact / .vcc-btn-mini), so swapping
        // the element doesn't shift anything visually.
        compact: 'h-[30px] px-2.5 py-1 text-[11px] rounded-lg',
        mini: 'h-[26px] px-2.5 py-1 text-[10px] rounded-sm',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = 'Button';

export { Button, buttonVariants };
