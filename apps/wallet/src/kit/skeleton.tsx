import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn.js';

/**
 * SKELETON — the shape of a number that has not arrived.
 *
 * THE KEYFRAME LIVES IN `app.css`, BESIDE THE SHELL'S TWO, not in this file.
 * THE RULE: *"motion lives in the shell, not in screens, so
 * there is one place to tune it and one place to respect
 * `prefers-reduced-motion`."* `motion-safe:` is that respect at the call site;
 * with motion reduced this is a still block, which is a correct skeleton.
 *
 * IT IS `aria-hidden`. A screen reader announcing "loading loading loading"
 * once per placeholder is worse than silence; the CONTAINER carries
 * `aria-busy` and the real announcement, which is a job for the screen.
 *
 * AND IT IS NOT A BALANCE — a dead network may never read as a wait
 * that never ends. A skeleton says *this is arriving*; when it is not
 * arriving, the honest failure state has words, and this component must never
 * be what a person is left looking at.
 */
export function Skeleton({ className, ...rest }: HTMLAttributes<HTMLDivElement>): ReactNode {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'block rounded-tight bg-sunken',
        'motion-safe:animate-[kit-pulse_1.5s_var(--motion-ease)_infinite]',
        className,
      )}
      {...rest}
    />
  );
}
