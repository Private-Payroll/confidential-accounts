/**
 * A VAULT'S SECRET REPLACED, ON THE SIMULATED LEDGER, BY A SIGNER WHO DID NOT RAISE THE RUN.
 *
 * The vault and its company's account run here as two contracts (`the-new-vault.test.ts` sets the pattern), with the
 * product's own pieces of a secret run between them: the run made over the commitment the vault holds
 * (`secretRunOf`), its record sealed with every reader's copy (`sealVaultSecretProposal`), the approver's secret opened
 * from its own copy in that record (`startRecordOpened`, `runSecretOfTheRecord`), and the secret the vault last had
 * every copy written for found among the approver's records (`startStandingOf`'s `earlier`). Three signers, two
 * approvals: Ada raises, Bo approves and carries, and every copy is written. A run raised before a signer is removed is
 * read as such, which is what keeps every device from approving or carrying it. Once the new secret is set and before
 * the company's records hold it, Bo pays a person from the vault under it, read from his own copy on the chain.
 *
 * Every assertion names the change that turns it red.
 */
import { describe, expect, it } from 'vitest';
import { createCircuitContext, createConstructorContext, degradeToTransient, sampleContractAddress, type ChargedState, type ContractState } from '@midnight-ntwrk/compact-runtime';
import { Contract as Vault, ledger as vaultLedger, pureCircuits as V } from '../managed-vault/contract/index.js';
import { pureCircuits as P } from '../managed/contract/index.js';
import { AccountSimulator, TEST_TOKEN_BYTES, payoutTreeOf, privateStateFor, removalPayloadFor, vaultRunOf, type Change } from './simulator.js';
import { fromHex, toHex, type Hex } from '../../src/core/crypto.js';
import { recordsKeypairFrom, openNonceSecrets, startNonceSecret } from '../../src/midnight/company-nonce-secret.js';
import { secretRunOf, startStandingOf, type AccountStartPure, type SecretRun, type VaultStartPure } from '../../src/midnight/vault-start.js';
import { sealVaultSecretProposal, signProposalFiling } from '../../src/core/proposal-filing.js';
import type { SealedProposal } from '../../src/core/types.js';
import { MemorySealedPoolStore } from '../../src/midnight/vault-pool.js';
import { runSecretOfTheRecord, startRecordOpened } from '../../packages/web-shared/src/vault-secret-run-record.js';
import type { CreateVaultDoors } from '../../packages/web-shared/src/vault-doors.js';
import { theSecretToSpend } from '../../packages/web-shared/src/vault-secret-to-spend.js';
import { readersCopyOnTheChain } from '../../src/midnight/sealed-secret-copy.js';
import { noFurtherNote } from '../../src/midnight/vault-step-notes.js';

const A = privateStateFor(1);
const B = privateStateFor(2);
const C = privateStateFor(3);
const NOW = 1_800_000_000;
const OPENS = BigInt(NOW - 600);
const CLOSES = BigInt(NOW + 86_400);
const BLOCK = '0'.repeat(64);
const ZERO = new Uint8Array(32);
const VIEWING = '44'.repeat(32) as Hex;
const circuits = { vault: V as unknown as VaultStartPure, account: P as unknown as AccountStartPure };

/** Each signer's records key, from the company key their wallet releases. */
const companyKeyOf = (n: number) => new Uint8Array(32).fill(0x40 + n);
const readerOf = (n: number) => recordsKeypairFrom(companyKeyOf(n));
const READERS = [1, 2, 3].map((n) => readerOf(n).publicKey as Hex);

interface VaultPrivate { coin: unknown; secret: Uint8Array }
const witnesses = {
  noteToSpend: (ctx: { privateState: VaultPrivate }) => [ctx.privateState, ctx.privateState.coin],
  nonceSecret: (ctx: { privateState: VaultPrivate }) => [ctx.privateState, ctx.privateState.secret],
};

class World {
  sim!: AccountSimulator;
  vault = new Vault<VaultPrivate>(witnesses as never);
  addr = '';
  /* The vault's state as deployed, then as each call left it. */
  state!: ContractState | ChargedState;
  priv: VaultPrivate = { coin: null, secret: ZERO };
  get self(): Uint8Array { return fromHex(this.addr); }
  get ledger() { return vaultLedger('data' in this.state ? this.state.data : this.state); }

  static async make(): Promise<World> {
    const w = new World();
    w.sim = await AccountSimulator.liveAccount([A, B, C], 2n);
    w.sim.at(NOW);
    w.addr = String(sampleContractAddress());
    const init = await w.vault.initialState(createConstructorContext({} as VaultPrivate, BLOCK), { bytes: fromHex(String(w.sim.address)) } as never);
    w.state = init.currentContractState;
    await w.sim.adoptVault(w.self, [A, B]);
    return w;
  }

