// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '../testing/render.js';
import { Buffer as PolyfillBuffer } from 'buffer/';
import * as L from '@midnightntwrk/ledger-v9';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { identityFromWords, newWords, secretFromWords } from 'midnight-identity/keys/derivation';
import { parseAsk } from 'midnight-identity/profile/request';
import type { CommitteeRequest } from 'midnight-identity/profile/request';
import type { Channel, ChannelWindow } from 'midnight-identity/profile/channel';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { joinedBy, superAdminChangeBytes } from 'midnight-identity/profile/committee-sign';
import type {
  ChainRead, CommitteeJoinSignature, CommitteeUpdateSignatures, CommitteeSigningLedger, ContractOnTheChain,
} from 'midnight-identity/profile/committee-sign';
import { committeeSigningKeyFor } from 'midnight-identity/profile/committee-key';
import { watchedStore } from '../testing/settled-store.js';
import { settled, watchedOpener } from '../testing/settled-channel.js';
import { ApproveCommittee, type ChainReader } from './approve-committee.js';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { companyFingerprint } from 'midnight-identity/profile/fingerprint';
import type { LabelReader } from './company-on-chain.js';
import { Approve } from './approve.js';

/*
 * The screen a person sees when a company's page asks this wallet to sign a
 * change to who holds the company's rules: the new committee, who joins, who
 * leaves and the thresholds, worked out by the wallet; one press; and an answer
 * only after the press.
 */
(globalThis as { Buffer?: unknown }).Buffer = PolyfillBuffer;

const NOW = 1_755_000_000_000;
const identity = identityFromWords(TEST_MNEMONIC);
const SECRET = secretFromWords(TEST_MNEMONIC);
const ORIGIN = 'https://payroll-a.example';
/* The company's label, the account that carries it, and one of its vaults. */
const CO = 'co_1f2e3d4c5b6a79880a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6071' as CompanyLabel;
const ACCOUNT = 'dbe119a304f8e7ea882353435c1d536cf2faf4298236a9aae77670e750af65c8' as AccountAddress;
const VAULT = '54ef954a25aefff8e1675af10a852ef29d5de5c63a51b64b978bf7bd0eaeca4e';
/* The chain, as this wallet reads it: the account carries the company's label. */
/* Answers for the request's own account only: RED WHEN the screen reads any other address, such as the vault's. */
const carries: LabelReader = async (account) => (account === ACCOUNT ? { of: 'carries', label: CO } : { of: 'no-account' });
const mine = committeeKeyFor(identity, CO);
const leaving = committeeKeyFor(identityFromWords(newWords().join(' ')), CO);
const joining = committeeKeyFor(identityFromWords(newWords().join(' ')), CO);
const sorted = (...ks: { value: string }[]) => ks.map((k) => ({ tag: 'schnorr', value: k.value })).sort((a, b) => (a.value < b.value ? -1 : 1));
const short = (v: string) => `${v.slice(0, 12)}…${v.slice(-8)}`;
type Key = { tag: string; value: string };
const FOREIGN = 'ee'.repeat(32);

/* The chain as this wallet reads it at its own indexer: the account holds the committee a hand-over installs; the vault is behind. */
const held = (committee: Key[], threshold: number, counter: bigint, pinnedTo: string | null = ACCOUNT): ContractOnTheChain =>
  ({ of: 'read', committee, threshold, counter, pinnedTo });
const chainOf = (over: Record<string, ContractOnTheChain> = {}): ChainReader => async () => new Map(Object.entries({
  [ACCOUNT]: held(sorted(mine, joining), 1, 1n, null), [VAULT]: held(sorted(mine, leaving), 2, 3n), ...over,
})) as ChainRead;

