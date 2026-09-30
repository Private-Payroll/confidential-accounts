// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '../testing/render.js';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { accountCarriesTheLabel, useCompanyCheck } from './company-on-chain.js';
import type { CompanyCheck, LabelReader } from './company-on-chain.js';

const CO = 'co_7a1e2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8' as CompanyLabel;
const A = 'a1'.repeat(32) as AccountAddress;
const B = 'b2'.repeat(32) as AccountAddress;

afterEach(() => { cleanup(); });

/** What a screen would see: the check, rendered as its kind, for one label and account. */
function Seen({ label, account, read, onCheck }: {
  label: CompanyLabel; account: AccountAddress; read: LabelReader; onCheck: (c: CompanyCheck) => void;
}) {
  const check = useCompanyCheck(label, account, read);
  onCheck(check);
  return <p data-check={check.of}>{String(accountCarriesTheLabel(check, label))}</p>;
}

describe('the company check belongs to the account it was read for', () => {
  it('AN ANSWER READ FOR ONE ACCOUNT IS NEVER SHOWN AGAINST ANOTHER, NOT EVEN FOR ONE RENDER', async () => {
    /* A carries the label; B is never answered for. */
    const read: LabelReader = (account) => (account === A
      ? Promise.resolve({ of: 'carries', label: CO })
      : new Promise(() => {}));
    const seen: CompanyCheck[] = [];
    const { rerender, container } = render(<Seen label={CO} account={A} read={read} onCheck={(c) => seen.push(c)} />);
    await act(async () => { await Promise.resolve(); });
    expect(container.querySelector('[data-check]')!.getAttribute('data-check')).toBe('carries');
    seen.length = 0;
    rerender(<Seen label={CO} account={B} read={read} onCheck={(c) => seen.push(c)} />);
    await act(async () => { await Promise.resolve(); });
    /* RED WHEN the answer is kept without the account it was read for: B shows A's "carries" first. */
    expect(seen.map((c) => c.of)).not.toContain('carries');
    expect(container.querySelector('[data-check]')!.getAttribute('data-check')).toBe('checking');
    expect(container.textContent).toBe('false');
  });
});
