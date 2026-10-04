/**
 * **A COMPANY'S ACCOUNT, CREATED FROM ITS FOUNDING SIGNER'S BROWSER, HELD BY
 * THEIR OWN COMMITTEE KEY FROM ITS FIRST TRANSACTION.**
 *
 * Driven with the pieces the product runs: the device's builder makes the
 * deploy, the founding signer's wallet reads that deploy itself and signs the
 * second step, the device puts the signature on the same update and both are
 * applied, in order, to an empty ledger in memory with every signature checked.
 * Nothing is proved against a circuit (a deploy and a maintenance update have
 * none) and nothing is sent anywhere.
 */
import { describe, expect, it } from 'vitest';
import * as L from '@midnightntwrk/ledger-v9';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { identityFromWords } from 'midnight-identity';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { creationShown } from 'midnight-identity/profile/creation-sign';
import type { CompanyLabel } from 'midnight-identity/profile/company-label';
import { buildAccountDeploy, finishedCreation } from '../../packages/web-shared/src/vault-builder.js';
import { labelInAccountState } from '../../apps/wallet/src/chain/company-label-on-chain.js';
import { CREATION_STEPS, DEPLOYED_CIRCUITS, PER_TRANSACTION_CEILING } from '../../src/midnight/deferral.js';
import { keysOnDisk, ACCOUNT_KEYS } from './keys-on-disk.js';
import {
  accountBuilderDeps, accountKeyFile as keyFile, anAccountBornHeld, creationAskOf, digest, thisBuilds,
} from './an-account-born-held.js';

const NET = 'undeployed';
const NOW = new Date();
const seconds = BigInt(Math.floor(NOW.getTime() / 1000));
const LABEL = `co_${'5a'.repeat(32)}` as CompanyLabel;
const LEAF = '7c'.repeat(32);
const ON_DISK = keysOnDisk([ACCOUNT_KEYS]).ok;

const strictness = () => {
  const s = new L.WellFormedStrictness();
  s.enforceBalancing = false; s.verifyNativeProofs = false; s.verifyContractProofs = false; s.enforceLimits = true; s.verifySignatures = true;
  return s;
};
const blockContext = { secondsSinceEpoch: seconds, secondsSinceEpochErr: 30, parentBlockHash: '00'.repeat(32), lastBlockTime: seconds - 6n };
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');

const founder = identityFromWords(TEST_MNEMONIC);
const foundingKey = committeeKeyFor(founder, LABEL);
const deps = () => accountBuilderDeps(NET);
const askOf = (deploy: Uint8Array, address: string, over: Record<string, unknown> = {}) =>
  creationAskOf(LABEL, deploy, address, NOW.getTime(), over);

