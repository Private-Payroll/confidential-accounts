import { Button, useText } from 'vaults-ui';
import { VIEWS } from '../pages.js';
import { useSession } from '../session.js';

/** WHILE A PERSON WHO SIGNS FOR A COMPANY SEES THEIR OWN PAY, a line saying so, and the way back. */
export function ViewBanner() {
  const t = useText();
  const { viewer, chooseView } = useSession();
  if (!viewer.signs || viewer.view !== VIEWS.employee) return null;
  return (
    <div className="flex flex-wrap items-center gap-3 border-b bg-muted px-4 py-2 text-sm" role="status" data-view-banner>
      <span>{t('view.banner')}</span>
      <Button size="sm" variant="outline" onClick={() => chooseView(VIEWS.company)}>{t('view.toCompany')}</Button>
    </div>
  );
}