const wire = (over: Record<string, unknown> = {}) => ({
  schema: 'midnight-identity/disclosure-request/v1',
  kind: 'committee',
  requester: { name: 'Payroll A', rdns: 'example.payroll-a' },
  purpose: 'Bring your company to its signers as they are now.',
  nonce: 'c1',
  expiresAt: NOW + 600_000,
  company: CO,
  account: ACCOUNT,
  to: { committee: sorted(mine, joining), threshold: 1 },
  contracts: [{ contract: 'vault', address: VAULT, counter: '3', now: { committee: sorted(mine, leaving), threshold: 2 } }],
  ...over,
});
const ask = (over: Record<string, unknown> = {}) => parseAsk(wire(over), ORIGIN, NOW) as CommitteeRequest;
const channelFor = (answers: unknown[]): Channel => ({
  answer: (a) => { answers.push(a); },
  refuse: (r) => { answers.push({ refused: r }); },
  stop: () => {},
} as Channel);
const consented = { ok: true } as never;
const ledger = async () => L as unknown as CommitteeSigningLedger;
const renderWith = (
  request: CommitteeRequest, answers: unknown[], consent = consented, declined: string[] = [], readLabel: LabelReader = carries,
  readChain: ChainReader = chainOf(),
) => render(
  <ApproveCommittee
    request={request} identity={identity} channel={channelFor(answers)} consent={consent}
    whoIsAsking={<p>asker</p>} onDecline={() => declined.push('declined')} ledger={ledger} now={() => NOW}
    readLabel={readLabel} readChain={readChain} />);

afterEach(() => { cleanup(); });

