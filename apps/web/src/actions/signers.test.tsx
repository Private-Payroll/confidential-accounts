// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KitProvider, languagesFrom } from 'vaults-ui';
import { DEFAULT_PREFERENCES } from '../preferences.js';
import { VIEWS } from '../pages.js';

/*
 * THE SIGNERS PAGE'S COMPONENT, DRAWN over the real adapters and the real wallet wrappers, with only the call to the wallet and the
 * company's records stood in for: who stands where, which invitations wait for approvals, and what each press asks of the wallet.
 */
vi.hoisted(() => { vi.stubEnv('VITE_WALLET_ORIGIN', 'http://wallet.localhost:5180'); });
const kr = vi.hoisted(() => ({
  acts: [] as Record<string, string>[], ended: { of: 'done', steps: 1, relayed: 0 } as unknown, steps: [] as { step: number; steps: number }[],
  hold: null as Promise<void> | null, company: null as unknown, reads: 0, reloads: 0, user: { id: 'u1' } as { id: string } | null,
  /** Where the company stands, as the committee change reads it, and what signing a change comes to. */
  handover: { of: 'held' } as Record<string, unknown>, signed: { of: 'done' } as Record<string, unknown>, signs: 0,
}));
vi.mock('vaults-web-shared/keyring.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/keyring.js')>()),
  currentUser: () => kr.user,
  forgetLocally: () => {},
  resumeSession: async () => null,
  api: async () => ({ companyLabel: 'label-1', contractAddress: 'c0'.repeat(32) }),
  actOnACompanyInTheWallet: async (intent: Record<string, string>, _origin: string, opts?: { onStep?: (at: { step: number; steps: number }) => void }) => {
    kr.acts.push(intent);
    for (const at of kr.steps) opts?.onStep?.(at);
    if (kr.hold !== null) await kr.hold;
    return kr.ended;
  },
}));
vi.mock('../records/company-records.js', async (real) => {
  const actual = await real<typeof import('../records/company-records.js')>();
  const { useMemo } = await import('react');
  return {
    ...actual,
    useCompanyRecords: () => {
      const records = actual.useCompanyRecords();
      return useMemo(() => ({ ...records, reload: () => { kr.reloads += 1; records.reload(); } }), [records]);
    },
  };
});
vi.mock('../adapters/company-records.js', async (real) => ({
  ...(await real<typeof import('../adapters/company-records.js')>()),
  readCompany: async () => { kr.reads += 1; return kr.company; },
}));
vi.mock('../adapters/handover-state.js', async (real) => ({
  ...(await real<typeof import('../adapters/handover-state.js')>()),
  readHandover: vi.fn(async () => kr.handover),
}));
vi.mock('../adapters/committee-change.js', () => ({
  signChange: vi.fn(async () => { kr.signs += 1; return kr.signed; }),
}));
vi.mock('../adapters/session.js', async (real) => ({
  ...(await real<typeof import('../adapters/session.js')>()),
  companyNamesFor: async () => new Map(),
}));

const { Signers } = await import('./signers.js');
const { SessionProvider } = await import('../session.js');
const { PanelProvider, RightPanel } = await import('../shell/right-panel.js');
const { CompanyRecordsProvider } = await import('../records/company-records.js');
const { WHY } = await import('../adapters/signer-acts.js');

(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
Element.prototype.hasPointerCapture ??= function hasPointerCapture() { return false; };
const EN = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../locales/en.json'), 'utf8')) as Record<string, string>;
const en = (key: string): string => EN[key] ?? key;
const LANGUAGES = languagesFrom({ './locales/en.json': EN });
const PRIVATE = 'mn_shield-addr_stagenet1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyq4kk6mtdd4kk6mtdd4kk6mtdd4kk6mtdd4kk6mtdd4kk6mtdd4kkcvfvr0u';
const HEX = (n: number): string => n.toString(16).padStart(2, '0').repeat(32);

const standing = (id: string, name: string, accepted: boolean, seatOnChain: boolean, over: Record<string, unknown> = {}) => ({ id, name, accepted, seatOnChain, ...over });
/* The founding seat saved under the create step's name for a person with none, and the seat this device holds, just added. */
const youJustAdded = (entryFiled: boolean | null) => read([
  standing('s1', 'You', false, true, { you: false, entryFiled: true }), standing('s2', 'KC-Wallet 2', false, true, { you: true, entryFiled }),
]);
const invited = (over: Record<string, unknown> = {}) => ({
  proposal: 'prop_1', name: 'Sam', role: 'approver', address: HEX(1), scope: HEX(2), coinKey: HEX(3), status: 'open', approvals: null, seat: null, needed: 3, ...over,
});
const read = (value: unknown) => ({ of: 'read', value });
const records = (over: Record<string, unknown> = {}) => ({
  of: 'open', id: 'c-1', name: 'Northwind', signers: [{ id: 's1', name: 'Priya' }, { id: 's2', name: 'Raj' }, { id: 's3', name: 'Tia' }, { id: 's4', name: 'Uma' }, { id: 's5', name: 'Vik' }],
  approvalsNeeded: read(2),
  approvalsForSigners: read({ count: 3, raisedAboveTheAccount: true, vaultsAtThatNumber: [] }),
  signerStandings: read([standing('s1', 'Priya', false, true), standing('s2', 'Raj', true, true), standing('s3', 'Tia', true, false), standing('s4', 'Uma', false, false)]),
  signersInvited: read([invited()]),
  ...over,
});

const session = () => ({
  person: { id: 'u1', name: 'Priya' }, companies: [], company: 'c-1', chooseCompany: vi.fn(), viewer: { signedIn: true, view: VIEWS.company, signs: true },
  chooseView: vi.fn(), preferences: DEFAULT_PREFERENCES, choose: vi.fn(), signOut: vi.fn(), mac: true, companiesChanged: vi.fn(async () => {}),
});
const inPage = (node: React.ReactNode) => render(
  <KitProvider languages={LANGUAGES} pick="en">
    <SessionProvider session={session()}><PanelProvider><CompanyRecordsProvider>{node}<RightPanel /></CompanyRecordsProvider></PanelProvider></SessionProvider>
  </KitProvider>,
);
const settle = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); }); };
const q = (s: string): HTMLElement | null => document.body.querySelector(s);
const qa = (s: string): HTMLElement[] => [...document.body.querySelectorAll<HTMLElement>(s)];
const press = async (selector: string) => { fireEvent.click(q(selector)!); await settle(); };
const draw = async (node: React.ReactNode = <Signers />) => { inPage(node); await settle(); };

