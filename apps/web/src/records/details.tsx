import type { ReactNode } from 'react';
import { Item, ItemContent, ItemDescription, ItemTitle } from 'vaults-ui';

/**
 * A RECORD'S DETAILS, IN A PANEL: one to a line, what each is at the start
 * and its value at the end, each the kit's item. A value is never cut short.
 * Kept apart from the parts every page shares, so the item is loaded only
 * with the pages whose panels show details.
 */
export function Details({ rows }: { rows: readonly (readonly [label: string, value: ReactNode])[] }) {
  return (
    <div className="flex flex-col" data-details>
      {rows.map(([label, value]) => (
        <Item key={label} size="sm" className="px-0">
          <ItemContent><ItemDescription>{label}</ItemDescription></ItemContent>
          <ItemContent><ItemTitle className="line-clamp-none">{value}</ItemTitle></ItemContent>
        </Item>
      ))}
    </div>
  );
}
