import { ComingSoon, EmptyState, PageHeader, useText } from 'vaults-ui';
import { HugeiconsIcon } from '@hugeicons/react';
import { PAGES, type Page, type PageId, type Screen, type Text } from '../pages.js';

/**
 * A PAGE NOT BUILT YET: its name with the Coming soon pill, the part of it
 * already built when there is one, and what it will be, in the kit's empty
 * state. Nothing on it pretends to work.
 */
export function ComingSoonPage({ id }: { id: PageId }) {
  const t = useText();
  const page = PAGES[id] as Page;
  const { comingSoon: soon, already: Already } = page.shows as { comingSoon?: (t: Text) => string; already?: Screen };
  const explanation = soon === undefined ? null : soon(t);
  return (
    <div className="flex flex-col gap-6" data-screen="coming-soon" data-page={id}>
      <PageHeader
        title={<><HugeiconsIcon icon={page.icon} strokeWidth={2} className="size-5 text-muted-foreground" />{page.name(t)}</>}
        badge={explanation === null ? undefined : <ComingSoon explanation={explanation} />}
      />
      {Already === undefined ? null : <Already />}
      {explanation === null ? null : <EmptyState icon={page.icon}>{explanation}</EmptyState>}
    </div>
  );
}
