// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KitProvider, languagesFrom } from 'vaults-ui';
import { DEFAULT_PREFERENCES } from '../preferences.js';
import { VIEWS } from '../pages.js';
import { ENGLISH } from '../english.test-support.js';

/*
 * THE SIGNERS PAGE'S TWO PRESSES OF THE SWITCH, DRAWN over the real adapters and the real wallet wrappers, with only the call to the
 * wallet and the company's records stood in for: Remove on a seated signer, and Change vault secrets for a signer who stays.
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

(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
Element.prototype.hasPointerCapture ??= function hasPointerCapture() { return false; };
const EN = ENGLISH;
const en = (key: string): string => EN[key] ?? key;
const LANGUAGES = languagesFrom({ './locales/en.json': EN });
const LEAF = (n: number): string => n.toString(16).padStart(2, '0').repeat(32);
const read = (value: unknown) => ({ of: 'read', value });
const seat = (id: string, name: string, over: Record<string, unknown> = {}) => ({ id, name, accepted: false, seatOnChain: true, you: false, entryFiled: true, leaf: LEAF(Number(id.slice(1))), ...over });
const records = (over: Record<string, unknown> = {}) => ({
  of: 'open', id: 'c-1', name: 'Northwind', signers: [{ id: 's1', name: 'Priya' }, { id: 's2', name: 'Raj' }],
  approvalsNeeded: read(2), proposals: read([]),
  approvalsForSigners: read({ count: 3, raisedAboveTheAccount: true, vaultsAtThatNumber: [], seated: 4 }),
  signerStandings: read([seat('s1', 'Priya', { you: true }), seat('s2', 'Raj'), seat('s3', 'Tia', { seatOnChain: false, accepted: true }), seat('s4', 'Uma', { leaf: null })]),
  signersInvited: read([]),
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
  kr.ended = { of: 'done', steps: 5, relayed: 1, outcome: { state: 'waiting-for-approvals', approvals: 1, needed: 2 } };
});
afterEach(cleanup);

const REMOVE = '[data-signer=s2] [data-action=remove-signer]';
const FEWER = '[data-signer=s2] [data-action=remove-threshold-fewer]';
const MORE = '[data-signer=s2] [data-action=remove-threshold-more]';
const KEEP = '[data-signer=s2] [data-action=remove-threshold-keep]';
const SHOWN = '[data-signer=s2] [data-remove-threshold-value]';
const stoppedWith = (refused: string, over: Record<string, unknown> = {}) => ({ of: 'stopped', step: 2, steps: 5, relayed: 0, unconfirmed: 0, why: 'check-failed', refused, ...over });
const text = (selector: string): string => q(selector)?.textContent ?? '';

describe('Remove on a seated signer', () => {
  /* RED WHEN: a seated signer's row has no Remove that can be pressed, or a seat the chain does not hold, one whose leaf the roster does not name, or one waiting for its request is offered it. */
  it('is offered on a seated signer whose leaf is named, and on no other', async () => {
    kr.company = records({ signerStandings: read([seat('s1', 'Priya', { you: true }), seat('s2', 'Raj'), seat('s3', 'Tia', { seatOnChain: false, accepted: true }), seat('s4', 'Uma', { leaf: null }), seat(LEAF(5), '', { waiting: true, id: LEAF(5) })]) });
    await draw();
    expect(qa('[data-action=remove-signer]').map((b) => b.closest('[data-signer]')!.getAttribute('data-signer'))).toEqual(['s1', 's2']);
    expect(q(REMOVE)!.textContent).toBe(en('signers.remove'));
    expect(q(REMOVE)!.hasAttribute('disabled')).toBe(false);
    expect(q('[data-signer=s2] [data-slot="soon-action"]')).toBeNull();
    expect(text('[data-signer=s2]')).toContain(en('signers.remove.threshold.hint'));
  });

  /* RED WHEN: pressing Remove asks the wallet for another seat than the one pressed, hands it a number nobody typed, or does not read the records again once the wallet has begun. */
  it('asks the wallet to remove exactly that seat, with no number, and reads the records again', async () => {
    await draw();
    const reads = kr.reads;
    await press(REMOVE);
    expect(kr.acts).toEqual([{ name: 'remove-signer', record: 'c-1', company: 'label-1', account: 'c0'.repeat(32), leaf: LEAF(2) }]);
    expect(kr.reads).toBe(reads + 1);
    expect(text('[data-signer=s2] [data-acted=remove-signer]')).toBe(en('signers.removal.waiting').replace('{name}', 'Raj'));
  });

  /* RED WHEN: the number of approvals stepped to is not handed to the wallet as chosen, or Remove with none chosen hands it a number. */
  it('hands the wallet the number stepped to, and none when none was chosen', async () => {
    await draw();
    expect(text(SHOWN)).toBe(en('changeThreshold.keeps_other').replace('{count}', '2'));
    await press(FEWER);
    expect(text(SHOWN)).toBe(en('changeThreshold.value_one').replace('{count}', '1'));
    await press(REMOVE);
    expect(kr.acts.map((a) => a['threshold'])).toEqual(['1']);
    cleanup(); kr.acts = [];
    await draw();
    await press(MORE);
    await press(KEEP);
    expect(text(SHOWN)).toBe(en('changeThreshold.keeps_other').replace('{count}', '2'));
    await press(REMOVE);
    expect(kr.acts.map((a) => a['threshold'])).toEqual([undefined]);
  });

  /* RED WHEN: the steps go below one approval, or above the signers who stay once this one is removed, or are offered when the numbers could not be read. */
  it('steps only from one to the number of signers who stay, and not at all when the numbers cannot be read', async () => {
    await draw();
    expect(q(MORE)!.hasAttribute('disabled')).toBe(false);
    await press(MORE);
    expect(text(SHOWN)).toBe(en('changeThreshold.value_other').replace('{count}', '3'));
    expect(q(MORE)!.hasAttribute('disabled')).toBe(true);
    await press(FEWER); await press(FEWER);
    expect(q(FEWER)!.hasAttribute('disabled')).toBe(true);
    cleanup();
    kr.company = records({ approvalsNeeded: { of: 'unreadable' } });
    await draw();
    expect([q(FEWER)!.hasAttribute('disabled'), q(MORE)!.hasAttribute('disabled')]).toEqual([true, true]);
    await press(REMOVE);
    expect(kr.acts.map((a) => a['threshold'])).toEqual([undefined]);
  });

  /* RED WHEN: a signer being removed can be removed twice at once, or another act can be started while the wallet works. */
  it('disables every press while the wallet works', async () => {
    let release = (): void => {};
    kr.hold = new Promise<void>((r) => { release = r; });
    await draw();
    fireEvent.click(q(REMOVE)!);
    await settle();
    expect(q(REMOVE)!.hasAttribute('disabled')).toBe(true);
    expect(q('[data-action=change-vault-secrets]')!.hasAttribute('disabled')).toBe(true);
    release();
    await settle();
    expect(q(REMOVE)!.hasAttribute('disabled')).toBe(false);
  });
});

