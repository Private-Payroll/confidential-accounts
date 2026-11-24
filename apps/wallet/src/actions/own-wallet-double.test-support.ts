/*
 * A person's own wallet, stood in for: it reads a call as the ledger reads it, pays the call's fee with one DUST spend
 * it holds, and hands the call to the chain it is given. Shared by the tests that send from a signer's own wallet. Also
 * a reader's own wallet, which answers a company's ask for a reader's code as the wallet answers it.
 */
import { of } from 'rxjs';
import { DefaultForkSchedule } from '@midnightntwrk/wallet-sdk';
import { identityFromSecret } from 'midnight-identity/keys/derivation';
import { joinCodeAnswerFor, writeJoinCode } from 'midnight-identity/profile/join-code';
import type { JoinCodeRequest } from 'midnight-identity/profile/request';
import { ACCOUNT_IN_A_TEST } from '../../../../src/testing/record-tree-double.js';
import { ownJoinKeysOf } from '../screens/join-code-reader-key.js';
import type { OwnWalletDoors } from './recovery.js';

/** One intent as the ledger shapes it: every field the checks read is there, set only where `over` sets it. */
export const intentOf = (actions: readonly unknown[], over: Record<string, unknown> = {}) =>
  ({ actions, guaranteedUnshieldedOffer: undefined, fallibleUnshieldedOffer: undefined, dustActions: undefined, ...over });
/**
 * A proven call as the ledger reads it: the one call its words name, by its circuit or its order's, to `account`, moving
 * nothing, unless `over` adds to it.
 */
const callRead = (raw: string, account: string, over: Record<string, unknown> = {}) => {
  const t = JSON.parse(Buffer.from(raw, 'base64').toString()) as { circuit?: string; order?: { circuit: string } };
  return {
    raw, guaranteedOffer: undefined, fallibleOffer: undefined, intents: new Map([[1, intentOf([{ address: account, entryPoint: t.circuit ?? t.order?.circuit }])]]),
    imbalances: () => new Map(), ...over,
  };
};

/**
 * What a test changes of the wallet and the company it sends for: `call` is what the ledger reads in the call besides,
 * `adds` anything more the wallet would add to the fee, `noDust` a wallet holding no DUST, `account` the account the calls
 * go to (the record tree's test account unless named); `approvals` and `carryFails` are the company's, for the test that
 * stands it in.
 */
export interface Over { call?: Record<string, unknown>; adds?: Record<string, unknown>; noDust?: boolean; approvals?: number; carryFails?: boolean; account?: string }
/** The chain a wallet's send reaches: it takes the call's bytes, as the wallet hands them over. */
export interface TakesCalls { readonly takes: (tx: string) => unknown }
/** The person's own wallet: pays each call's fee with one DUST spend and hands it to the chain; `adds` is anything more it would add. */
export const ownWalletOver = (chain: TakesCalls, log: string[], o: Over = {}): OwnWalletDoors => ({
  ledger: async () => ({ Transaction: { deserialize: (_s: 'signature', _p: 'proof', _b: 'pre-binding', raw: Uint8Array) => callRead(Buffer.from(raw).toString('base64'), o.account ?? ACCOUNT_IN_A_TEST, o.call) } }),
  signSegment: () => (async () => 'signed') as never,
  facade: async () => ({
    dust: { state: { subscribe: (w: { next: (s: { progress: { isConnected: boolean; isStrictlyComplete(): boolean } }) => void }) => { w.next({ progress: { isConnected: true, isStrictlyComplete: () => true } }); return { unsubscribe: () => {} }; } } },
    state: () => of({ activeProtocolVersion: DefaultForkSchedule.v9 }),
    /* A handle the facade adopts carries the call its bytes are, read as the ledger reads them. */
    adoptTransaction: (raw: Uint8Array) => callRead(Buffer.from(raw).toString('base64'), o.account ?? ACCOUNT_IN_A_TEST, o.call),
    balanceUnboundTransaction: async (call: never, options: { tokenKindsToBalance?: 'all' | string[] }) => {
      if (o.noDust === true) throw Object.assign(new Error('Insufficient funds'), { name: 'InsufficientFundsError' });
      const kinds = options.tokenKindsToBalance;
      log.push(`fee in ${kinds === undefined || kinds === 'all' ? 'dust,shielded,unshielded' : kinds.join(',')}`);
      return {
        baseTransaction: call,
        balancingTransaction: { guaranteedOffer: undefined, fallibleOffer: undefined, intents: new Map([[1, intentOf([], { dustActions: { spends: [1], registrations: [] } })]]), ...o.adds },
      };
    },
    signRecipe: async (r: never) => r,
    finalizeRecipe: async (r: never) => r,
    submitTransaction: async (r: never) => { const raw = (r as { baseTransaction: { raw: string } }).baseTransaction.raw; log.push('own wallet sent'); await chain.takes(raw); },
    revert: async () => { log.push('fee undone'); },
  }) as never,
});

/**
 * The code a reader's own wallet, made from the secret `fill` repeats, signs for `person` when the company at `account`
 * labelled `company` asks for a reader's code from `origin`: its own reader key for the company, signed as the wallet
 * signs it when its person presses, written as the page is handed it.
 */
export const readerCodeFrom = (fill: number, ask: { readonly company: string; readonly account: string; readonly person: string; readonly origin: string }): string => {
  const identity = identityFromSecret(new Uint8Array(32).fill(fill) as never);
  const request = {
    kind: 'join-code', company: ask.company, account: ask.account, person: ask.person, parts: { kind: 'reader' },
    requester: { origin: ask.origin, name: 'Payroll', rdns: 'example.payroll' },
  } as unknown as JoinCodeRequest;
  return writeJoinCode(joinCodeAnswerFor(identity, request, [], null, ownJoinKeysOf(identity, request).ownReaderKey));
};
