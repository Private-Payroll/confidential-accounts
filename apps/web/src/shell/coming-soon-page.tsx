import { ComingSoon, EmptyState, PageHeader, useText } from 'vaults-ui';
import { HugeiconsIcon } from '@hugeicons/react';
import { PAGES, type Page, type PageId, type Text } from '../pages.js';

/**
 * A PAGE NOT BUILT YET: its name with the Coming soon pill, and what it will
 * be, in the kit's empty state. Nothing on it pretends to work.
 */
export function ComingSoonPage({ id }: { id: PageId }) {
  const t = useText();
  const page = PAGES[id] as Page;
  const soon = (page.shows as { comingSoon?: (t: Text) => string }).comingSoon;
  const explanation = soon === undefined ? null : soon(t);
  return (
    <div className="flex flex-col gap-6" data-screen="coming-soon" data-page={id}>
      <PageHeader
        title={<><HugeiconsIcon icon={page.icon} strokeWidth={2} className="size-5 text-muted-foreground" />{page.name(t)}</>}
        badge={explanation === null ? undefined : <ComingSoon explanation={explanation} />}
      />
      {explanation === null ? null : <EmptyState icon={page.icon}>{explanation}</EmptyState>}
    </div>
  );
}