  async call(circuit: string, ...args: unknown[]): Promise<void> {
    const provider = {
      getContractState: async (_b: string, address: unknown) =>
        String(address) === String(this.sim.address) ? (this.sim.contractStateForCall as never) : undefined,
    };
    const ctx = createCircuitContext<VaultPrivate>(circuit as never, this.addr as never, BLOCK, this.state as never, this.priv,
      provider as never, undefined, undefined, NOW, BLOCK);
    const out = await (this.vault.impureCircuits as Record<string, (...a: unknown[]) => Promise<{ context: { callContext: { currentQueryContext: { state: ChargedState } } } }>>)[circuit]!(ctx, ...args);
    this.state = out.context.callContext.currentQueryContext.state;
    try { this.sim.adoptFromCall(out.context as never); } catch { /* a sealed copy's call does not reach the account: nothing to carry forward */ }
  }

  /** The run's change, as each device carrying it holds it: nothing moves, under the run's own salt. */
  changeOf(run: SecretRun): Change {
    return { asset: fromHex(run.asset), amount: 0n, batch: ZERO, salt: fromHex(run.salt) };
  }

  /** `by[0]` raises the run, the rest approve it; its identity on the account. */
  async raised(run: SecretRun, by: typeof A[]): Promise<Uint8Array> {
    const c = this.changeOf(run);
    await this.sim.as(this.sim.applying(by[0]!, c)).proposeRun({ root: fromHex(run.root), payees: run.payees, from: OPENS, until: CLOSES, vault: this.self });
    const id = this.sim.proposalId(P.runPayload(fromHex(run.root), run.payees, OPENS, CLOSES, 0n), c.salt, this.self);
    for (const a of by.slice(1)) await this.sim.as(this.sim.applying(a, c)).approve(id);
    return id;
  }

  /** `by` sets the run's secret, carrying `earlier`, then writes every copy. */
  async carried(run: SecretRun, id: Uint8Array, secret: string, earlier: Uint8Array, by: typeof A): Promise<void> {
    this.sim.as(this.sim.applying(by, this.changeOf(run)));
    this.priv = { ...this.priv, secret: fromHex(secret) };
    const asRun = {
      proposal: id, runVault: this.self, root: fromHex(run.root), payees: run.payees, opensAt: OPENS, closesAt: CLOSES,
      required: 0n, salt: fromHex(run.salt), nonce: fromHex(run.nonce), asset: fromHex(run.asset), path: run.path,
    };
    await this.call('setNonceSecret', asRun, fromHex(run.previous), fromHex(run.commitment), fromHex(run.copiesRoot), run.count,
      run.edge, fromHex(secret), earlier);
    for (const copy of run.copies) {
      await this.call('writeSecretCopy', fromHex(run.commitment), fromHex(copy.reader), copy.parts.map((p) => fromHex(p)), copy.path);
    }
  }

  standing(run: SecretRun, earlier?: readonly string[]) {
    return startStandingOf(circuits, {
      vault: toHex(this.self) as Hex, account: this.sim.ledger as never, vaultLedger: this.ledger as never, run, now: BigInt(NOW),
      ...(earlier === undefined ? {} : { earlier }),
    }).secret!;
  }
}

/** Ada's record of a run, sealed under the company's key as her device files it: a stand-in filing, its identity the run's. */
const recordOf = (run: SecretRun, id: Uint8Array): SealedProposal => {
  const f = signProposalFiling('acc_1', {
    id: 'prp_secretRun', digest: toHex(P.runPayload(fromHex(run.root), run.payees, OPENS, CLOSES, 0n)) as Hex, chainId: toHex(id) as Hex,
    keyEpoch: 0, createdAt: new Date(NOW * 1000).toISOString(),
    sealed: sealVaultSecretProposal({
      accountId: 'acc_1', viewingKey: VIEWING, summary: 'Replace the vault\'s secret',
      run: {
        vault: run.vault, root: run.root, payees: String(run.payees), opensAt: String(OPENS), closesAt: String(CLOSES),
        ...(/^0*$/u.test(run.previous) ? {} : { previous: run.previous }),
        copies: run.copies.map((c) => ({ reader: c.reader as Hex, parts: c.parts as Hex[] })),
      },
      change: { asset: run.asset, amount: 0n, batchDigest: '00'.repeat(32) as Hex, salt: run.salt }, proposedBy: 'ada',
    }),
  }, '11'.repeat(32) as Hex);
  return { ...f, accountId: 'acc_1', status: 'open', approvalCount: 0 };
};