describe('THE SCREEN FOR SIGNING A CHANGE TO WHO HOLDS A COMPANY\'S RULES', () => {
  it('SHOWS THE NEW COMMITTEE AND THRESHOLD, WHO JOINS AND WHO LEAVES, BEFORE ANYTHING IS SIGNED', async () => {
    const answers: unknown[] = [];
    const { container } = renderWith(ask(), answers);
    await screen.findByText('Sign this change');
    /* RED WHEN: the screen does not say how many must sign after the change. */
    expect(container.querySelector('[data-new-threshold]')!.textContent).toBe(
      '2 keys, and 1 of them must sign any change to the company\'s rules.');
    expect(container.querySelector('[data-threshold-change]')!.textContent).toBe('Threshold: 2 before, 1 after.');
    /* RED WHEN: who joins or who leaves is not shown, or the two are swapped. */
    expect(container.querySelector('[data-joins]')!.textContent).toContain(short(joining.value));
    expect(container.querySelector('[data-leaves]')!.textContent).toContain(short(leaving.value));
    expect(container.querySelector('[data-joins]')!.textContent).not.toContain(short(leaving.value));
    expect(container.querySelector('[data-new-committee]')!.textContent).toContain(`${short(mine.value)} (your key)`);
    expect(container.querySelector('[data-contract="vault"]')!.textContent).toBe(VAULT);
    expect(answers).toEqual([]);
  });

  it('THE PRESS SIGNS THAT CHANGE AND HANDS BACK SIGNATURES, AND ONLY THE PRESS', async () => {
    const answers: unknown[] = [];
    const request = ask();
    renderWith(request, answers);
    const button = await screen.findByText('Sign this change');
    await settled(5);
    expect(answers).toEqual([]);
    fireEvent.click(button);
    expect(answers).toHaveLength(1);
    const answer = answers[0] as CommitteeUpdateSignatures;
    expect(answer.schema).toBe('midnight-identity/committee-signatures/v1');
    const exact = new L.MaintenanceUpdate(VAULT, [new L.ReplaceAuthority(new L.ContractMaintenanceAuthority(
      sorted(mine, joining) as never, 1, 4n))], 3n);
    /* RED WHEN: what the press signs is anything but the change the screen showed. */
    expect(L.verifySignature(mine as never, exact.dataToSign, answer.signatures[0]!.signature as never)).toBe(true);
    expect(await screen.findByText(/You signed a change to who holds this company's rules/)).toBeTruthy();
    /* RED WHEN: the screen says the change took effect when it reached the chain; it can reach the chain and change nothing. */
    expect(document.querySelector('[data-signed]')!.textContent).toMatch(/only once the chain shows that contract held by the new committee/);
  });

  it('SHOWS EVERY CONTRACT IT WILL SIGN FOR, THE COMPANY ACCOUNT INCLUDED, AND EVERY KEY OF THE NEW COMMITTEE', async () => {
    const answers: unknown[] = [];
    const contracts = [
      { contract: 'account', address: ACCOUNT, counter: '1', now: { committee: sorted(mine), threshold: 1 } },
      { contract: 'vault', address: VAULT, counter: '3', now: { committee: sorted(mine, leaving), threshold: 2 } },
    ];
    const { container } = renderWith(ask({ contracts }), answers);
    await screen.findByText('Sign this change');
    /* RED WHEN: a contract the press signs for is left off the screen. */
    expect(container.querySelector('[data-contract="account"]')!.textContent).toBe(ACCOUNT);
    expect(container.querySelector('[data-contract="vault"]')!.textContent).toBe(VAULT);
    expect([...container.querySelectorAll('[data-threshold-change]')].map((e) => e.textContent))
      .toEqual(['Threshold: 1 before, 1 after.', 'Threshold: 2 before, 1 after.']);
    /* RED WHEN: any key of the committee to be installed is left out of its list. */
    const listed = container.querySelector('[data-new-committee]')!.textContent!;
    for (const k of [mine, joining]) expect(listed).toContain(short(k.value));
    fireEvent.click(screen.getByText('Sign this change'));
    expect((answers[0] as CommitteeUpdateSignatures).signatures.map((x) => x.address)).toEqual([ACCOUNT, VAULT]);
  });

  it('SHOWS THE FINGERPRINT OF THE LABEL AND THE ACCOUNT TOGETHER, ONCE THE ACCOUNT HAS BEEN READ', async () => {
    /* RED WHEN: the screen renders a fingerprint of anything but the pair. */
    const { container } = renderWith(ask(), []);
    await screen.findByText('Sign this change');
    await settled(5);
    expect(container.querySelector('[data-company-fingerprint]')!.textContent).toBe(companyFingerprint(CO, ACCOUNT));
    expect(container.querySelector('[data-company-account]')!.textContent).toBe(ACCOUNT);
    expect(container.querySelector('[data-company-label]')!.textContent).toBe(CO);
  });

  it('SIGNS NOTHING WHEN THE ACCOUNT CARRIES ANOTHER COMPANY\'S LABEL, OR NONE, OR CANNOT BE READ', async () => {
    /* RED WHEN: the button opens, or a fingerprint is shown, before the account is found to carry the label. */
    const other = 'co_2222222222222222222222222222222222222222222222222222222222222222' as CompanyLabel;
    for (const [read, shown] of [
      [async () => ({ of: 'carries', label: other }), 'another-company'],
      [async () => ({ of: 'no-label' }), 'no-label'],
      [async () => ({ of: 'no-account' }), 'no-account'],
      [async () => ({ of: 'unreadable', why: 'offline.' }), 'unreadable'],
      [() => new Promise<never>(() => {}), 'checking'],
    ] as [LabelReader, string][]) {
      const answers: unknown[] = [];
      const { container } = renderWith(ask(), answers, consented, [], read);
      await screen.findByText('Sign this change');
      await settled(5);
      expect(container.querySelector(`[data-company-check="${shown}"]`), shown).not.toBeNull();
      expect(container.querySelector('[data-company-fingerprint]'), shown).toBeNull();
      expect((screen.getByText('Sign this change') as HTMLButtonElement).disabled, shown).toBe(true);
      fireEvent.click(screen.getByText('Sign this change'));
      expect(answers, shown).toEqual([]);
      cleanup();
    }
  });

  it('SAYS SO WHEN THIS PERSON\'S OWN KEY LEAVES', async () => {
    const { container } = renderWith(ask({ to: { committee: sorted(joining), threshold: 1 } }), [], consented, [], carries,
      chainOf({ [ACCOUNT]: held(sorted(joining), 1, 1n, null) }));
    await screen.findByText('Sign this change');
    await settled(5);
    expect(container.querySelector('[data-you-leave]')).not.toBeNull();
  });

  it('REFUSES A CONTRACT WHOSE COMMITTEE ON THE CHAIN DOES NOT HOLD THIS PERSON\'S KEY, WHATEVER THE PAGE SAYS, AND THE BUTTON STAYS SHUT', async () => {
    const answers: unknown[] = [];
    /* The page says this person holds the vault; the chain says only the leaving key does. */
    const { container } = renderWith(ask(), answers, consented, [], carries, chainOf({ [VAULT]: held(sorted(leaving), 1, 3n) }));
    await screen.findByText('This wallet will not sign this');
    /* RED WHEN: the page's word on who holds a contract now is believed over the chain. */
    expect(container.querySelector('[data-committee-refused]')!.textContent).toMatch(/not on the committee that holds vault .* on the chain/);
    expect((screen.getByText('Sign this change') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText('Sign this change'));
    expect(answers).toEqual([]);
  });

  it('SHOWS WHO HOLDS EACH CONTRACT AS THE CHAIN SAYS, NEVER AS THE PAGE SAYS', async () => {
    /* The page says only this person's key holds the vault, at one; the chain says the leaving key does too, at two. */
    const contracts = [{ contract: 'vault', address: VAULT, counter: '3', now: { committee: sorted(mine), threshold: 1 } }];
    const { container } = renderWith(ask({ contracts }), []);
    await screen.findByText('Sign this change');
    await settled(5);
    /* RED WHEN: the page's false `now` is shown: the leaving key would be hidden and the threshold misstated. */
    expect(container.querySelector('[data-leaves]')!.textContent).toContain(short(leaving.value));
    expect(container.querySelector('[data-threshold-change]')!.textContent).toBe('Threshold: 2 before, 1 after.');
  });

  for (const [name, chain, says] of [
    ['A HAND-OVER INSTALLING A COMMITTEE OTHER THAN THE ACCOUNT\'S ON THE CHAIN', chainOf({ [ACCOUNT]: held(sorted(mine), 1, 1n, null) }), /not the committee holding the company's account on the chain/],
    ['A VAULT PINNED TO ANOTHER ACCOUNT', chainOf({ [VAULT]: held(sorted(mine, leaving), 2, 3n, FOREIGN) }), /pinned to another account/],
    ['A CONTRACT THE CHAIN COULD NOT BE READ FOR', chainOf({ [VAULT]: { of: 'unreadable', why: 'offline.' } }), /could not read who holds vault/],
  ] as [string, ChainReader, RegExp][]) {
    it(`REFUSES ${name}, AND THE BUTTON STAYS SHUT`, async () => {
      const answers: unknown[] = [];
      const { container } = renderWith(ask(), answers, consented, [], carries, chain);
      await screen.findByText('This wallet will not sign this');
      /* RED WHEN: the screen signs what the chain, read at this wallet's own indexer, says it must not. */
      expect(container.querySelector('[data-committee-refused]')!.textContent).toMatch(says);
      expect((screen.getByText('Sign this change') as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(screen.getByText('Sign this change'));
      expect(answers).toEqual([]);
    });
  }

  it('a press the framing refuses does nothing, and declining is its own button', async () => {
    const answers: unknown[] = []; const declined: string[] = [];
    renderWith(ask(), answers, { ok: false, says: 'too small' } as never, declined);
    await screen.findByText('Sign this change');
    await settled(5);
    expect((screen.getByText('Sign this change') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText('Do not sign'));
    expect(declined).toEqual(['declined']);
    expect(answers).toEqual([]);
  });
});

describe('A CHANGE OF THE SUPER ADMINS, AND A JOINING KEY\'S OWN SIGNATURE, ON THE SAME SCREEN', () => {
  const SALT = '5a'.repeat(32);
  /* The joining key's holder: its key is the one this change adds. */
  const joiner = identityFromWords(newWords().join(' '));
  const joinerKey = committeeKeyFor(joiner, CO);
  const CHANGE = {
    kind: 'super-admins', from: { committee: sorted(mine, leaving), threshold: 2 }, committee: sorted(mine, joinerKey), threshold: 2,
    contracts: [{ contract: 'account', address: ACCOUNT, counter: '1' }, { contract: 'vault', address: VAULT, counter: '3' }],
  };
  const bytes = superAdminChangeBytes(CO, ACCOUNT, SALT, CHANGE as never);
  const hexOf = (b: Uint8Array) => PolyfillBuffer.from(b).toString('hex');
  const joinedSig = (L.signData(committeeSigningKeyFor(joiner, CO) as never, bytes) as unknown as Key).value;
  const before = chainOf({ [ACCOUNT]: held(sorted(mine, leaving), 2, 1n, null) });
  const superAdmins = (over: Record<string, unknown> = {}) => ask({
    to: undefined, change: CHANGE, salt: SALT, changeBytes: hexOf(bytes),
    joined: [{ key: { tag: 'schnorr', value: joinerKey.value }, signature: joinedSig }], contracts: CHANGE.contracts, ...over,
  });

  it('SHOWS THE JOINS AND LEAVES FROM THE CHAIN AND SIGNS EVERY CONTRACT ONCE EACH JOINING KEY HAS SIGNED THE CHANGE', async () => {
    const answers: unknown[] = [];
    const { container } = renderWith(superAdmins(), answers, consented, [], carries, before);
    const button = await screen.findByText('Sign this change');
    await settled(5);
    expect(container.querySelector('[data-joins-signed]')).not.toBeNull();
    expect(container.querySelector('[data-joins]')!.textContent).toContain(short(joinerKey.value));
    expect(container.querySelector('[data-leaves]')!.textContent).toContain(short(leaving.value));
    fireEvent.click(button);
    expect((answers[0] as CommitteeUpdateSignatures).signatures.map((x) => [x.address, x.counter])).toEqual([[ACCOUNT, '1'], [VAULT, '3']]);
  });

  it('REFUSES WHILE A JOINING KEY HAS NOT SIGNED THE CHANGE, AND BYTES THAT ARE NOT THE CHANGE', async () => {
    for (const [over, says] of [
      [{ joined: [] }, /has not signed the change with its own key/],
      [{ changeBytes: hexOf(superAdminChangeBytes(CO, ACCOUNT, SALT, { ...CHANGE, threshold: 1 } as never)) }, /not the change it asks/],
    ] as [Record<string, unknown>, RegExp][]) {
      const answers: unknown[] = [];
      const { container } = renderWith(superAdmins(over), answers, consented, [], carries, before);
      await screen.findByText('This wallet will not sign this');
      /* RED WHEN: the screen lets a press sign an update putting an unsigned key on the company, or bytes it did not rebuild. */
      expect(container.querySelector('[data-committee-refused]')!.textContent).toMatch(says);
      fireEvent.click(screen.getByText('Sign this change'));
      expect(answers).toEqual([]);
      cleanup();
    }
  });

  it('A JOINING KEY SIGNS THE CHANGE ITSELF, AND A KEY THE CHANGE DOES NOT INSTALL IS REFUSED', async () => {
    const joinAsk = ask({ to: undefined, contracts: undefined, change: CHANGE, salt: SALT, changeBytes: hexOf(bytes), joining: true });
    const answers: unknown[] = [];
    const { container } = render(
      <ApproveCommittee
        request={joinAsk} identity={joiner} channel={channelFor(answers)} consent={consented}
        whoIsAsking={<p>asker</p>} onDecline={() => {}} ledger={ledger} now={() => NOW} readLabel={carries} readChain={before} />);
    const button = await screen.findByText('Sign this change');
    await settled(5);
    expect(container.querySelector('[data-joining]')).not.toBeNull();
    fireEvent.click(button);
    const answer = answers[0] as CommitteeJoinSignature;
    expect(answer.schema).toBe('midnight-identity/committee-join/v1');
    /* RED WHEN: the joining signature is over anything but the change's bytes, by anything but this key. */
    expect(joinedBy(L as never, bytes, joinerKey, answer.signature)).toBe(true);
    cleanup();
    /* A key the change never names is not one it installs. */
    const stranger = identityFromWords(newWords().join(' '));
    const leaver = render(
      <ApproveCommittee
        request={joinAsk} identity={stranger} channel={channelFor([])} consent={consented}
        whoIsAsking={<p>asker</p>} onDecline={() => {}} ledger={ledger} now={() => NOW} readLabel={carries} readChain={before} />);
    await screen.findByText('This wallet will not sign this');
    expect(leaver.container.querySelector('[data-committee-refused]')!.textContent).toMatch(/not one this change installs/);
  });
});

describe('THE APPROVAL SURFACE ROUTES A COMMITTEE CHANGE TO THIS SCREEN', () => {
  let port: ReturnType<typeof watchedStore>;
  beforeEach(() => { port = watchedStore(); });

  it('and nothing is signed until the person presses', async () => {
    const opener = watchedOpener();
    const handlers: ((event: MessageEvent) => void)[] = [];
    const view: ChannelWindow = {
      opener: opener as ChannelWindow['opener'],
      addEventListener: (_t, h) => { handlers.push(h); },
      removeEventListener: () => {},
    };
    render(<Approve identity={identity} secret={SECRET} port={port} view={view} now={() => NOW} readLabel={carries} />);
    for (const h of handlers) h({ source: opener, origin: ORIGIN, data: wire() } as unknown as MessageEvent);
    /* RED WHEN: a committee ask is routed anywhere but its own screen. */
    expect(await screen.findByText(`Change who holds a company's rules, for ${ORIGIN}`)).toBeTruthy();
    await settled(20);
    expect(opener.sent.filter((m) => (m.message as { schema?: string }).schema === 'midnight-identity/committee-signatures/v1')).toEqual([]);
  });
});
