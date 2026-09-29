import type { ReactNode } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Cancel01Icon } from '@hugeicons/core-free-icons';
import { Button, FocusedLayout, useText } from 'vaults-ui';
import { PAGES, type PageId, type Text } from '../pages.js';
import { go, homeOf } from '../router.js';
import { useSession } from '../session.js';

/**
 * A PAGE SHOWN ON ITS OWN, WITH NO MENU: the kit's focused layout, the page's
 * name across the top, and the way out, which goes to where the person's view
 * begins (their company's Home, or their own pay when they sign for no
 * company yet).
 */
export function FocusedFrame({ current, exit, children }: { current: PageId; exit: (t: Text) => string; children?: ReactNode }) {
  const t = useText();
  const { viewer } = useSession();
  return (
    <div className="contents" data-focused-frame={current}>
      <FocusedLayout
        title={PAGES[current].name(t)}
        exit={(
          <Button variant="ghost" size="sm" onClick={() => go(homeOf(viewer))} data-action="exit-focused">
            <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} data-icon="inline-start" />
            {exit(t)}
          </Button>
        )}
      >
        {children}
      </FocusedLayout>
    </div>
  );
}