describe.skipIf(!ON_DISK)('A COMPANY BORN HELD [needs contracts/managed/keys; `npm run compact` builds them]', () => {
  const create = () => anAccountBornHeld({ network: NET, founder, label: LABEL, foundingLeaf: LEAF, now: NOW.getTime() });
  const apply = (state: any, bytes: Uint8Array) => {
    const tx = (L.Transaction.deserialize('signature', 'proof', 'pre-binding', bytes) as any).bind();
    const [next, result] = state.apply(tx.wellFormed(state, strictness(), NOW), new L.TransactionContext(state, blockContext));
    return { next, result };
  };

  it('THE LEDGER TAKES THE DEPLOY HELD BY THE FOUNDING SIGNER\'S OWN KEY, AND THE INSERT THAT KEY ALONE SIGNED', async () => {
    const { deploy, answer, insert } = await create();
    /* The wallet worked the address out from the deploy, and it is the one the device computed. */
    expect(answer.account).toBe(deploy.address);
    let ledger: any = L.LedgerState.blank(NET);
    const first = apply(ledger, deploy.proven);
    expect(first.result.type).toBe('success');
    ledger = first.next;
    const held = ledger.index(deploy.address).maintenanceAuthority;
    /* RED WHEN the deploy is held by anything but the founding signer's committee key, at 1, never changed. */
    expect([[...held.committee].map((k: any) => k.value), held.threshold, held.counter]).toEqual([[foundingKey.value], 1, 0n]);
    const second = apply(ledger, insert.proven);
    expect(second.result.type).toBe('success');
    const done = second.next.index(deploy.address);
    /* RED WHEN the second step inserts less than the rest of the account, or a key other than this build's. */
    expect([...done.operations()].map(String).sort()).toEqual([...DEPLOYED_CIRCUITS].sort());
    for (const c of DEPLOYED_CIRCUITS) expect(Buffer.from(done.operation(c).verifierKey)).toEqual(Buffer.from(keyFile(c)));
    expect([[...done.maintenanceAuthority.committee].map((k: any) => k.value), done.maintenanceAuthority.counter]).toEqual([[foundingKey.value], 1n]);
    /* Each step fits one transaction, and what each writes is printed beside the result. */
    expect(deploy.bytesWritten).toBeLessThan(PER_TRANSACTION_CEILING);
    expect(insert.bytesWritten).toBeLessThan(PER_TRANSACTION_CEILING);
    console.log(`  MEASURED: deploy ${deploy.proven.length} bytes, ${deploy.bytesWritten} written; signed insert ${insert.proven.length} bytes, ${insert.bytesWritten} written; ceiling ${PER_TRANSACTION_CEILING}`);
  });

  it('AN INSERT SIGNED BY ANY OTHER KEY, OR FOR ANOTHER ACCOUNT, IS REFUSED BY THE LEDGER', async () => {
    const { deploy, answer } = await create();
    const ledger = apply(L.LedgerState.blank(NET), deploy.proven).next;
    const keys = new Map(CREATION_STEPS.second.map((c) => [c, keyFile(c)] as [string, Uint8Array]));
    const stranger = L.signData(L.sampleSigningKey(), new Uint8Array([1]));
    const forged = await finishedCreation(deps(), { account: deploy.address, keys, signature: stranger });
    /* RED WHEN a signature that is not the founding signer's lets the second step land. */
    expect(() => apply(ledger, forged.proven)).toThrow();
    const another = await buildAccountDeploy(deps(), { foundingLeaf: LEAF, label: LABEL, foundingKey });
    const ledger2 = apply(ledger, another.proven).next;
    const misdirected = await finishedCreation(deps(), { account: another.address, keys, signature: answer.signature });
    /* The signature covers the address: the same press does not finish a second account. */
    expect(() => apply(ledger2, misdirected.proven)).toThrow();
  });

  it('THE FOUNDING SIGNER\'S WALLET REFUSES A DEPLOY IT DID NOT DRAW, IS NOT HELD BY ITS KEY, OR RUNS ANOTHER BUILD\'S CIRCUITS', async () => {
    const d = deps();
    const good = await buildAccountDeploy(d, { foundingLeaf: LEAF, label: LABEL, foundingKey });
    const shown = creationShown(L as never, founder, askOf(good.proven, good.address), thisBuilds, digest, labelInAccountState);
    expect(shown).toMatchObject({ account: good.address, mine: foundingKey });
    const refused = (bytes: Uint8Array, address: string, over: Record<string, unknown> = {}, build = thisBuilds) => {
      try {
        creationShown(L as never, founder, askOf(bytes, address, over), build, digest, labelInAccountState);
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    };
    /* RED WHEN the address the page names is taken rather than worked out from the deploy. */
    expect(refused(good.proven, 'ee'.repeat(32))).toMatch(/names an account the deploy it sent does not create/);
    /* RED WHEN a deploy held by another key is signed for. */
    const theirs = await buildAccountDeploy(d, { foundingLeaf: LEAF, label: LABEL, foundingKey: L.signatureVerifyingKey(L.sampleSigningKey()) });
    expect(refused(theirs.proven, theirs.address)).toMatch(/not held by your own key/);
    /* RED WHEN a deploy carrying another label is signed for. */
    const other = `co_${'6b'.repeat(32)}`;
    const elsewhere = await buildAccountDeploy(d, { foundingLeaf: LEAF, label: other, foundingKey });
    expect(refused(elsewhere.proven, elsewhere.address)).toMatch(/not held by your own key|does not carry the label/);
    /* RED WHEN a first-step circuit that is not this build's is signed for. */
    const swappedFirst = { ...thisBuilds, first: new Map([...thisBuilds.first].map(([c, h]) => [c, c === 'approve' ? new Uint8Array(32) : h] as [string, Uint8Array])) };
    expect(refused(good.proven, good.address, {}, swappedFirst)).toMatch(/circuits the deploy runs are not this build's/);
    /* RED WHEN a key the page asks to insert is not this build's. */
    const drained = CREATION_STEPS.second.map((c) => ({ circuit: c, key: b64(c === 'recordPaymentFromVault' ? keyFile('approve') : keyFile(c)) }));
    expect(refused(good.proven, good.address, { insert: drained })).toMatch(/keys the page asks to add are not this build's/);
    /* RED WHEN a key is left out, or one more is added: every key this build's, so only the set itself can refuse. */
    const honest = CREATION_STEPS.second.map((c) => ({ circuit: c, key: b64(keyFile(c)) }));
    expect(refused(good.proven, good.address, { insert: honest.slice(1) })).toMatch(/keys the page asks to add are not this build's/);
    expect(refused(good.proven, good.address, { insert: [...honest, { circuit: 'adopt', key: b64(keyFile('adopt')) }] }))
      .toMatch(/keys the page asks to add are not this build's/);
  });
});