describe('where a removal got to', () => {
  const ended = (outcome: Record<string, unknown>) => { kr.ended = { of: 'done', steps: 5, relayed: 2, outcome }; };
  /* RED WHEN: a removal still waiting for approvals is told as removed, or its approvals so far and the number it needs are lost. */
  it('tells a removal waiting for approvals with the count the network showed', async () => {
    ended({ state: 'waiting-for-approvals', approvals: 1, needed: 2 });
    await draw();
    await press(REMOVE);
    expect(text('[data-signer=s2]')).toContain(en('signers.removal.waiting').replace('{name}', 'Raj'));
    expect(text('[data-signer=s2] [data-removal-approvals]')).toBe(en('signers.removal.counted').replace('{approvals}', '1').replace('{needed}', '2'));
    expect(q('[data-signer=s2] [data-removal-rotation]')).toBeNull();
  });

  /* RED WHEN: a removal that waits for the retirement or is ready to carry is told as removed. */
  it('tells a removal waiting for the retirement, and one at its approvals not yet carried out', async () => {
    ended({ state: 'waiting-for-the-retirement' });
    await draw();
    await press(REMOVE);
    expect(text('[data-signer=s2] [data-acted=remove-signer]')).toBe(en('signers.removal.retirement').replaceAll('{name}', 'Raj'));
    cleanup(); ended({ state: 'ready-to-carry' });
    await draw();
    await press(REMOVE);
    expect(text('[data-signer=s2] [data-acted=remove-signer]')).toBe(en('signers.removal.ready').replace('{name}', 'Raj'));
  });

  /* RED WHEN: a removal the network carried out is not told so, or the company key's change and each count of the vaults are not told, or a count the wallet did not give is shown. */
  it('tells a removal carried out, the company key\'s change, and how many vaults ended in each state', async () => {
    ended({ state: 'carried-out', approvals: 2, needed: 2, rotation: 'rotated', vaultsRotated: 2, vaultsAwaiting: 1, vaultsOwed: 0, vaultsWaiting: 1, vaultsNotChanged: 0 });
    await draw();
    await press(REMOVE);
    const row = '[data-signer=s2] ';
    expect(text(`${row}[data-acted=remove-signer]`)).toBe(en('signers.removal.carried').replace('{name}', 'Raj'));
    expect(text(`${row}[data-removal-rotation=rotated]`)).toBe(en('signers.rotation.rotated'));
    expect(text(`${row}[data-vaults-count=rotated]`)).toBe(en('signers.vaults.rotated_other').replace('{count}', '2'));
    expect(text(`${row}[data-vaults-count=awaiting]`)).toBe(en('signers.vaults.awaiting_one').replace('{count}', '1'));
    expect(text(`${row}[data-vaults-count=waiting]`)).toBe(en('signers.vaults.waiting_one').replace('{count}', '1'));
    expect(q(`${row}[data-vaults-count=owed]`)).toBeNull();
    expect(q(`${row}[data-vaults-count=notChanged]`)).toBeNull();
  });

  /* RED WHEN: a removal carried out whose vault secrets the wallet did not start is told as if they were changed. */
  it('says the vault secrets were not started where the wallet said so', async () => {
    ended({ state: 'carried-out', rotation: 'not-tried', vaultSecrets: 'not-started' });
    await draw();
    await press(REMOVE);
    expect(text('[data-signer=s2] [data-removal-vaults-not-started]')).toBe(en('signers.removal.vaultsNotStarted'));
    expect(q('[data-signer=s2] [data-vaults-count]')).toBeNull();
    expect(q('[data-signer=s2] [data-removal-vaults-not-started-why]')).toBeNull();
  });

  /* RED WHEN: the page is told what stopped the vault secrets' change and does not say it, so the signer sees that it did not start and never why. */
  it('says what stopped the vault secrets\' change where the wallet told it', async () => {
    ended({ state: 'carried-out', rotation: 'not-tried', vaultSecrets: 'not-started', vaultSecretsWhy: 'vault-records-not-read' });
    await draw();
    await press(REMOVE);
    expect(text('[data-signer=s2] [data-removal-vaults-not-started-why]')).toBe(en('signers.removal.vaultsNotStartedWhy').replace('{why}', 'vault records not read'));
  });

  /* RED WHEN: a code the wallet gives for the company key's change has no words on the page, or is worded as another. */
  it('has its own words for every state of the company key\'s change', async () => {
    const codes = ['rotated', 'filed-not-anchored', 'rotated-elsewhere', 'not-needed', 'waits', 'not-this-seat', 'not-rotated', 'not-tried'];
    const seen = new Set<string>();
    for (const code of codes) {
      cleanup(); ended({ state: 'carried-out', rotation: code });
      await draw();
      await press(REMOVE);
      const words = text(`[data-signer=s2] [data-removal-rotation=${code}]`);
      expect(words, code).toBe(en(`signers.rotation.${code}`));
      expect(words, code).not.toBe(`signers.rotation.${code}`);
      seen.add(words);
    }
    expect(seen.size).toBe(codes.length);
  });
});

