// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '../testing/render.js';
import { Buffer as PolyfillBuffer } from 'buffer/';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { identityFromWords } from 'midnight-identity/keys/derivation';
import { parseAsk } from 'midnight-identity/profile/request';
import type { BalanceRequest } from 'midnight-identity/profile/request';
import type { Channel } from 'midnight-identity/profile/channel';
import { settled } from '../testing/settled-channel.js';
import { ApproveBalance, liveBalanceDoors } from './approve-balance.js';
import { PublicKey } from '@midnightntwrk/wallet-sdk';
import { unshieldedKeystoreFor } from '../chain/unshielded.js';
import type { BalanceDoors, FacadeForBalancing, WalletPartForBalancing } from '../chain/balance-for-page.js';

/*
 * The screen a person sees when a company's page asks this wallet to pay for a
 * PUBLIC deposit: the public token and amount that leave, and that they are
 * public, all before the one press; and the wallet balancing only public money,
 * and only as shown.
 */
(globalThis as { Buffer?: unknown }).Buffer = PolyfillBuffer;

const NOW = 1_755_000_000_000;
const identity = identityFromWords(TEST_MNEMONIC);
const ORIGIN = 'https://payroll-a.example';
const CO = 'dbe119a304f8e7ea882353435c1d536cf2faf4298236a9aae77670e750af65c8';
const VAULT = '54ef954a25aefff8e1675af10a852ef29d5de5c63a51b64b978bf7bd0eaeca4e';
const NIGHT = '00'.repeat(32);
const ME = '46'.repeat(32);

const ask = parseAsk({
  schema: 'midnight-identity/disclosure-request/v1', kind: 'balance',
  requester: { name: 'Payroll A', rdns: 'example.payroll-a' }, purpose: 'Put money into your company vault.',
  nonce: 'b1', expiresAt: NOW + 600_000, company: CO, vault: VAULT, transaction: 'AAECAw==',
}, ORIGIN, NOW) as BalanceRequest;

const effects = {
  claimedNullifiers: [], claimedShieldedReceives: [], claimedShieldedSpends: [], claimedContractCalls: [],
  shieldedMints: new Map(), unshieldedMints: new Map(), unshieldedOutputs: new Map(), claimedUnshieldedSpends: new Map(),
  unshieldedInputs: new Map([[{ tag: 'unshielded', raw: NIGHT }, 2_500_000n]]),
};
/** A part of the wallet that has read the chain to the end. */
const read = (): WalletPartForBalancing => ({
  state: { subscribe: (o) => { o.next({ progress: { isConnected: true, isStrictlyComplete: () => true } }); return { unsubscribe: () => {} }; } },
});
/** One that has connected and is still reading. */
const stillReading = (): WalletPartForBalancing => ({
  state: { subscribe: (o) => { o.next({ progress: { isConnected: true, isStrictlyComplete: () => false } }); return { unsubscribe: () => {} }; } },
});
const doorsWith = (log: string[], facade: Partial<FacadeForBalancing> = {}) => (): BalanceDoors => ({
  ledger: async () => ({
    Transaction: {
      deserialize: () => ({
        intents: new Map([[1, { actions: [{ address: VAULT, entryPoint: 'depositUnshielded', guaranteedTranscript: { effects } }] }]]),
        imbalances: (s: number) => new Map(s === 0 ? [[{ tag: 'unshielded', raw: NIGHT }, -2_500_000n]] : []),
      }),
    },
  }),
  facade: async () => ({
    balanceUnboundTransaction: async (_t, _k, o) => {
      log.push(`balance ${o.tokenKindsToBalance.join(',')}`);
      return {
        type: 'UNBOUND_TRANSACTION',
        baseTransaction: { intents: new Map([[1, { guaranteedUnshieldedOffer: {
          inputs: [{ value: 3_000_000n, type: NIGHT }], outputs: [{ value: 500_000n, type: NIGHT, owner: ME }],
        } }]]), imbalances: () => new Map() },
      };
    },
    signRecipe: async () => { log.push('sign'); return 'signed'; },
    finalizeRecipe: async () => { log.push('finish'); return { serialize: () => new Uint8Array([4, 2]) }; },
    revert: async () => { log.push('revert'); },
    shielded: read(),
    unshielded: read(),
    ...facade,
  }) as FacadeForBalancing,
  keys: () => ({ shieldedSecretKeys: 'z', dustSecretKey: 'd' }),
  signSegment: () => async () => ({}) as never,
  ownPublicAddress: () => ME,
  now: () => NOW,
});
const channelFor = (answers: unknown[]): Channel => ({
  answer: (a) => { answers.push(a); }, refuse: (r: string, why?: string) => { answers.push(why === undefined ? { refused: r } : { refused: r, why }); }, stop: () => {},
} as Channel);
const renderWith = (doors: () => BalanceDoors, answers: unknown[]) => render(
  <ApproveBalance
    request={ask} identity={identity} account={0} channel={channelFor(answers)} consent={{ ok: true } as never}
    whoIsAsking={<p>asker</p>} whichWallet={<p>picker</p>} onDecline={() => {}}
    doorsFor={doors} now={() => NOW} />);

