import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import * as runtime from '@midnight-ntwrk/compact-runtime';
import * as accountModule from '../../../../contracts/managed/contract/index.js';
import { witnesses } from '../../../../contracts/src/witnesses.js';
import { privateStateFor, leafOfDevice, COMPANY_LABEL } from '../../../../contracts/test/simulator.js';
import { payKeyRoundOf } from '../../../../src/midnight/pay-key-round.js';
import { newWrappingKeypair } from '../../../../src/core/crypto.js';
import type { GovernedCallDeps } from '../../../../packages/web-shared/src/governed-call-builder.js';
import { ACCOUNT_CIRCUITS_THE_WALLET_PROVES } from './account-circuits.js';
import { accountBuilderDeps, answerAccountAsk, startAccountBuilder, type AccountBuilderAsk } from './account-builder.js';

/*
 * The wallet's account builder, asked as its worker is asked. What it proves
 * with real keys is in `the-wallet-proves-the-pay-key.test.ts`; here, what it
 * reads, refuses and says, with no keys needed.
 */

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

describe('the account circuits the wallet proves', () => {
  it('are every circuit a signer governs the account with, and the two that anchor its records', () => {
    // RED WHEN: a circuit a seat action needs is left out of what the wallet proves, so that action can only be proved on the page
    expect([...ACCOUNT_CIRCUITS_THE_WALLET_PROVES].sort()).toEqual([
      'adopt', 'amendSigner', 'anchor', 'approve', 'cancel', 'propose', 'recoverAnchor', 'sealPayKey', 'setPolicy',
      'setPolicyBar', 'setThreshold', 'setVaultThreshold',
    ]);
  });
});

describe('the builder in its worker', () => {
  it('says it is ready only once it is listening, and answers each ask in the order it came', async () => {
    // RED WHEN: the builder says ready before it listens, so the first ask posted to it can be dropped
    const events: string[] = [];
    let listener: ((e: { data: unknown }) => void) | null = null;
    const answers: unknown[] = [];
    const scope = {
      addEventListener: (_t: 'message', l: (e: { data: unknown }) => void) => { events.push('listening'); listener = l; },
      postMessage: (m: unknown) => { events.push((m as { kind?: string }).kind ?? 'answer'); if ((m as { kind?: string }).kind === undefined) answers.push(m); },
    };
    const deps = vi.fn(async () => ({}) as GovernedCallDeps);
    startAccountBuilder(scope, deps);
    expect(events).toEqual(['listening', 'account-builder-ready']);
    listener!({ data: { id: 1, ask: 'deploy' } });
    listener!({ data: { id: 2, ask: 'deploy' } });
    listener!({ data: 'not an ask' });
    await vi.waitFor(() => expect(answers).toHaveLength(2));
    expect(answers.map((a) => (a as { id: number }).id)).toEqual([1, 2]);
    expect(answers[0]).toMatchObject({ ok: false, error: expect.stringMatching(/does not build/u) });
  });

  it('a call the builder refuses answers with its reason, and nothing is proved', async () => {
    // RED WHEN: a refused call escapes the builder instead of answering, so the starter waits for an answer that never comes
    const prove = vi.fn();
    const ask = {
      id: 7, ask: 'governed-call', network: 'undeployed', account: 'not an account', order: { circuit: 'cancel', proposal: '00'.repeat(32) },
      material: { signingSecret: '01'.repeat(32), blinding: '02'.repeat(32), scope: '03'.repeat(32) },
      chain: { accountState: '', parameters: '' }, opened: {} as never,
    } as unknown as AccountBuilderAsk;
    const answer = await answerAccountAsk(async () => ({ prove }) as unknown as GovernedCallDeps, ask);
    expect(answer).toMatchObject({ id: 7, ok: false, error: expect.stringMatching(/not for a company account/u) });
    expect(prove).not.toHaveBeenCalled();
  });

  it('reads where the pay-record key stands from the account state it is handed, and seals the key to the wrapping key named', async () => {
    // RED WHEN: the standing is worked out from another key than the pay-record key asked about, so the proposal it names is not the company's
    const founder = privateStateFor(1);
    const init = await new (accountModule as any).Contract(witnesses).initialState(
      runtime.createConstructorContext(founder, '0'.repeat(64)), leafOfDevice(founder), COMPANY_LABEL);
    const key = hex(new Uint8Array(randomBytes(32)));
    const account = 'c0'.repeat(32);
    const answer = await answerAccountAsk(accountBuilderDeps(), {
      id: 3, ask: 'pay-key-standing', account, key,
      accountState: Buffer.from(init.currentContractState.serialize()).toString('base64'),
      signingSecret: hex(founder.secretKey), wrappingPublicKey: newWrappingKeypair().publicKey,
    });
    if (!answer.ok || answer.ask !== 'pay-key-standing') throw new Error(`no standing: ${JSON.stringify(answer)}`);
    const round = payKeyRoundOf((accountModule as any).pureCircuits, key as never);
    expect(answer.standing.round).toMatchObject({ proposal: round.proposal, commitment: round.commitment, salt: round.salt, open: false });
    expect(answer.standing.committed).toBeNull();
    expect(answer.standing.sealedMine).toBe(false);
    expect(answer.standing.noVault).toBe(hex((accountModule as any).pureCircuits.noVault()));
    expect(answer.standing.wrap).toHaveLength(4);
  });
});