beforeEach(() => {
  kr.acts = []; kr.steps = []; kr.hold = null; kr.reads = 0; kr.reloads = 0; kr.user = { id: 'u1' }; kr.company = records();
  kr.handover = { of: 'held' }; kr.signed = { of: 'done' }; kr.signs = 0;
  kr.ended = { of: 'done', steps: 4, relayed: 1, outcome: { state: 'approved' } };
});
afterEach(cleanup);

describe('where each signer stands', () => {
  /* RED WHEN: a signer the network does not hold is shown as seated, a signer who accepted is shown as seated before the network holds their seat, or one waiting to be finished is told as seated. */
  it('tells a seated signer, one who accepted and waits for the network, one waiting to be finished, and one the network does not hold', async () => {
    await draw();
    const stands = Object.fromEntries(qa('[data-signer]').map((r) => [r.dataset['signer'], [r.dataset['standing'], r.textContent!]]));
    expect(Object.keys(stands)).toEqual(['s1', 's2', 's3', 's4']);
    expect(stands['s1']![0]).toBe('seated');
    expect(stands['s2']![0]).toBe('finish');
    expect(stands['s3']![0]).toBe('accepted');
    expect(stands['s4']![0]).toBe('not-seated');
    expect(stands['s1']![1]).toContain(en('signers.standing.seated'));
    expect(stands['s2']![1]).toContain(en('signers.standing.finish'));
    expect(stands['s3']![1]).toContain(en('signers.standing.accepted'));
    expect(stands['s4']![1]).toContain(en('signers.standing.notSeated'));
  });

  /* RED WHEN: a signer waiting on the network or on their own link is not told who acts and what happens next, or one who needs nothing from the person is told to wait. */
  it('says who acts next for a signer who accepted and waits, and for one not seated yet, and for nobody else', async () => {
    await draw();
    const nextOf = (id: string) => qa(`[data-signer=${id}] [data-next-for-them]`).map((n) => n.textContent);
    expect(nextOf('s3')).toEqual([en('signers.standing.acceptedNext')]);
    expect(nextOf('s4')).toEqual([en('signers.standing.notSeatedNext')]);
    expect([nextOf('s1'), nextOf('s2')]).toEqual([[], []]);
    expect(en('signers.standing.notSeatedNext')).toMatch(/open their invitation link and take the seat in their own wallet/);
  });

  /* RED WHEN: a read of the standings that failed is shown as a list of seated signers. */
  it('says so when where each signer stands could not be read', async () => {
    kr.company = records({ signerStandings: { of: 'unreadable' } });
    await draw();
    expect(q('[data-signer]')).toBeNull();
    expect(q('[data-standings-unread]')!.textContent).toBe(en('signers.standing.unread'));
  });
});

describe('finishing the addition of a signer', () => {
  /* RED WHEN: Finish adding is offered before the network holds the signer's seat, for a signer already added, or is missing for the one it is for. */
  it('offers Finish adding only to a signer who accepted and whose seat the network holds', async () => {
    await draw();
    expect(qa('[data-action=finish-adding]').map((b) => b.closest('[data-signer]')!.getAttribute('data-signer'))).toEqual(['s2']);
    expect(q('[data-action=finish-adding]')!.textContent).toBe(en('signers.finish'));
  });

  /* RED WHEN: Finish adding asks the wallet to admit another signer than the one pressed, or the records are not read again after it is done. */
  it('asks the wallet to admit the signer pressed, says so, and reads the records again', async () => {
    kr.ended = { of: 'done', steps: 4, relayed: 1, outcome: { state: 'admitted' } };
    await draw();
    await press('[data-action=finish-adding]');
    expect(kr.acts).toEqual([{ name: 'admit-signer', record: 'c-1', company: 'label-1', account: 'c0'.repeat(32), signer: 's2', personName: 'Raj' }]);
    expect(q('[data-acted=admit-signer]')!.textContent).toBe(en('signers.done.admitted').replace('{name}', 'Raj'));
    expect(kr.reads).toBe(2);
  });

  /* RED WHEN: an addition already finished is told as a failure. */
  it('says an addition already finished was already finished', async () => {
    kr.ended = { of: 'done', steps: 4, relayed: 0, outcome: { state: 'already-admitted' } };
    await draw();
    await press('[data-action=finish-adding]');
    expect(q('[data-acted=admit-signer]')!.textContent).toBe(en('signers.done.alreadyAdmitted').replace('{name}', 'Raj'));
  });
});