afterEach(() => { cleanup(); });

describe('A PAGE ASKING THIS WALLET TO PAY FOR A PUBLIC DEPOSIT', () => {
  it('SHOWS THE PUBLIC TOKEN, THE AMOUNT AND THAT THEY ARE PUBLIC BEFORE THE PRESS, AND PAYS NOTHING UNTIL IT', async () => {
    const log: string[] = []; const answers: unknown[] = [];
    renderWith(doorsWith(log), answers);
    /* RED WHEN: the screen names another amount or token, or does not say they are public, before the press. */
    expect(await screen.findByText('2.5 NIGHT, from your public balance')).toBeTruthy();
    expect(screen.getByText(`unshielded token ${NIGHT}`)).toBeTruthy();
    expect(document.querySelector('[data-public-deposit]')?.textContent).toMatch(/anyone reading the chain can see them/);
    expect(document.querySelector('[data-headline]')?.textContent).toMatch(/^Pay publicly into a company vault for /);
    /* RED WHEN: spending NIGHT publicly is shown without saying it can stop this wallet's DUST. */
    expect(document.querySelector('[data-night-stops-dust]')?.textContent).toMatch(/^NIGHT that goes into the vault no longer generates DUST for this wallet\.$/);
    expect(document.querySelector('[data-pay]')?.textContent).toBe('Pay publicly into the vault');
    await settled(20);
    expect(log).toEqual([]);
    expect(answers).toEqual([]);
    fireEvent.click(document.querySelector('[data-pay]')!);
    await settled(20);
    /* RED WHEN: a public deposit is balanced in anything but public money, or answered without the public amount it paid. */
    expect(log).toEqual(['balance unshielded', 'sign', 'finish']);
    expect(answers.length).toBe(1);
    expect((answers[0] as { leaves: unknown }).leaves).toEqual([{ token: NIGHT, amount: '2500000', kind: 'unshielded' }]);
  });

  it('WHILE ITS PUBLIC COINS ARE STILL BEING READ, IT SAYS SO AND ADDS NOTHING', async () => {
    const log: string[] = []; const answers: unknown[] = [];
    renderWith(doorsWith(log, { unshielded: stillReading() }), answers);
    await screen.findByText('2.5 NIGHT, from your public balance');
    fireEvent.click(document.querySelector('[data-pay]')!);
    await settled(20);
    /* RED WHEN: the public deposit is balanced before its public coins are read, or the screen says nothing while it waits. */
    expect(log).toEqual([]);
    expect(document.querySelector('[data-reading-the-chain]')?.textContent).toMatch(/^Your wallet is reading the network to find your public coins before it adds them\./);
    expect(answers).toEqual([]);
  });

  it('WHEN WHAT THE WALLET WOULD ADD IS NOT WHAT IT SHOWED, NOTHING IS SIGNED OR HANDED BACK', async () => {
    const log: string[] = []; const answers: unknown[] = [];
    renderWith(doorsWith(log, {
      balanceUnboundTransaction: async () => {
        log.push('balance');
        return { baseTransaction: { intents: new Map([[1, { guaranteedUnshieldedOffer: {
          inputs: [{ value: 3_000_000n, type: NIGHT }], outputs: [{ value: 500_000n, type: NIGHT, owner: '33'.repeat(32) }],
        } }]]) } };
      },
    }), answers);
    await screen.findByText('2.5 NIGHT, from your public balance');
    fireEvent.click(document.querySelector('[data-pay]')!);
    await settled(20);
    /* RED WHEN: the wallet signs a public payment to anyone but itself. */
    expect(log).toEqual(['balance', 'revert']);
    /* RED WHEN: the page is handed a transaction, or is told anything but that what was about to be paid was not what was approved. */
    expect(answers).toEqual([{ refused: 'failed', why: 'not-as-approved' }]);
    expect(document.querySelector('[data-balance-failed]')?.textContent).toMatch(/someone other than itself, so it signed nothing/);
    /* RED WHEN: the person is not told the page heard that the payment failed. */
    expect(document.querySelector('[data-balance-failed]')?.textContent).toMatch(/The page was given nothing and has been told this payment failed\.$/);
  });
});

describe('THE WALLET\'S OWN PUBLIC ADDRESS, AS THE PRESS CHECKS CHANGE AGAINST IT', () => {
  it('IS THE ADDRESS THE WALLET SDK WRITES ON THIS WALLET\'S OWN CHANGE, AS THE LEDGER WRITES IT', () => {
    const doors = liveBalanceDoors(identity, 0);
    /* RED WHEN: the door answers the address in any other form, so every public deposit's change reads as a stranger's. */
    expect(doors.ownPublicAddress!()).toMatch(/^[0-9a-f]{64}$/);
    expect(doors.ownPublicAddress!()).toBe(String((PublicKey as any).fromKeyStore(unshieldedKeystoreFor(identity, 0)).addressHex));
  });
});
