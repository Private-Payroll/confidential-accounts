// @vitest-environment jsdom
/**
 * **A COMPANY'S ACCOUNT, AS THIS WALLET READS IT AT ITS OWN INDEXER: ONE BLOCK NAMED FIRST, THE ACCOUNT AS OF IT.**
 *
 * The two readers a company's creation and an action on a company call: whether the account is finished, and what a
 * call to it is built on. The account is a real ledger 9 state carrying every circuit of the creation's second step,
 * with this build's own verifying keys, served as the indexer's reader serves it: bytes with the era that wrote them.
 * The reader is a stand-in that says what it was asked.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as L from '@midnightntwrk/ledger-v9';
import { SerializedContractState, SerializedLedgerParameters } from '@midnight-ntwrk/midnight-js-types';
import { CREATION_STEPS } from '../../../../src/midnight/deferral.js';

const ACCOUNT = 'c0'.repeat(32);
const BLOCK = 'b7'.repeat(32);
const KEYS = join(import.meta.dirname, '..', '..', '..', '..', 'contracts', 'managed', 'keys');
const INDEXER = { indexerUri: 'https://indexer.invalid/api', indexerWsUri: 'wss://indexer.invalid/ws' };
const PUBLIC_DATA = '../../../../packages/web-shared/src/public-data.js';

/** An account carrying every circuit the creation's second step puts on it. */
const finishedAccount = (): L.ContractState => {
  const state = new L.ContractState();
  for (const circuit of CREATION_STEPS.second) {
    const op = new L.ContractOperation();
    op.verifierKey = new Uint8Array(readFileSync(join(KEYS, `${circuit}.verifier`)));
    state.setOperation(circuit, op);
  }
  return state;
};

/** The compiled account's keys are on disk only once `npm run compact` has built them. */
const ON_DISK = existsSync(join(KEYS, `${CREATION_STEPS.second[0]}.verifier`));
let accountBytes: Uint8Array;
const parameterBytes = L.LedgerParameters.initialParameters().serialize();

/** The wallet's two readers over a stand-in indexer that names a block (or none) and holds the account (or not). */
const readersOver = async (o: { block?: boolean; account?: boolean } = {}) => {
  const asked: string[] = [];
  vi.resetModules();
  vi.doMock(PUBLIC_DATA, async (original) => ({
    ...(await original<object>()),
    publicDataProviderFor: async () => ({
      queryBlock: async () => {
        asked.push('block');
        return o.block === false ? null : { hash: BLOCK };
      },
      queryZSwapAndContractState: async (address: string, at: { blockHash: string }) => {
        asked.push(`${address.slice(0, 4)} at ${at.blockHash.slice(0, 4)}`);
        return o.account === false
          ? null
          : {
              contractState: SerializedContractState.fromBytes('v9', accountBytes),
              ledgerParameters: SerializedLedgerParameters.fromBytes('v9', parameterBytes)
            };
      }
    })
  }));
  const { liveCreationChain } = await import('./creation-chain.js');
  const { liveCompanyChain } = await import('./company-chain.js');
  return { asked, creation: liveCreationChain(INDEXER), company: liveCompanyChain(INDEXER) };
};

afterEach(() => {
  vi.doUnmock(PUBLIC_DATA);
  vi.resetModules();
});

describe.skipIf(!ON_DISK)(
  "A COMPANY'S ACCOUNT IS READ AT THE BLOCK THE INDEXER NAMES FIRST [needs contracts/managed/keys; `npm run compact` builds them]",
  () => {
    beforeAll(() => {
      accountBytes = finishedAccount().serialize();
    });
    it('a creation reads the account and the parameters at that block, and the account as finished from its decoded circuits', async () => {
      const { asked, creation } = await readersOver();
      const seen = await creation.account(ACCOUNT);
      /* RED WHEN: the account is read at any moment but the block named first. */
      expect(asked).toEqual(['block', 'c0c0 at b7b7']);
      /* RED WHEN: the state or the parameters a call is built on are anything but the bytes the indexer served. */
      expect([seen!.state, seen!.parameters]).toEqual([accountBytes, parameterBytes]);
      /* RED WHEN: the circuits are read off the served bytes without decoding them, so a finished account reads as unfinished. */
      expect(seen!.finished).toBe(true);
    });

    it('an action builds its call on the same read, each state as base64 of its bytes', async () => {
      const { asked, company } = await readersOver();
      const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
      /* RED WHEN: the call state crosses as anything but the block and the two states read at it. */
      expect(await company.callState(ACCOUNT as never)).toEqual({
        blockHash: BLOCK,
        accountState: b64(accountBytes),
        parameters: b64(parameterBytes)
      });
      expect(asked).toEqual(['block', 'c0c0 at b7b7']);
    });

    it('a block the indexer does not name, or an account it does not hold, is not read yet, by either reader', async () => {
      for (const o of [{ block: false }, { account: false }]) {
        const { creation, company } = await readersOver(o);
        /* RED WHEN: an indexer with no block, or no account at it, is answered as an account. */
        expect([await creation.account(ACCOUNT), await company.callState(ACCOUNT as never)], JSON.stringify(o)).toEqual(
          [null, null]
        );
      }
    });
  }
);
