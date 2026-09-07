import type { LabelHTMLAttributes, ReactNode } from 'react';
import { cn } from './cn.js';

/**
 * LABEL — a caption ABOVE its field, never beside it.
 *
 * That is a finding, already written into `app.css`'s `.send-field`: *"an
 * address is long and an amount is money; neither belongs squeezed beside its
 * caption."* The kit keeps it.
 */
export function Label({ className, ...rest }: LabelHTMLAttributes<HTMLLabelElement>): ReactNode {
  return (
    <label
      className={cn('mb-1.5 block text-sm font-medium text-muted', className)}
      {...rest}
    />
  );
}
