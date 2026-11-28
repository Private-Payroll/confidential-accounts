import type { ReactNode } from 'react';

export function Chapter({
  id,
  title,
  says,
  children
}: {
  readonly id: string;
  readonly title: string;
  readonly says?: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <section id={id} className="mb-12 scroll-mt-4">
      <div className="mb-4 border-b border-border pb-2">
        <h2 className="m-0 text-lg font-semibold text-foreground">{title}</h2>
        {says !== undefined && <p className="m-0 mt-1 text-sm text-muted-foreground">{says}</p>}
      </div>
      {children}
    </section>
  );
}

/** A labelled cell, so every specimen on the page says what it is. The optional
 * badge is how a variant carries a RULE beside its name rather than in a
 * paragraph somebody scrolls past. */
export function Spec({
  label,
  children,
  className,
  badge
}: {
  readonly label: string;
  readonly children: ReactNode;
  readonly className?: string;
  readonly badge?: ReactNode;
}): ReactNode {
  return (
    <div className={className}>
      <p className="m-0 mb-2 flex flex-wrap items-center gap-2 font-mono text-xs text-muted-foreground">
        <span>{label}</span>
        {badge}
      </p>
      {children}
    </div>
  );
}

export function Swatch({
  token,
  name,
  note
}: {
  readonly token: string;
  readonly name: string;
  readonly note?: string;
}): ReactNode {
  return (
    <div className="flex items-center gap-3">
      <span
        className="size-10 shrink-0 rounded-md border border-border"
        style={{ background: `var(${token})` }}
        aria-hidden="true"
      />
      <span className="min-w-0">
        <span className="block font-mono text-xs text-foreground">{name}</span>
        {note !== undefined && <span className="block text-xs text-muted-foreground">{note}</span>}
      </span>
    </div>
  );
}
