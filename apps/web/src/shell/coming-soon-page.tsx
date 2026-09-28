import { ComingSoon, useText } from 'vaults-ui';
import { HugeiconsIcon } from '@hugeicons/react';
import { PAGES, type Page, type PageId, type Text } from '../pages.js';

/**
 * A PAGE NOT BUILT YET: its name, the Coming soon pill, and what it will be.
 * Nothing on it pretends to work.
 */
export function ComingSoonPage({ id }: { id: PageId }) {
  const t = useText();
  const page = PAGES[id] as Page;
  const soon = (page.shows as { comingSoon?: (t: Text) => string }).comingSoon;
  const explanation = soon === undefined ? null : soon(t);
  return (
    <section className="flex flex-col gap-3" data-screen="coming-soon" data-page={id}>
      <div className="flex flex-wrap items-center gap-2">
        <HugeiconsIcon icon={page.icon} strokeWidth={2} className="size-5 text-muted-foreground" />
        <h1 className="text-xl font-semibold">{page.name(t)}</h1>
        {explanation === null ? null : <ComingSoon explanation={explanation} />}
      </div>
      {explanation === null ? null : <p className="max-w-prose text-sm text-muted-foreground">{explanation}</p>}
    </section>
  );
}