describe('you, and giving your keys once you are seated', () => {
  /* RED WHEN: you is shown on any row but the one the adapter marked as the seat this device holds, or a signer saved under the name You is left to read as you. */
  it('marks as you only the seat this device holds, and says a signer saved under the name You is another signer', async () => {
    kr.company = records({ signerStandings: youJustAdded(true) });
    await draw();
    expect(qa('[data-you]').map((b) => [b.closest('[data-signer]')!.getAttribute('data-signer'), b.textContent])).toEqual([['s2', en('signers.you')]]);
    expect(qa('[data-named-you]').map((n) => n.closest('[data-signer]')!.getAttribute('data-signer'))).toEqual(['s1']);
    expect(q('[data-named-you]')!.textContent).toBe(en('signers.namedYou'));
  });

  /* RED WHEN: Give your keys is offered on another signer's row, to a seat whose entry the directory holds or could not be read, or is missing from your own seat waiting for it. */
  it('offers Give your keys on your own seated row alone, while the company\'s directory holds no entry for it', async () => {
    kr.company = records({ signerStandings: youJustAdded(false) });
    await draw();
    expect(qa('[data-action=give-vault-keys]').map((b) => b.closest('[data-signer]')!.getAttribute('data-signer'))).toEqual(['s2']);
    expect(q('[data-give-keys-why]')!.textContent).toBe(en('signers.giveKeys.why'));
    for (const filed of [true, null]) {
      cleanup();
      kr.company = records({ signerStandings: youJustAdded(filed) });
      await draw();
      expect(q('[data-action=give-vault-keys]'), String(filed)).toBeNull();
    }
    cleanup();
    kr.company = records({ signerStandings: read([standing('s1', 'Priya', false, true, { you: false, entryFiled: false })]) });
    await draw();
    expect(q('[data-action=give-vault-keys]')).toBeNull();
  });

  /* RED WHEN: Give your keys asks the wallet for another act or another company, says nothing of who gives the vault's secret next, or the records are not read again. */
  it('asks the wallet to give your keys for this company, says who gives you each vault\'s secret next, and reads the records again', async () => {
    kr.company = records({ signerStandings: youJustAdded(false) });
    kr.ended = { of: 'done', steps: 4, relayed: 1, outcome: { upkeep: 'partial' } };
    await draw();
    await press('[data-action=give-vault-keys]');
    expect(kr.acts).toEqual([{ name: 'give-vault-keys', record: 'c-1', company: 'label-1', account: 'c0'.repeat(32) }]);
    expect(q('[data-acted=give-vault-keys]')!.textContent).toBe(en('signers.done.keysGiven'));
    expect(q('[data-next-steps]')!.textContent).toBe(en('signers.done.keysGivenNext'));
    expect(kr.reads).toBe(2);
  });

  /* RED WHEN: a refusal of your keys or an entry not filed yet is told in another act's words, or an entry not filed yet does not offer the press again. */
  it('tells a records key refused and an entry not filed yet in their own words, offering the press again after the second', async () => {
    for (const [code, partly] of [[WHY.recordsKeyRefused, false], [WHY.entryNotFiled, true]] as const) {
      cleanup();
      kr.company = records({ signerStandings: youJustAdded(false) });
      kr.ended = { of: 'stopped', step: 2, steps: 4, relayed: 0, unconfirmed: 0, why: 'check-failed', refused: `act.give-vault-keys.why.${code}` };
      await draw();
      await press('[data-action=give-vault-keys]');
      const shown = q('[data-signer-stopped]')!;
      expect(shown.dataset['signerStopped'], code).toBe(code);
      expect(shown.textContent, code).toContain(en(`signers.why.${code}`));
      expect(shown.textContent!.includes(en('signers.partial')), code).toBe(partly);
    }
  });
});