describe('every reason the wallet gives for stopping a removal', () => {
  const REASONS = [
    'not-a-company', 'no-saved-keys', 'no-seat', 'seat-not-held', 'not-on-chain', 'roster-not-opened', 'not-a-removal', 'refused', 'not-raised', 'not-approved',
    'not-carried', 'may-be-sent', 'not-as-shown', 'not-read', 'not-read-to-raise', 'no-such-seat', 'no-such-seat-to-raise', 'unread-seat-first', 'withdrawn',
    'carried-out', 'already-counted', 'outrun',
  ];
  /* RED WHEN: a reason the wallet gives for stopping a removal is shown as the page's words for one it does not know, or as no words at all. */
  it('has words of its own on the page, none of them the words for a reason the page does not know', async () => {
    await draw();
    const other = en('signers.why.other');
    for (const code of REASONS) {
      kr.ended = stoppedWith(`act.remove-signer.why.${code}`);
      await press(REMOVE);
      const shown = qa('[data-signer=s2] [data-signer-stopped] [role=alert], [data-signer=s2] [data-signer-stopped]').map((n) => n.textContent).join(' ');
      expect(q('[data-signer=s2] [data-signer-stopped]')?.getAttribute('data-signer-stopped'), code).toBe(code);
      expect(shown, code).not.toMatch(/signers\.[a-z]/u);
      expect(shown, code).not.toContain(other);
      expect(shown.trim().length, code).toBeGreaterThan(20);
    }
  });

  /* RED WHEN: a stop of a removal that may have gone part of the way is told as a refusal that sent nothing, or hides the press that carries on. */
  it('tells a stop that may have gone part of the way as such, and keeps Remove to press again', async () => {
    kr.ended = stoppedWith('act.remove-signer.why.may-be-sent');
    await draw();
    await press(REMOVE);
    expect(q('[data-signer=s2] [data-partial]')?.textContent).toBe(en('signers.partial'));
    expect(text('[data-signer=s2] [data-signer-stopped]')).toContain(en('signers.why.removal.may-be-sent'));
    expect(q(REMOVE)!.hasAttribute('disabled')).toBe(false);
    expect(kr.reads).toBeGreaterThan(1);
  });

  /* RED WHEN: a removal's reasons are worded as an invitation's: a removal withdrawn, carried out or already counted is told to press Finish adding or Approve. */
  it('words withdrawn, carried out and already counted for a removal, not for an invitation', async () => {
    await draw();
    for (const code of ['withdrawn', 'carried-out', 'already-counted']) {
      kr.ended = stoppedWith(`act.remove-signer.why.${code}`);
      await press(REMOVE);
      expect(text('[data-signer=s2] [data-signer-stopped]'), code).toContain(en(`signers.why.removal.${code}`));
      expect(text('[data-signer=s2] [data-signer-stopped]'), code).not.toMatch(/invitation|Finish adding/u);
    }
  });

  /* RED WHEN: a refusal before the wallet is asked (nobody signed in) is dropped. */
  it('tells a refusal the page made before asking the wallet', async () => {
    kr.user = null;
    await draw();
    await press(REMOVE);
    expect(kr.acts).toEqual([]);
    expect(qa('[data-signer=s2] [data-act-outcome]').map((n) => n.textContent).join(' ')).toContain(en('act.refused.notSignedIn'));
  });
});

