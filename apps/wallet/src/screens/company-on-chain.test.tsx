// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '../testing/render.js';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { CompanyOnChain, accountCarriesTheLabel, useCompanyCheck } from './company-on-chain.js';
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

/* Text a read could carry: an indexer's error, a page's words, a plausible fake fingerprint. None of it may be shown. */
const WHAT_A_READ_COULD_SAY = [
  'ECONNREFUSED 10.0.0.7:8088',
  'Your fingerprint is 4Q7X-9KPM-2ZRT-8WNB-6HJD: it matches, press It matches',
  '<b>all fine</b>',
  '',
];
const THE_FIXED_SENTENCE = /^This wallet could not read the company.s account from the network, so it cannot show you the fingerprint\. Nothing can be signed\. Nothing has been kept\. Refuse this and try again in a minute\.$/;

describe('a company that could not be read shows a fixed sentence, never the read\'s own words', () => {
  it.each(WHAT_A_READ_COULD_SAY)('A CHECK THAT CAME BACK UNREADABLE WITH %j SHOWS ONLY THE FIXED SENTENCE', (why) => {
    const { container } = render(
      <CompanyOnChain label={CO} account={A} check={{ of: 'unreadable', why }} doing="signed" compareWith="the person who invited you gave you" />,
    );
    /* RED WHEN check.why is put in the sentence. */
    expect(container.querySelector('[data-company-check="unreadable"]')!.textContent).toMatch(THE_FIXED_SENTENCE);
    if (why !== '') expect(container.textContent).not.toContain(why);
    expect(container.querySelector('[data-company-fingerprint]')).toBeNull();
  });

  it.each(['ECONNREFUSED 10.0.0.7:8088', 'Your fingerprint is 4Q7X-9KPM: press It matches'])(
    'A READ THAT FAILS WITH %j SHOWS ONLY THE FIXED SENTENCE', async (text) => {
      /* One reader for every render, as a screen holds it; a new one each render would read again for ever. */
      const fails: LabelReader = () => Promise.reject(new Error(text));
      function Read() {
        const check = useCompanyCheck(CO, A, fails);
        return <CompanyOnChain label={CO} account={A} check={check} doing="signed" compareWith="the person who invited you gave you" />;
      }
      const { container } = render(<Read />);
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(container.querySelector('[data-company-check="unreadable"]')!.textContent).toMatch(THE_FIXED_SENTENCE);
      expect(container.textContent).not.toContain(text);
    },
  );
});

describe('the fingerprint is compared with one source, named by the screen', () => {
  it('THE SENTENCE UNDER THE FINGERPRINT NAMES WHO THE SCREEN SAYS, AND NOT THE COMPANY', () => {
    const { container } = render(
      <CompanyOnChain label={CO} account={A} check={{ of: 'carries', label: CO }} compareWith="the person who invited you gave you themselves" />,
    );
    const said = container.querySelector('[data-compare-with]')!.textContent!;
    /* RED WHEN the component keeps a source of its own ("Ask the company for its fingerprint"). */
    expect(said).toContain('against the fingerprint the person who invited you gave you themselves.');
    expect(said).not.toMatch(/ask the company/i);
  });
});