describe('the invitations waiting for approvals', () => {
  /* RED WHEN: an invitation no longer open is listed as waiting, or one that is open is missing. */
  it('lists the open invitations only', async () => {
    kr.company = records({ signersInvited: read([invited(), invited({ proposal: 'prop_2', name: 'Old', status: 'executed' }), invited({ proposal: 'prop_3', name: 'Gone', status: 'cancelled' })]) });
    await draw();
    expect(qa('[data-invited]').map((r) => r.dataset['invited'])).toEqual(['prop_1']);
  });

  /* RED WHEN: the name, the address (wrapped), the role in plain words or the rights are missing, or the role is shown as its code. */
  it('shows whom, at which address, in which role and with which rights', async () => {
    await draw();
    const row = q('[data-invited=prop_1]')!;
    expect(row.textContent).toContain('Sam');
    expect(row.textContent).toContain(en('signers.pending.address').replace('{address}', HEX(1)));
    expect(row.textContent).toContain(en('signers.pending.role').replace('{role}', en('invite.role.approver')));
    expect(row.querySelector('[data-address]')!.className).toContain('break-all');
  });

  /* RED WHEN: the rights or the coin key are shown as the whole run of digits (or not shown), or the address is shortened so it can no longer be compared. */
  it('shows the rights and the coin key shortened, says the account\'s window names them, and keeps the address whole', async () => {
    await draw();
    const row = q('[data-invited=prop_1]')!;
    const cut = (hex: string) => en('signers.shortened').replace('{start}', hex.slice(0, 8)).replace('{end}', hex.slice(-8));
    expect(row.querySelector('[data-scope]')!.textContent).toBe(en('signers.pending.scope').replace('{scope}', cut(HEX(2))));
    expect(row.querySelector('[data-coin-key]')!.textContent).toBe(en('signers.pending.coinKey').replace('{coinKey}', cut(HEX(3))));
    expect(row.textContent).not.toContain(HEX(2));
    expect(row.textContent).not.toContain(HEX(3));
    expect(row.querySelector('[data-address]')!.textContent).toContain(HEX(1));
    expect(en('signers.pending.scope')).toMatch(/window names the vaults/);
  });

  /* RED WHEN: the approvals needed are the account's number, not the number a change of signers needs, or the sentence is written anew instead of the adapter's. */
  it('says how many approvals adding a signer needs from the seat bar, never the account\'s number', async () => {
    await draw();
    expect(q('[data-approvals-needed=raisedUnnamed]')!.textContent).toBe(en('invite.approvals.raisedUnnamed_other').replace(/\{count\}/g, '3'));
    cleanup(); kr.company = records({ approvalsForSigners: read({ count: 2, raisedAboveTheAccount: false, vaultsAtThatNumber: [] }) });
    await draw();
    expect(q('[data-approvals-needed=account]')!.textContent).toBe(en('invite.approvals.account_other').replace(/\{count\}/g, '2'));
  });

  /* RED WHEN: a bar nobody could read is shown as a number. */
  it('says so when the number of approvals could not be read', async () => {
    kr.company = records({ approvalsForSigners: { of: 'unreadable' } });
    await draw();
    expect(q('[data-approvals-needed]')).toBeNull();
    expect(q('[data-needed-unknown]')!.textContent).toBe(en('signers.pending.neededUnknown'));
  });

  /* RED WHEN: approvals nobody could count are shown as 0, or a count the page was given is not shown. */
  it('says approvals so far are not known yet when there is no count, and never 0', async () => {
    await draw();
    const row = q('[data-invited=prop_1]')!;
    expect(row.querySelector('[data-approvals]')!.textContent).toBe(en('signers.pending.approvals.unknown'));
    expect(row.textContent).not.toMatch(/\b0\b/);
    cleanup(); kr.company = records({ signersInvited: read([invited({ approvals: 2 })]) });
    await draw();
    expect(q('[data-approvals]')!.textContent).toBe(en('signers.pending.approvals.known_other').replace('{count}', '2'));
  });

  /* RED WHEN: nobody waiting is shown as an unread list, or an unread list as nobody waiting. */
  it('tells nobody waiting from a list that could not be read', async () => {
    kr.company = records({ signersInvited: read([]) });
    await draw();
    expect(q('[data-pending-none]')!.textContent).toBe(en('signers.pending.nobody'));
    cleanup(); kr.company = records({ signersInvited: { of: 'unreadable' } });
    await draw();
    expect(q('[data-pending-none]')).toBeNull();
    expect(q('[data-pending-unread]')!.textContent).toBe(en('signers.pending.unread'));
  });
});