describe('Change vault secrets', () => {
  const PRESS = '[data-vault-secrets] [data-action=change-vault-secrets]';
  /* RED WHEN: the vault section is missing, or does not promise only what the code does: payments go on and are readable by the leaver until the new secret is set, our devices refuse deposits until it is set and filed, and only while the copies are written does the vault take no deposits and no payments. */
  it('is always on the page, and says what a vault does until its new secret is held', async () => {
    await draw();
    expect(text('[data-vault-secrets]')).toContain(en('signers.vaults.title'));
    expect(text('[data-vault-secrets]')).toContain(en('signers.vaults.description'));
    expect(text('[data-vault-secrets]')).toContain(en('signers.vaults.promise'));
    expect(en('signers.vaults.promise')).toMatch(/payments go on as before until a vault's new secret is set/u);
    expect(en('signers.vaults.promise')).toMatch(/Deposits made from this app wait until the new secret is set and filed/u);
    expect(en('signers.vaults.promise')).toMatch(/until every signer who stays has a sealed copy of it on the network, the vault takes no deposits and makes no payments/u);
    expect(en('signers.vaults.promise')).toMatch(/can still read what they could read before the change/u);
    expect(q(PRESS)!.textContent).toBe(en('signers.vaults.change'));
  });

  /* RED WHEN: the press asks for a change of anything but the company's vaults, or its counts are lost or a count the wallet did not give is shown. */
  it('asks the wallet to change the vault secrets and tells how many vaults ended in each state', async () => {
    kr.ended = { of: 'done', steps: 3, relayed: 1, outcome: { state: 'partial', vaultsRotated: 1, vaultsAwaiting: 0, vaultsOwed: 2, vaultsWaiting: 0, vaultsNotChanged: 1 } };
    await draw();
    const reads = kr.reads;
    await press(PRESS);
    expect(kr.acts).toEqual([{ name: 'rotate-vault-secrets', record: 'c-1', company: 'label-1', account: 'c0'.repeat(32) }]);
    expect(text('[data-vault-secrets] [data-vaults-count=rotated]')).toBe(en('signers.vaults.rotated_one').replace('{count}', '1'));
    expect(text('[data-vault-secrets] [data-vaults-count=owed]')).toBe(en('signers.vaults.owed_other').replace('{count}', '2'));
    expect(text('[data-vault-secrets] [data-vaults-count=notChanged]')).toBe(en('signers.vaults.notChanged_one').replace('{count}', '1'));
    expect(q('[data-vault-secrets] [data-vaults-count=awaiting]')).toBeNull();
    expect(text('[data-vault-secrets]')).toContain(en('signers.vaults.partial'));
    expect(kr.reads).toBe(reads + 1);
  });

  /* RED WHEN: a press that finds nothing owed is told as a failure or as nothing, or one that finished is told it still owes. */
  it('says nothing is owed when every count is zero, and nothing still owed when it is done', async () => {
    kr.ended = { of: 'done', steps: 3, relayed: 0, outcome: { state: 'done', vaultsRotated: 0, vaultsAwaiting: 0, vaultsOwed: 0, vaultsWaiting: 0, vaultsNotChanged: 0 } };
    await draw();
    await press(PRESS);
    expect(q('[data-vault-secrets] [data-vaults-none]')?.textContent).toBe(en('signers.vaults.nothingOwed'));
    expect(text('[data-vault-secrets]')).not.toContain(en('signers.vaults.partial'));
  });

  /* RED WHEN: a press whose counts the wallet did not give is told as nothing owed. */
  it('says so when the wallet gave no counts', async () => {
    kr.ended = { of: 'done', steps: 3, relayed: 0, outcome: { state: 'done' } };
    await draw();
    await press(PRESS);
    expect(q('[data-vault-secrets] [data-vaults-none]')).toBeNull();
    expect(text('[data-vault-secrets]')).toContain(en('signers.vaults.unread'));
  });

  /* RED WHEN: a reason the wallet gives for stopping the change has no words of its own on the page. */
  it('has words for every reason the wallet gives for stopping it', async () => {
    await draw();
    const other = en('signers.why.other');
    for (const code of ['not-a-company', 'no-saved-keys', 'no-seat', 'seat-not-held', 'not-on-chain', 'roster-not-opened', 'not-a-vault', 'no-person']) {
      kr.ended = stoppedWith(`act.rotate-vault-secrets.why.${code}`);
      await press(PRESS);
      const shown = text('[data-vault-secrets] [data-signer-stopped]');
      expect(q('[data-vault-secrets] [data-signer-stopped]')?.getAttribute('data-signer-stopped'), code).toBe(code);
      expect(shown, code).not.toMatch(/signers\.[a-z]/u);
      expect(shown, code).not.toBe(other);
      expect(shown.trim().length, code).toBeGreaterThan(20);
    }
  });
});