/** A signer's device as the run's record is opened on it: its company key, and the company's records of the vault's secret. */
const deviceOf = (n: number, filed: ReturnType<typeof startNonceSecret>, vault: string): CreateVaultDoors => {
  const store = new MemorySealedPoolStore();
  void store.put(vault, filed);
  return { me: { signerId: `s${n}`, wrappingSecret: new Uint8Array(32), companyKey: companyKeyOf(n) }, records: () => store } as unknown as CreateVaultDoors;
};

describe('A VAULT\'S SECRET IS REPLACED BY A SIGNER WHO DID NOT RAISE THE RUN', () => {
  it('Bo opens the new secret from his own copy in Ada\'s record, carries the earlier secret, sets it, and every copy is written', async () => {
    const w = await World.make();
    const vault = toHex(w.self);
    /* The first secret, as the company's records hold it for all three, set and every copy written. */
    const filed = startNonceSecret(vault, READERS.map((publicKey) => ({ publicKey })));
    const first = openNonceSecrets(filed, vault, readerOf(1)).secrets[0]!;
    const run1 = secretRunOf(circuits, { vault: vault as Hex, secret: first as Hex, readers: READERS });
    await w.carried(run1, await w.raised(run1, [A, B]), first, ZERO, A);
    expect(toHex(w.ledger.secretCopies.lookup(V.copiesWrittenKey()))).toBe(run1.commitment);

    /* Ada makes the new secret on her device and raises its run over the commitment the vault holds now. */
    const next = `${'5a'.repeat(31)}00`;
    const run2 = secretRunOf(circuits, { vault: vault as Hex, secret: next as Hex, readers: READERS, previous: toHex(w.ledger.nonceCommitment) });
    expect(run2.previous).toBe(run1.commitment);
    const id = await w.raised(run2, [A, B]);

    /* Bo opens the run from Ada's record: his own copy gives the secret; nothing in the record opens for anyone else. */
    const opened = startRecordOpened(VIEWING, recordOf(run2, id))!;
    const bo = await runSecretOfTheRecord(deviceOf(2, filed, vault), vault as Hex, opened);
    if (bo === null) throw new Error('RED WHEN: the approver cannot open his own copy of the run\'s secret');
    expect(bo.secret).toBe(next);
    expect(bo.previous).toBe(run1.commitment);
    /* RED WHEN: the approver's run is made from anything but its own copy, the readers and the commitment the record names. */
    expect(secretRunOf(circuits, { vault: vault as Hex, secret: bo.secret, readers: bo.readers, previous: bo.previous })).toEqual(run2);

    /* The secret the vault last had every copy written for, found among the secrets Bo's records hold. */
    const s = w.standing(run2, bo.earlier);
    expect(s.earlier).toEqual({ secret: first });
    expect(s.another).toBe(false);
    expect(s.landed).toEqual([toHex(id)]);
    expect(s.run?.beforeARemoval).toBe(false);

    /* RED WHEN: the replacement is built with zero as the earlier secret, as the first secret is: the vault refuses it. */
    await expect(w.carried(run2, id, bo.secret, ZERO, B)).rejects.toThrow(/does not carry the last secret this vault took money under/);
    await w.carried(run2, id, bo.secret, fromHex((s.earlier as { secret: string }).secret), B);
    expect(toHex(w.ledger.nonceCommitment)).toBe(run2.commitment);
    /* RED WHEN: a copy is left unwritten, so the vault stays paused: the last copy marks the new secret written. */
    expect(toHex(w.ledger.secretCopies.lookup(V.copiesWrittenKey()))).toBe(run2.commitment);
    expect(w.ledger.secretCopies.member(V.earlierSecretKeyOf(fromHex(run2.commitment)))).toBe(true);
    const after = w.standing(run2, bo.earlier);
    expect(after.set && after.started).toBe(true);
  });

  it('once the new secret is set and before the company\'s records hold it, Bo pays a person from the vault under it, read from his own copy on the chain', async () => {
    const w = await World.make();
    const vault = toHex(w.self);
    const filed = startNonceSecret(vault, READERS.map((publicKey) => ({ publicKey })));
    const first = openNonceSecrets(filed, vault, readerOf(1)).secrets[0]!;
    const run1 = secretRunOf(circuits, { vault: vault as Hex, secret: first as Hex, readers: READERS });
    await w.carried(run1, await w.raised(run1, [A, B]), first, ZERO, A);
    const next = `${'5a'.repeat(31)}00`;
    const run2 = secretRunOf(circuits, { vault: vault as Hex, secret: next as Hex, readers: READERS, previous: run1.commitment });
    await w.carried(run2, await w.raised(run2, [A, B]), next, fromHex(first), B);
    expect(toHex(w.ledger.secretCopies.lookup(V.copiesWrittenKey()))).toBe(run2.commitment);

    /* A note arrives under the new secret; the company's records on Bo's device still hold only the first. */
    const coin = { nonce: new Uint8Array(32).fill(0x77), color: TEST_TOKEN_BYTES, value: 1_000n };
    w.priv = { ...w.priv, coin: { ...coin, mt_index: 0n } };
    await w.call('deposit', coin);
    /* Bo's device, its checks the vault's own over the ledger as the chain holds it now. */
    const bo = {
      ...deviceOf(2, filed, vault),
      builder: {
        secretIsTheVaults: async (i: { secret: string }) => toHex(V.secretCommitmentOf(w.self, fromHex(i.secret))) === toHex(w.ledger.nonceCommitment),
        ownChainCopy: async (i: { reader: string; of: 'commitment' | 'copies-written' }) => {
          const found = readersCopyOnTheChain(w.ledger as never, V as never, (c) => BigInt(degradeToTransient(c)), { reader: i.reader as Hex, of: i.of });
          return { commitment: found.commitment, parts: found.parts === null ? null : found.parts.map((p) => toHex(p)) };
        },
      },
    };
    const secret = await theSecretToSpend(bo as never, vault as Hex, 'the vault as Bo read it');
    /* RED WHEN: a payment takes the records' newest secret, or none, while the chain holds the new one. */
    expect(secret).toBe(next);

    /* A run paying Alice 250 from the vault, raised and approved at the bar; Bo pays it under the secret he read. */
    const alice = new Uint8Array(32).fill(0x0a);
    const blinding = new Uint8Array(32).fill(0x40);
    const tree = payoutTreeOf([{ details: toHex(V.payoutDetails(alice, TEST_TOKEN_BYTES, 250n, blinding)), nonce: 'c1'.repeat(32) }], [250n]);
    const pay: Change = { asset: TEST_TOKEN_BYTES, amount: 250n, batch: ZERO, salt: new Uint8Array(32).fill(0x31) };
    await w.sim.as(w.sim.applying(A, pay)).proposeRun({ root: fromHex(tree.root), payees: tree.payees, from: OPENS, until: CLOSES, vault: w.self });
    const payId = w.sim.proposalId(P.runPayload(fromHex(tree.root), tree.payees, OPENS, CLOSES, 0n), pay.salt, w.self);
    await w.sim.as(w.sim.applying(B, pay)).approve(payId);
    w.priv = { ...w.priv, secret: fromHex(secret) };
    await w.call('payout', vaultRunOf({ proposal: payId, vault: w.self, tree, i: 0, opensAt: OPENS, closesAt: CLOSES, salt: pay.salt, nonce: 'c1'.repeat(32) }),
      alice, TEST_TOKEN_BYTES, 250n, blinding, noFurtherNote());
    /* RED WHEN: the vault does not take the payment under the secret read from the chain. */
    expect(w.ledger.payments).toBe(1n);
  });

  it('a secret run raised before a signer is removed is read as raised before the removal, so no device approves or carries it', async () => {
    const w = await World.make();
    const vault = toHex(w.self);
    const filed = startNonceSecret(vault, READERS.map((publicKey) => ({ publicKey })));
    const first = openNonceSecrets(filed, vault, readerOf(1)).secrets[0]!;
    const run1 = secretRunOf(circuits, { vault: vault as Hex, secret: first as Hex, readers: READERS });
    await w.carried(run1, await w.raised(run1, [A, B]), first, ZERO, A);

    const run2 = secretRunOf(circuits, { vault: vault as Hex, secret: `${'6b'.repeat(31)}00` as Hex, readers: READERS, previous: run1.commitment });
    await w.raised(run2, [A]);
    expect(w.standing(run2).run?.beforeARemoval).toBe(false);
    /* Carol is removed after the run was raised: Ada raises it, Bo approves, Ada carries it. */
    const out: Change = { asset: ZERO, amount: 0n, batch: ZERO, salt: new Uint8Array(32).fill(0x77) };
    await w.sim.as(w.sim.applying(A, out)).propose(removalPayloadFor(w.sim.leafOf(C)));
    const outId = w.sim.proposalId(removalPayloadFor(w.sim.leafOf(C)), out.salt);
    await w.sim.as(w.sim.applying(B, out)).approve(outId);
    await w.sim.as(w.sim.applying(A, out)).removeSigner(w.sim.leafOf(C), outId);
    /* RED WHEN: the standing stops comparing the removals the account counts now with those it held at the raise. */
    expect(w.standing(run2).run?.beforeARemoval).toBe(true);
  });
});