describe('approving an invitation', () => {
  /* RED WHEN: Approve asks the wallet about another invitation, name, role, address, rights or coin key than the one pressed, or the records are not read again after it is done. */
  it('asks the wallet to approve exactly the invitation pressed, says so, and reads the records again', async () => {
    await draw();
    await press('[data-invited=prop_1] [data-action=approve-signer]');
    expect(kr.acts).toEqual([{
      name: 'approve-signer', record: 'c-1', company: 'label-1', account: 'c0'.repeat(32), proposal: 'prop_1', personName: 'Sam', role: 'approver',
      address: HEX(1), scope: HEX(2), coinKey: HEX(3),
    }]);
    expect(q('[data-acted=approve-signer]')!.textContent).toBe(en('signers.done.approved').replace('{name}', 'Sam'));
    expect(kr.reads).toBe(2);
  });

  /* RED WHEN: after an approval the page does not say how many approvals are needed in all, who gives the rest, and that the person takes the seat and a signer then presses Finish adding; or says a count it does not have. */
  it('says after an approval what is needed next, with the count when the bar is known and without it when not', async () => {
    kr.ended = { of: 'done', steps: 4, relayed: 1, outcome: { state: 'approved' } };
    await draw();
    await press('[data-invited=prop_1] [data-action=approve-signer]');
    expect(q('[data-next-steps]')!.textContent).toBe(en('signers.done.next_other').replace('{count}', '3').replace('{name}', 'Sam'));
    expect(q('[data-next-steps]')!.textContent).toMatch(/other signers give the rest.*takes the seat from their own wallet.*presses Finish adding/);
    cleanup(); kr.company = records({ approvalsForSigners: { of: 'unreadable' } });
    await draw();
    await press('[data-invited=prop_1] [data-action=approve-signer]');
    expect(q('[data-next-steps]')!.textContent).toBe(en('signers.done.nextUnknown').replace('{name}', 'Sam'));
    expect(q('[data-next-steps]')!.textContent).toMatch(/other signers give the rest.*takes the seat from their own wallet.*presses Finish adding/);
    cleanup(); kr.company = records();
    kr.ended = { of: 'done', steps: 4, relayed: 1, outcome: { state: 'admitted' } };
    await draw();
    await press('[data-signer=s2] [data-action=finish-adding]');
    expect(q('[data-next-steps]')).toBeNull();
  });

  /* RED WHEN: an invitation with all its approvals whose person has not taken the seat has no row, or has an Approve that would be refused, or does not say the person takes the seat next and a signer then finishes adding. */
  it('shows an invitation with every approval in as its own row, with no Approve, saying who acts next', async () => {
    kr.company = records({ signersInvited: read([invited({ status: 'approved', approvals: 3 }), invited({ proposal: 'prop_2', name: 'Tia', status: 'open' })]) });
    await draw();
    const row = q('[data-invited=prop_1]')!;
    expect(row).not.toBeNull();
    expect(row.querySelector('[data-action=approve-signer]')).toBeNull();
    expect(row.querySelector('[data-approved]')!.textContent).toBe(en('signers.pending.approved'));
    expect(row.querySelector('[data-approved-next]')!.textContent).toBe(en('signers.pending.approvedNext').replace('{name}', 'Sam'));
    expect(row.querySelector('[data-approvals]')).toBeNull();
    expect(q('[data-invited=prop_2] [data-action=approve-signer]')).not.toBeNull();
    expect(q('[data-pending-signers]')!.textContent).toContain('Tia');
  });

  /* RED WHEN: a proposal already carried out, rejected or cancelled is drawn as a row of the signers waiting. */
  /* RED WHEN: the signer who raised an invitation at a bar of one approval is offered Approve on it after the invitee took the seat, which their wallet can only refuse, or Finish adding is not offered for the invitee. */
  it('offers the raiser no Approve once the invitee holds the seat at one approval, and offers Finish adding for the invitee', async () => {
    kr.company = records({
      approvalsForSigners: read({ count: 1, raisedAboveTheAccount: false, vaultsAtThatNumber: [] }),
      signerStandings: read([standing('s1', 'Priya', false, true), standing('sB', 'Bea', true, true)]),
      signersInvited: read([invited({ proposal: 'prop_B', name: 'Bea', seat: { signer: 'sB' } })]),
    });
    kr.ended = { of: 'done', steps: 4, relayed: 1, outcome: { state: 'admitted' } };
    await draw();
    expect(qa('[data-action=approve-signer]')).toEqual([]);
    const row = q('[data-invited=prop_B]')!;
    expect(row.dataset['nextStep']).toBe('finish');
    expect(row.querySelector('[data-next-after-approve]')!.textContent).toBe(en('signers.pending.seatTaken').replace('{name}', 'Bea'));
    expect(qa('[data-action=finish-adding]').map((b) => b.closest('[data-signer]')!.getAttribute('data-signer'))).toEqual(['sB']);
    await press('[data-action=finish-adding]');
    expect(kr.acts).toEqual([{ name: 'admit-signer', record: 'c-1', company: 'label-1', account: 'c0'.repeat(32), signer: 'sB', personName: 'Bea' }]);
  });

  /* RED WHEN: an invitation the chain shows no seat taken for offers no Approve, or one the chain says took its seat offers Approve, while the request to be added has not reached the page. */
  it('offers Approve on every invitation the chain shows no seat taken for, and says to wait on one whose seat is taken and not yet asked for here', async () => {
    kr.company = records({ signersInvited: read([
      invited({ proposal: 'prop_taken', name: 'Vik', seat: { signer: null } }),
      invited({ proposal: 'prop_open', name: 'Wes' }),
    ]) });
    await draw();
    const nextOf = (id: string) => [q(`[data-invited=${id}]`)!.dataset['nextStep'], q(`[data-invited=${id}] [data-next-after-approve]`)?.textContent ?? null,
      q(`[data-invited=${id}] [data-action=approve-signer]`) !== null];
    expect(nextOf('prop_taken')).toEqual(['seat-waiting', en('signers.pending.seatWaiting').replace('{name}', 'Vik'), false]);
    expect(nextOf('prop_open')).toEqual(['approve', null, true]);
  });

  it('draws no row for a proposal that is carried out, rejected, blocked or cancelled', async () => {
    kr.company = records({ signersInvited: read(['executed', 'rejected', 'blocked', 'cancelled'].map((status, n) => invited({ proposal: `x${n}`, status }))) });
    await draw();
    expect(q('[data-pending-none]')).not.toBeNull();
    expect(qa('[data-invited]')).toEqual([]);
  });

  /* RED WHEN: Approve stays live after this device's approval was sent (a second press costs a window and a passkey and is refused), or gives no reason, or goes off for another invitation, or after a stop that sent nothing. */
  it('turns Approve off for the invitation this device approved, says why, and leaves the others and a refused press alone', async () => {
    kr.company = records({ signersInvited: read([invited(), invited({ proposal: 'prop_2', name: 'Tia' })]) });
    kr.ended = { of: 'stopped', step: 2, steps: 4, relayed: 0, unconfirmed: 0, why: 'check-failed', refused: 'act.approve-signer.why.not-approved' };
    await draw();
    await press('[data-invited=prop_1] [data-action=approve-signer]');
    expect((q('[data-invited=prop_1] [data-action=approve-signer]') as HTMLButtonElement).disabled).toBe(false);
    expect(q('[data-approved-here]')).toBeNull();
    kr.ended = { of: 'done', steps: 4, relayed: 1, outcome: { state: 'waiting-for-approvals' } };
    await press('[data-invited=prop_1] [data-action=approve-signer]');
    expect((q('[data-invited=prop_1] [data-action=approve-signer]') as HTMLButtonElement).disabled).toBe(true);
    expect(q('[data-invited=prop_1] [data-approved-here]')!.textContent).toBe(en('signers.approvedHere'));
    expect((q('[data-invited=prop_2] [data-action=approve-signer]') as HTMLButtonElement).disabled).toBe(false);
    expect(q('[data-invited=prop_2] [data-approved-here]')).toBeNull();
    const asked = kr.acts.length;
    fireEvent.click(q('[data-invited=prop_1] [data-action=approve-signer]')!);
    await settle();
    expect(kr.acts).toHaveLength(asked);
  });

  /* RED WHEN: after the approval that met the bar the page says other signers still give the rest, or after one that did not meet it says nothing is owed. */
  it('says the approvals are complete when the wallet says the bar is met, and that others give the rest when it says they are not', async () => {
    kr.ended = { of: 'done', steps: 4, relayed: 1, outcome: { state: 'waiting-for-the-invitee', approvals: 3 } };
    await draw();
    await press('[data-invited=prop_1] [data-action=approve-signer]');
    expect(q('[data-next-steps]')!.textContent).toBe(en('signers.done.complete').replace('{name}', 'Sam'));
    expect(q('[data-next-steps]')!.textContent).not.toMatch(/other signers give the rest/);
    cleanup();
    kr.ended = { of: 'done', steps: 4, relayed: 1, outcome: { state: 'waiting-for-approvals', approvals: 1 } };
    await draw();
    await press('[data-invited=prop_1] [data-action=approve-signer]');
    expect(q('[data-next-steps]')!.textContent).toBe(en('signers.done.next_other').replace('{count}', '3').replace('{name}', 'Sam'));
  });

  /* RED WHEN: an invitation that carries no coin key can be pressed to approve, or sends the person to a Withdraw this page does not have, or does not say plainly it cannot be approved and who to ask. */
  it('offers no Approve to an invitation with no coin key, says it cannot be approved, that nothing here withdraws it, and who to ask', async () => {
    kr.company = records({ signersInvited: read([invited({ coinKey: null })]) });
    await draw();
    expect(q('[data-action=approve-signer]')).toBeNull();
    expect(q('[data-no-coin-key]')!.textContent).toBe(en('signers.pending.noCoinKey'));
    expect(q('[data-no-coin-key]')!.textContent).toMatch(/cannot be approved.*Nothing on this page can withdraw it.*Contact support/);
    expect(q('[data-no-coin-key]')!.textContent).not.toMatch(/Withdraw it/);
  });

  /* RED WHEN: every stop is not told in its own words, one that may have gone part of the way does not offer the same press again, or a stop that sent nothing says it did. */
  it('gives each reason the wallet stops for its own words, and says to press again only after a stop that may have gone part of the way', async () => {
    const partly = new Set<string>([WHY.mayBeSent, WHY.filedNotEntered, WHY.stopped, WHY.other]);
    const giving = new Set<string>([WHY.recordsKeyRefused, WHY.entryNotFiled]);
    for (const [key, code] of Object.entries(WHY)) {
      if (giving.has(code)) continue;
      cleanup(); kr.acts = [];
      const refused = code === WHY.stopped ? undefined : `act.approve-signer.why.${code}`;
      kr.ended = { of: 'stopped', step: 2, steps: 4, relayed: 0, unconfirmed: 0, why: 'check-failed', ...(refused === undefined ? {} : { refused }) };
      const asked = code === WHY.notASigner || code === WHY.notTheInvited || code === WHY.notAdmitted || code === WHY.filedNotEntered
        || code === WHY.idTaken || code === WHY.chainUnread;
      if (asked) kr.ended = { ...(kr.ended as object), refused: `act.admit-signer.why.${code}` };
      await draw();
      await press(asked ? '[data-action=finish-adding]' : '[data-invited=prop_1] [data-action=approve-signer]');
      const shown = q('[data-signer-stopped]')!;
      expect(shown.dataset['signerStopped'], key).toBe(code);
      expect(shown.textContent, key).toContain(en(`signers.why.${code}`));
      expect(shown.textContent!.includes(en('signers.partial')), key).toBe(partly.has(code));
      expect(/invited again/.test(shown.textContent!), key).toBe(code === WHY.notTheInvited || code === WHY.notAdmitted);
    }
  });

  /* RED WHEN: the words for a seat taken that is not the invited one tell the person to reload, or leave out that the person is removed and invited again, or that removing cannot be done here yet. */
  it('says a seat taken that is not the invited one needs a removal and a new invitation, not a reload', async () => {
    kr.ended = { of: 'stopped', step: 2, steps: 4, relayed: 0, unconfirmed: 0, why: 'check-failed', refused: 'act.admit-signer.why.not-the-invited' };
    await draw();
    await press('[data-action=finish-adding]');
    const says = q('[data-signer-stopped]')!.textContent!;
    expect(says).toMatch(/Reloading will not change this: the person has to be removed as a signer and invited again/);
    expect(says).toMatch(/cannot be done from this page yet; contact support/);
    expect(says).not.toMatch(/then reload the page\.$/);
  });

  /* RED WHEN: a chain the wallet could not read is told as a seat that is not the invited one, with the advice to remove the person and invite them again. */
  it('says a chain that could not be read was not read, and to press Finish adding again', async () => {
    kr.ended = { of: 'stopped', step: 2, steps: 4, relayed: 0, unconfirmed: 0, why: 'check-failed', refused: 'act.admit-signer.why.chain-unread' };
    await draw();
    await press('[data-action=finish-adding]');
    const says = q('[data-signer-stopped]')!.textContent!;
    expect(says).toMatch(/could not read the network/);
    expect(says).toMatch(/Press Finish adding again/);
    expect(says).not.toMatch(/removed as a signer|invited again|is not the one the approved invitation names/);
  });

  /* RED WHEN: the words for a finished seat whose record is not filed hide that the admission is filed, say it may not have gone through, or say "name it" for a person. */
  it('says they are admitted and the records do not name them yet, once', async () => {
    expect(en('signers.why.filed-not-entered')).toMatch(/They are admitted, but the company's records do not name them yet/);
    expect(en('signers.why.filed-not-entered')).not.toMatch(/Their seat is taken|name it/);
  });

  /* RED WHEN: after the invitation was withdrawn, or the addition went through without the records following, the records are not read again, so Approve or Finish adding stays live on a row that is gone or done; or they are read again after a stop that changed nothing. */
  it('reads the records again after a stop that left the chain changed, and not after one that sent nothing', async () => {
    const reads = async (refused: string | undefined, press_: string): Promise<number> => {
      cleanup(); kr.acts = []; kr.reads = 0;
      kr.ended = { of: 'stopped', step: 2, steps: 4, relayed: 0, unconfirmed: 0, why: 'check-failed', ...(refused === undefined ? {} : { refused }) };
      await draw(); const before = kr.reads;
      await press(press_);
      return kr.reads - before;
    };
    const approve = '[data-invited=prop_1] [data-action=approve-signer]';
    expect(await reads('act.approve-signer.why.withdrawn', approve)).toBe(1);
    expect(await reads('act.admit-signer.why.filed-not-entered', '[data-action=finish-adding]')).toBe(1);
    expect(await reads('act.approve-signer.why.seat-not-held', approve)).toBe(0);
  });

  /* RED WHEN: a stop whose words say nothing was sent is shown after the wallet handed over transactions (sent or unconfirmed), the page does not say they may have been sent, or the records are not read again; or a stop that handed over none loses its own words. */
  it.each([[1, 0], [0, 1], [0, 0]])('says transactions may have been sent, in place of "nothing was sent", and reads the records again, only when they were: %i sent, %i unconfirmed', async (relayed, unconfirmed) => {
    kr.acts = []; kr.reads = 0;
    kr.ended = { of: 'stopped', step: 2, steps: 4, relayed, unconfirmed, why: 'check-failed', refused: 'act.approve-signer.why.not-approved' };
    await draw(); const before = kr.reads;
    await press('[data-invited=prop_1] [data-action=approve-signer]');
    const shown = q('[data-signer-stopped=not-approved]')!.textContent!;
    const handed = relayed + unconfirmed > 0;
    expect(shown.includes(en('signers.sent'))).toBe(handed);
    expect(shown.includes(en('signers.why.not-approved'))).toBe(!handed);
    expect(kr.reads - before).toBe(handed ? 1 : 0);
  });

  /* RED WHEN: a refusal before the wallet is asked is shown as the wallet stopping, or not named. */
  it('names a refusal before the wallet is asked, and asks the wallet for nothing', async () => {
    kr.user = null;
    await draw();
    await press('[data-invited=prop_1] [data-action=approve-signer]');
    expect(kr.acts).toEqual([]);
    expect(q('[data-refusal=not-signed-in]')!.textContent).toContain(en('act.refused.notSignedIn'));
  });

  /* RED WHEN: while the wallet works no status is spoken, a second press can start another act, or the step is not shown. */
  it('says it is working with a status, with the step, and lets nothing else be pressed meanwhile', async () => {
    let release = () => {};
    kr.hold = new Promise<void>((r) => { release = r; });
    kr.steps = [{ step: 2, steps: 4 }];
    await draw();
    await press('[data-invited=prop_1] [data-action=approve-signer]');
    const status = q('[role=status][data-working]')!;
    expect(status.textContent).toBe(en('signers.working.step').replace('{step}', '2').replace('{steps}', '4'));
    expect(qa('[data-action=approve-signer], [data-action=finish-adding]').every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
    release();
    await settle();
    expect(q('[data-working]')).toBeNull();
  });
});

describe('adding a signer', () => {
  /* RED WHEN: Add a signer opens the invite for another kind than a signer, or draws no invite. */
  it('opens the invite panel for a signer only', async () => {
    await draw();
    fireEvent.click(q('[data-action=invite]')!);
    await settle();
    expect(q('[data-field=address]')).not.toBeNull();
    expect(q('[data-field=amount]')).toBeNull();
    expect(q('[data-kind=employee]')).toBeNull();
  });

  /* RED WHEN: the wizard's step draws a button that opens a panel instead of the form itself, or the page and the step are two components. */
  it('draws the form itself when a wizard step calls it', async () => {
    await draw(<Signers leadTo={vi.fn()} onChanged={vi.fn()} />);
    expect(q('[data-action=invite]')).toBeNull();
    expect(q('[data-field=address]')).not.toBeNull();
  });

  /* RED WHEN: an invitation sent for a signer is not read again for the page, so it does not appear among those waiting. */
  it('reads the records again once an invitation is sent', async () => {
    kr.ended = { of: 'done', steps: 1, relayed: 0, outcome: { state: 'filed' } };
    await draw();
    fireEvent.click(q('[data-action=invite]')!);
    await settle();
    const before = kr.reads;
    fireEvent.change(q('[data-field=name]')!, { target: { value: 'Zed' } });
    fireEvent.change(q('[data-field=address]')!, { target: { value: PRIVATE } });
    await press('[data-action=send-invite]');
    expect(kr.acts.map((a) => a['name'])).toEqual(['invite']);
    expect(kr.acts[0]).toMatchObject({ kind: 'signer', personName: 'Zed' });
    expect(kr.reads).toBeGreaterThan(before);
  });
});

describe('one act, one read of the records', () => {
  const sendOne = async () => {
    fireEvent.change(q('[data-field=name]')!, { target: { value: 'Zed' } });
    fireEvent.change(q('[data-field=address]')!, { target: { value: PRIVATE } });
    await press('[data-action=send-invite]');
    expect(kr.acts.map((a) => a['name'])).toEqual(['invite']);
  };

  /* RED WHEN: on its own page, one invitation sent for a signer asks for the company's records to be read again more than once, or not at all. */
  it('asks for the records to be read once for one invitation on the page', async () => {
    kr.ended = { of: 'done', steps: 1, relayed: 0, outcome: { state: 'filed' } };
    await draw();
    fireEvent.click(q('[data-action=invite]')!);
    await settle();
    kr.reloads = 0;
    await sendOne();
    expect(kr.reloads).toBe(1);
  });

  /* RED WHEN: in a wizard step, which re-reads the records itself when told something changed, the component also asks for them to be read again for the same act. */
  it('leaves the read to the step that called it, when it is given one', async () => {
    kr.ended = { of: 'done', steps: 1, relayed: 0, outcome: { state: 'filed' } };
    const onChanged = vi.fn();
    await draw(<Signers leadTo={vi.fn()} onChanged={onChanged} />);
    kr.reloads = 0;
    await sendOne();
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(kr.reloads).toBe(0);
  });
});

describe('the committee change inside it', () => {
  /* RED WHEN: the component leaves out the committee change (who holds the company, and a change owed), or draws it twice, so the page and the wizard's step would not show the same thing. */
  it('draws the committee change once, below the signers, with what holds the company', async () => {
    kr.handover = { of: 'change-owed', signed: [{ have: 1, required: 2 }] };
    await draw();
    expect(qa('[data-action=committee-change]')).toHaveLength(1);
    expect(q('[data-action=committee-change]')!.getAttribute('data-state')).toBe('change-owed');
    expect(q('[data-action=signers]')!.compareDocumentPosition(q('[data-action=committee-change]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(qa('[data-change-owed] li').map((li) => li.textContent)).toEqual(['1 of 2 signed']);
  });

  /* RED WHEN: signing the change owed does not tell the step that called the component, so the wizard goes on showing what it read before. */
  it('tells the caller when the change owed is signed', async () => {
    kr.handover = { of: 'change-owed', signed: [{ have: 1, required: 2 }] };
    const onChanged = vi.fn();
    await draw(<Signers onChanged={onChanged} />);
    await press('[data-action=sign-change]');
    fireEvent.click([...document.body.querySelectorAll('button')].find((b) => b.textContent === en('kit.confirm.confirm'))!);
    await settle();
    expect(kr.signs).toBe(1);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });
});
