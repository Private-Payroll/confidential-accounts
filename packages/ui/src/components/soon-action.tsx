import type { HTMLAttributes, ReactNode } from 'react';
import { Button } from 'vaults-ui/components/button';
import { ComingSoon } from 'vaults-ui/components/coming-soon';

export interface SoonActionProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children' | 'className' | 'style'> {
  /** What the action will be called, already in the person's language. */
  label: string;
  /** What it will do, shown by its Coming soon pill. */
  soon: ReactNode;
  /** An icon before the label, as the working action will have. */
  icon?: ReactNode;
  /** The main action of its part of the page is filled; a second one is outlined. */
  variant?: 'default' | 'outline';
  /** A row's own action is the smaller size. */
  size?: 'default' | 'sm';
}

/**
 * AN ACTION NOT BUILT YET: always shown where it will be, the size and weight
 * it will have, never pressable, with the Coming soon pill after it saying
 * what it will do. The pill is quieter than the button, so the page reads as
 * it will once the action works, and nothing pretends to work now.
 */
export function SoonAction({ label, soon, icon, variant = 'default', size = 'default', ...marks }: SoonActionProps) {
  return (
    <span className="inline-flex items-center gap-2" data-slot="soon-action" data-soon {...marks}>
      <Button variant={variant} size={size} disabled>{icon}{label}</Button>
      <ComingSoon explanation={soon} />
    </span>
  );
}
