import { ComingSoon, EmptyState, PageHeader, useText } from 'vaults-ui';
import { HugeiconsIcon } from '@hugeicons/react';
import { outerOf, PAGES, type Page, type PageId, type Screen, type Text } from '../pages.js';

/**
 * A PAGE NOT BUILT YET: its name with the Coming soon pill, the part of it
 * already built when there is one, and what it will be, in the kit's empty
 * state. Nothing on it pretends to work. A page shown inside another (a tab of
 * Settings) draws no heading of its own, because the page around it already
 * has the one heading; it shows the pill, the built part and the empty state.
 */
export function ComingSoonPage({ id }: { id: PageId }) {
  const t = useText();
  const page = PAGES[id] as Page;
  const { comingSoon: soon, already: Already } = page.shows as { comingSoon?: (t: Text) => string; already?: Screen };
  const explanation = soon === undefined ? null : soon(t);
  const badge = explanation === null ? undefined : <ComingSoon explanation={explanation} />;
  return (
    <div className="flex flex-col gap-6" data-screen="coming-soon" data-page={id}>
      {outerOf(page) === undefined
        ? <PageHeader title={<><HugeiconsIcon icon={page.icon} strokeWidth={2} className="size-5 text-muted-foreground" />{page.name(t)}</>} badge={badge} />
        : badge === undefined ? null : <div className="flex items-center gap-2">{badge}</div>}
      {Already === undefined ? null : <Already />}
      {explanation === null ? null : <EmptyState icon={page.icon}>{explanation}</EmptyState>}
    </div>
  );
}
