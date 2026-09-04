import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

/**
 * Status/evidence badges. Deliberately NOT pill-shaped (rounded-sm, not
 * rounded-full) -- a pill reads as decorative chrome; a small rectangular tag
 * reads as a data label. Semantic variants use a thin border + tinted text on
 * a near-transparent tint, not a saturated filled background, so the badge
 * doesn't compete visually with the evidence text it's labeling.
 */
const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide transition-colors',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-border bg-secondary text-secondary-foreground',
        outline: 'border-border text-foreground',
        confirmed: 'border-state-confirmed/30 bg-state-confirmed/10 text-state-confirmed',
        warning: 'border-state-warning/30 bg-state-warning/10 text-state-warning',
        critical: 'border-state-critical/30 bg-state-critical/10 text-state-critical',
        info: 'border-state-info/30 bg-state-info/10 text-state-info',
        inference: 'border-state-inference/30 bg-state-inference/10 text-state-inference',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
