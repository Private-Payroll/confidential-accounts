/**
 * A VAULT'S SECRET CHANGED AFTER A SIGNER IS REMOVED, FROM A SIGNER WHO STAYS.
 *
 * The rotation's own order is run for real: the one owed function, the new secret made and kept in the wallet with
 * every earlier secret, the record filed only once the chain holds the new secret and wrapped to its readers, the
 * count re-file, the copies written from the wallet's kept tree, and the deposit gate on the account's count. The
 * chain's steps a secret run takes (raise, approve, set, write a copy) stand in here over one stand-in chain: each is
 * proved against the real contracts in `contracts/test/a-vaults-secret-is-replaced-by-a-signer-who-did-not-raise-it.test.ts`.
 *
 * Every assertion names the change that turns it red.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toHex, type Hex } from '../../../src/core/crypto.js';
import { MemorySealedPoolStore, SealedNotePool, type SealedPool } from '../../../src/midnight/vault-pool.js';
import { newNonceSecret, openNonceSecrets, recordsKeypairFrom, startNonceSecret } from '../../../src/midnight/company-nonce-secret.js';
import { sealSecretCopy } from '../../../src/midnight/sealed-secret-copy.js';
import type { WireRecord } from '../../../src/midnight/sealed-record-wire.js';
import type { RunKept } from './vault-doors.js';
import { VaultSecretBeingChanged, depositCoinOnThisDevice, recordsReaderOf } from './deposit-on-device.js';

const chain = vi.hoisted(() => ({
  commitment: '', written: '', secret: '', copiesTo: [] as string[], removals: 0, stayers: [] as string[],
  approvals: 1, needed: 1, pending: null as null | { secret: string; readers: string[]; previous: string },
  waits: null as null | { state: string; why?: string }, raised: [] as string[], set: 0, copies: 0,
  beforeARemoval: false, approvedHere: true, counts: [] as number[], stayersAtRaise: null as null | string[], admittedFirst: [] as boolean[],
  /** The account's removal count when the run that set each commitment was raised. */
  setAt: new Map<string, number>(),
}));
/** The stand-in commitment to a secret: its own bytes turned round, never the secret itself. */
const commitmentOf = vi.hoisted(() => (secret: string) => `c${secret.split('').reverse().join('').slice(1)}`);

vi.mock('./company-key-here.js', async (orig) => ({
  ...(await orig<object>()),
  removalWaitsHere: async (_here: unknown, _seat: unknown, o: { readonly admittedFirst?: boolean }) => {
    chain.admittedFirst.push(o.admittedFirst === true);
    return chain.waits ?? { state: 'not-needed' };
  },
}));
vi.mock('./vault-read-here.js', async (orig) => ({
  ...(await orig<object>()),
  theVaultReadForItsStart: async () => ({ view: { onChain: true, state: 'S', nonceCommitment: chain.commitment }, refusal: null }),
}));
vi.mock('./removals-on-the-chain.js', () => ({ removalsOnTheChainHere: async () => chain.counts.shift() ?? chain.removals }));
vi.mock('./vault-secret-run-record.js', async (orig) => ({ ...(await orig<object>()), heldSecretsOf: async () => [] }));
vi.mock('./vault-start-steps.js', async (orig) => ({
  ...(await orig<object>()),
  standingNow: async (_d: unknown, _v: unknown, run: { secret: string }) => ({
    run: { commitment: commitmentOf(run.secret) },
    standing: { secret: { rootIsThisRuns: true, run: chain.pending !== null && chain.pending.secret === run.secret ? runOnChain() : null } },
  }),
}));
const runOnChain = vi.hoisted(() => () => ({
  proposal: 'p1', open: true, inWindow: true, beforeARemoval: chain.beforeARemoval, approvals: chain.approvals, needed: chain.needed, approvedHere: chain.approvedHere,
}));
vi.mock('./vault-secret-run.js', async (orig) => ({
  ...(await orig<object>()),
  readersNow: async () => chain.stayers,
  raiseASecretRunHere: async (doors: { secretKeptHere: { keepRun(v: string, r: unknown): Promise<void> } }, vault: string, secret: string) => {
    chain.raised.push(secret);
    chain.setAt.set(commitmentOf(secret), chain.removals);
    const readers = chain.stayersAtRaise ?? chain.stayers;
    chain.pending = { secret, readers: [...readers], previous: chain.commitment };
    await doors.secretKeptHere.keepRun(vault, treeOf(vault, secret, readers, chain.commitment));
    return { at: { standing: { secret: { run: runOnChain() } } }, run: { ...chain.pending }, said: null };
  },
  secretRunApprovedHere: async (_d: unknown, _v: unknown, at: unknown) => { chain.approvals += 1; chain.approvedHere = true; return at; },
  secretSetHere: async (_d: unknown, _v: unknown, at: object, run: { secret: string; readers: string[] }) => {
    chain.commitment = commitmentOf(run.secret); chain.secret = run.secret; chain.copiesTo = [...run.readers]; chain.set += 1;
    return { ...at, run: {} };
  },
  everyCopyWritten: async () => { chain.written = chain.commitment; chain.copies += 1; },
}));
const treeOf = vi.hoisted(() => (vault: string, secret: string, readers: readonly string[], previous: string) => ({
  vault, commitment: commitmentOf(secret), previous,
  copies: readers.map((reader) => ({ reader, parts: sealSecretCopy({ vault: vault as Hex, secret: secret as Hex, reader: reader as Hex }).map((p) => toHex(p)), path: [] })),
}));

const { vaultSecretsRotatedHere } = await import('./vault-secret-rotated-here.js');

const VAULT = 'ab'.repeat(32) as Hex;
const TOKEN = 'aa'.repeat(32) as Hex;
const keyOf = (n: number) => new Uint8Array(32).fill(0x40 + n);
const ADA = keyOf(1); const BO = keyOf(2); const CAROL = keyOf(3);
const pk = (k: Uint8Array) => recordsKeypairFrom(k).publicKey.toLowerCase();

/** A wallet's kept secrets and trees, in memory. */
const aWallet = () => {
  const kept = new Map<string, SealedPool>();
  const runs = new Map<string, RunKept[]>();
  return {
    kept, runs,
    keep: async (v: Hex, r: SealedPool) => { kept.set(v, r); },
    held: async (v: Hex) => kept.get(v) ?? null,
    drop: async (v: Hex) => { kept.delete(v); },
    keepRun: async (v: Hex, r: RunKept) => { runs.set(`${v}:${r.commitment}`, [...(runs.get(`${v}:${r.commitment}`) ?? []), r]); },
    runHeld: async (v: Hex, c: Hex) => runs.get(`${v}:${c}`)?.at(-1) ?? null,
    runsHeld: async (v: Hex, c: Hex) => runs.get(`${v}:${c}`) ?? [],
  };
};

/** Ada's device: her records, her wallet, and the chain as her worker reads it. */
const adasDevice = (records = storesFor()) => {
  const wallet = aWallet();
  const doors = {
    me: { signerId: 'ada', wrappingSecret: '01'.repeat(32), companyKey: ADA },
    records, secretKeptHere: wallet,
    material: { signingSecret: '11'.repeat(32) },
    directory: async () => ({ dir: { seats: [] } }),
    leaving: async () => new Set<string>(),
    account: 'ac'.repeat(32),
    indexer: async () => ({ indexerUri: 'https://indexer.example', indexerWsUri: 'wss://indexer.example' }),
    builder: {
      secretSetAt: async (i: { commitment: string }) => secretSetOf(i.commitment),
      secretIsTheVaults: async (i: { secret: string }) => commitmentOf(i.secret) === chain.commitment,
      ownChainCopy: async (i: { reader: string; of: string }) => ({
        commitment: i.of === 'commitment' ? chain.commitment : chain.written,
        parts: chain.written === chain.commitment && chain.copiesTo.includes(i.reader.toLowerCase())
          ? sealSecretCopy({ vault: VAULT, secret: chain.secret as Hex, reader: i.reader as Hex }).map((p) => toHex(p)) : null,
      }),
    },
  };
  return { doors: doors as never, wallet, records };
};

/** The stand-in chain's removal count before it set a secret: the count its run was raised at. */
const secretSetOf = (commitment: string) => chain.setAt.get(commitment) ?? 0;

const storesFor = () => {
  const s = new Map<WireRecord, MemorySealedPoolStore>();
  return (r: WireRecord) => s.get(r) ?? s.set(r, new MemorySealedPoolStore()).get(r)!;
};

/** A started vault: its first secret filed for Ada, Bo and Carol and set on the chain with every copy written. */
const started = (records: ReturnType<typeof storesFor>, readers = [ADA, BO, CAROL]) => {
  const first = startNonceSecret(VAULT, readers.map((k) => recordsReaderOf(k)), 0);
  void records('nonce-secret').put(VAULT, first);
  const s1 = openNonceSecrets(first, VAULT, recordsKeypairFrom(ADA)).secrets[0]!;
  Object.assign(chain, { commitment: commitmentOf(s1), written: commitmentOf(s1), secret: s1, copiesTo: readers.map(pk) });
  return s1;
};

const newest = async (records: ReturnType<typeof storesFor>, who: Uint8Array) =>
  openNonceSecrets((await records('nonce-secret').get(VAULT))!, VAULT, recordsKeypairFrom(who));

beforeEach(() => {
  Object.assign(chain, {
    removals: 0, stayers: [pk(ADA), pk(BO), pk(CAROL)], approvals: 1, needed: 1, pending: null, waits: null, raised: [], set: 0, copies: 0,
    beforeARemoval: false, approvedHere: true, counts: [], stayersAtRaise: null, setAt: new Map(), admittedFirst: [],
  });
});

describe('a vault\'s secret, changed after a signer is removed', () => {
  it('AT A BAR OF ONE, ONE PRESS LEAVES THE VAULT ON A NEW SECRET CAROL CANNOT OPEN, AND A SECOND PRESS DOES NOTHING NEW', async () => {
    const { doors, records, wallet } = adasDevice();
    const s1 = started(records);
    Object.assign(chain, { removals: 1, stayers: [pk(ADA), pk(BO)] });
    const [out] = await vaultSecretsRotatedHere(doors, [VAULT], 'raise', { leaf: 'cc'.repeat(32) });
    expect(out!.state, `RED WHEN: the rotation stops short (${JSON.stringify(out)})`).toBe('rotated');
    expect(out!.did, 'RED WHEN: the secret is filed before the chain holds it, or a step is skipped').toEqual(['new secret set', 'new secret filed']);
    expect(chain.copiesTo, 'RED WHEN: the new secret\'s copies are sealed to the signer who left').toEqual([pk(ADA), pk(BO)]);
    expect(chain.written, 'RED WHEN: the copies are left for later, so the vault stays paused').toBe(chain.commitment);
    const a = await newest(records, ADA);
    expect(a.secrets, 'RED WHEN: the record loses the secret earlier deposits were made under, or files one the chain does not hold')
      .toEqual([s1, chain.secret]);
    expect(a.removals, 'RED WHEN: the record is not good for the removal the new secret was made after').toBe(1);
    await expect(newest(records, CAROL), 'RED WHEN: the signer who left can open the new secret').rejects.toThrow(/no copy is wrapped/);
    expect(wallet.kept.size, 'RED WHEN: the kept secret stays in the wallet after it is filed').toBe(0);
    const again = await vaultSecretsRotatedHere(doors, [VAULT], 'raise');
    expect(again[0]!.state, 'RED WHEN: a second press raises or files again').toBe('not-owed');
    expect(chain.admittedFirst, 'RED WHEN: a vault\'s change does not wait for a seat admitted that has filed no entry, while no key change is owed').toEqual([true, true]);
    expect([chain.raised.length, chain.set, (await records('nonce-secret').versions(VAULT)).length]).toEqual([1, 1, 2]);
  });

  it('A DEPOSIT IS REFUSED AFTER THE REMOVAL AND MADE UNDER THE NEW SECRET AFTER THE ROTATION', async () => {
    const { doors, records } = adasDevice();
    started(records);
    Object.assign(chain, { removals: 1, stayers: [pk(ADA), pk(BO)] });
    const w = recordsKeypairFrom(ADA);
    const me = { signerId: 'ada', wrappingSecret: w.secret, companyKey: ADA };
    const signers = async () => [{ id: 'ada', wrappingPublicKey: w.publicKey }];
    await new SealedNotePool(records('pool'), { signerId: 'ada', wrappingSecret: me.wrappingSecret }, signers).create(VAULT, { notes: [] });
    const deposit = () => depositCoinOnThisDevice({
      vault: VAULT, money: { token: TOKEN, value: 5n }, me, signers, records,
      chain: { everCreated: new Set(), outputCommitmentOf: () => 'none', heldNow: () => false, removals: chain.removals,
        secretIsTheVaults: (s) => commitmentOf(s) === chain.commitment, secretSet: async () => secretSetOf(chain.commitment) },
    });
    await expect(deposit(), 'RED WHEN: a deposit is made under a secret the signer who left can open').rejects.toBeInstanceOf(VaultSecretBeingChanged);
    await vaultSecretsRotatedHere(doors, [VAULT], 'raise');
    const made = await deposit().catch((e: Error) => e);
    expect(made instanceof Error ? made.message : made.epoch, 'RED WHEN: no deposit can be made once the new secret is filed').toBe(2);
  });

  it('AT A BAR OF TWO, THE PRESS RAISES AND WAITS; THE KEPT SECRET CARRIES EVERY EARLIER ONE; THE UPKEEP NEVER RAISES OR APPROVES, AND CARRIES ONCE APPROVED', async () => {
    const { doors, records, wallet } = adasDevice();
    const s1 = started(records);
    Object.assign(chain, { removals: 1, stayers: [pk(ADA), pk(BO)], needed: 2 });
    const [first] = await vaultSecretsRotatedHere(doors, [VAULT], 'raise');
    expect(first, 'RED WHEN: a run short of its approvals is set').toMatchObject({ state: 'awaiting-approvals', approvals: 1, needed: 2 });
    Object.assign(chain, { approvals: 1, needed: 3 });
    const kept = openNonceSecrets(wallet.kept.get(VAULT)!, VAULT, recordsKeypairFrom(ADA));
    expect(kept.secrets.slice(0, 1), 'RED WHEN: the wallet\'s record of the new secret drops an earlier secret').toEqual([s1]);
    expect(kept.secrets[1], 'RED WHEN: the kept record is not of the secret raised').toBe(chain.raised[0]);
    await vaultSecretsRotatedHere(doors, [VAULT], 'raise');
    expect(chain.raised, 'RED WHEN: a press after the first, every reader of the run still staying, raises a different secret')
      .toEqual([chain.raised[0], chain.raised[0]]);
    const before = chain.approvals;
    const finish = await vaultSecretsRotatedHere(doors, [VAULT], 'finish');
    expect([finish[0]!.state, chain.raised.length, chain.approvals], 'RED WHEN: the upkeep raises or approves').toEqual(['awaiting-approvals', 2, before]);
    chain.approvals = 3;
    const done = await vaultSecretsRotatedHere(doors, [VAULT], 'finish');
    expect(done[0]!.did, 'RED WHEN: the upkeep does not carry a run this wallet made once it is approved').toEqual(['new secret set', 'new secret filed']);
    expect((await newest(records, BO)).secrets).toEqual([s1, chain.raised[0]]);
  });

  it('A SIGNER OFF THE LIST OF READERS OWES NOTHING UNTIL THE CHAIN COUNTS A REMOVAL; THEN A RECORD THEY CAN OPEN OWES A NEW SECRET, WHATEVER ITS COUNT SAYS', async () => {
    const { doors, records } = adasDevice();
    started(records);
    chain.stayers = [pk(ADA), pk(BO)];
    const [before] = await vaultSecretsRotatedHere(doors, [VAULT], 'raise');
    expect([before!.state, chain.raised.length], 'RED WHEN: a new secret is raised with no removal on the chain since the secret was set').toEqual(['not-owed', 0]);
    chain.removals = 1;
    const [out] = await vaultSecretsRotatedHere(doors, [VAULT], 'raise');
    expect([out!.state, chain.raised.length], 'RED WHEN: a secret a signer off the list of readers can open is kept').toEqual(['rotated', 1]);
    await expect(newest(records, CAROL)).rejects.toThrow(/no copy is wrapped/);
  });

  it('WITH NOTHING KEPT TO CARRY, THE UPKEEP SAYS A NEW SECRET IS OWED AND RAISES NOTHING', async () => {
    const { doors, records } = adasDevice();
    started(records);
    Object.assign(chain, { removals: 1, stayers: [pk(ADA), pk(BO)] });
    const [out] = await vaultSecretsRotatedHere(doors, [VAULT], 'finish');
    expect(out, 'RED WHEN: the upkeep raises a run, or says nothing is owed').toMatchObject({ state: 'owed' });
    expect(chain.raised).toEqual([]);
  });

  it('COPIES OF A SET SECRET ARE WRITTEN FROM THE WALLET\'S KEPT TREE WHEN EVERY READER STAYS; A READER WHO LEFT MAKES A NEW RUN OWED', async () => {
    const { doors, records, wallet } = adasDevice();
    started(records);
    const s2 = newNonceSecret();
    const tree = treeOf(VAULT, s2, [pk(ADA), pk(BO), pk(CAROL)], chain.commitment);
    await wallet.keepRun(VAULT, tree as never);
    Object.assign(chain, { commitment: commitmentOf(s2), secret: s2, copiesTo: [pk(ADA), pk(BO), pk(CAROL)] });
    const [stays] = await vaultSecretsRotatedHere(doors, [VAULT], 'finish');
    expect(stays!.did, 'RED WHEN: copies are written only from the record the service serves').toEqual(['copies written', 'new secret filed']);
    chain.written = '';
    Object.assign(chain, { removals: 1, stayers: [pk(ADA), pk(BO)], copies: 0 });
    const [left] = await vaultSecretsRotatedHere(doors, [VAULT], 'finish');
    expect([left!.state, chain.copies], 'RED WHEN: copies a signer who left can open are written after the removal').toEqual(['owed', 0]);
  });

  it('A REMOVAL OF A SIGNER WHO NEVER READ THE VAULT STILL OWES A NEW SECRET; A RECORD BEHIND A COUNT THE SECRET WAS SET AFTER IS A RE-FILE CARRYING IT', async () => {
    const { doors, records, wallet } = adasDevice();
    const s1 = started(records, [ADA, BO]);
    await wallet.keepRun(VAULT, treeOf(VAULT, s1, [pk(ADA), pk(BO)], '0'.repeat(64)) as never);
    Object.assign(chain, { removals: 1, stayers: [pk(ADA), pk(BO)] });
    const [removed] = await vaultSecretsRotatedHere(doors, [VAULT], 'finish');
    expect([removed!.state, (await newest(records, ADA)).removals], 'RED WHEN: a secret set before a removal is kept on a record\'s word of who holds it')
      .toEqual(['owed', 0]);
    const later = adasDevice();
    chain.setAt.set(commitmentOf(started(later.records, [ADA, BO])), 1);
    const [out] = await vaultSecretsRotatedHere(later.doors, [VAULT], 'finish');
    expect(out!.did, 'RED WHEN: the count is never carried, so deposits stay refused, or a new secret is raised for it').toEqual(['filed again for the removals counted']);
    expect([(await newest(later.records, ADA)).removals, chain.raised.length]).toEqual([1, 0]);
  });

  it('WAITS FOR THE COMPANY\'S KEY TO CHANGE FIRST, AND MAKES NOTHING ON THE SEAT THAT IS LEAVING', async () => {
    const { doors, records } = adasDevice();
    started(records);
    Object.assign(chain, { removals: 1, stayers: [pk(ADA), pk(BO)], waits: { state: 'ready' } });
    const [out] = await vaultSecretsRotatedHere(doors, [VAULT], 'raise');
    expect(out, 'RED WHEN: a new secret is made while the company\'s key the leaver holds is still the one sealing').toMatchObject({ state: 'waits' });
    chain.waits = { state: 'not-this-seat', why: 'this seat is the one leaving' };
    expect((await vaultSecretsRotatedHere(doors, [VAULT], 'raise'))[0], 'RED WHEN: the leaver\'s own wallet makes a secret').toMatchObject({ state: 'not-this-seat' });
    expect(chain.raised).toEqual([]);
  });

  it('A SECRET RAISED IN A RUN SEALED TO A SIGNER WHO IS THEN REMOVED IS NEVER RAISED AGAIN: A FRESH ONE IS MADE, AND NO RECORD CARRIES THE COUNT WHILE A READER HAS LEFT', async () => {
    const { doors, records } = adasDevice();
    started(records);
    Object.assign(chain, { removals: 1, stayers: [pk(ADA), pk(BO)], needed: 2 });
    expect((await vaultSecretsRotatedHere(doors, [VAULT], 'raise'))[0]!.state).toBe('awaiting-approvals');
    const s2 = chain.raised[0]!;
    /* Bo is removed before the run is carried; it closes. */
    Object.assign(chain, { removals: 2, stayers: [pk(ADA)], needed: 1, approvals: 1, pending: null });
    const [second] = await vaultSecretsRotatedHere(doors, [VAULT], 'raise');
    expect(second!.state, JSON.stringify(second)).toBe('rotated');
    expect(chain.raised[1], 'RED WHEN: the secret Bo was given in the first run is raised again after his removal').not.toBe(s2);
    const filed = await newest(records, ADA);
    expect(filed.secrets.at(-1), 'RED WHEN: the vault ends on a secret Bo was given').toBe(chain.raised[1]);
    await expect(newest(records, BO), 'RED WHEN: Bo can open the record filed after his removal').rejects.toThrow(/no copy is wrapped/);
    expect(filed.removals, 'RED WHEN: the count is carried for a secret a signer who left opens').toBe(2);
  });

  it('A COUNT RE-FILE IS REFUSED WHEN A KEPT RUN OF THE SECRET NAMES A SIGNER WHO LEFT, THOUGH THE RECORD DOES NOT', async () => {
    const { doors, records, wallet } = adasDevice();
    const s1 = started(records, [ADA, BO]);
    await wallet.keepRun(VAULT, treeOf(VAULT, s1, [pk(ADA), pk(BO), pk(CAROL)], '0'.repeat(64)) as never);
    Object.assign(chain, { removals: 1, stayers: [pk(ADA), pk(BO)] });
    const [out] = await vaultSecretsRotatedHere(doors, [VAULT], 'finish');
    expect([out!.state, (await newest(records, ADA)).removals], 'RED WHEN: the count is carried for a secret Carol was sealed').toEqual(['owed', 0]);
  });

  it('A SECRET FILED FROM A RUN NAMING A SIGNER REMOVED AFTER THE CARRY KEEPS THE OLD COUNT, AND A NEW SECRET IS OWED', async () => {
    const { doors, records, wallet } = adasDevice();
    const s1 = started(records);
    const s2 = newNonceSecret();
    await wallet.keepRun(VAULT, treeOf(VAULT, s2, [pk(ADA), pk(BO), pk(CAROL)], chain.commitment) as never);
    Object.assign(chain, { commitment: commitmentOf(s2), written: commitmentOf(s2), secret: s2, copiesTo: [pk(ADA), pk(BO), pk(CAROL)] });
    Object.assign(chain, { removals: 1, stayers: [pk(ADA), pk(BO)] });
    const [out] = await vaultSecretsRotatedHere(doors, [VAULT], 'finish');
    const filed = await newest(records, ADA);
    expect(filed.secrets, 'RED WHEN: the secret the chain holds is not filed').toEqual([s1, s2]);
    expect(filed.removals, 'RED WHEN: a record Carol opens is filed good for her removal').toBe(0);
    expect(out!.state, 'RED WHEN: no new secret is owed for a secret Carol holds').toBe('owed');
  });

  it('WHO CAN OPEN A SECRET IS EVERY READER OF EVERY RUN OF IT THIS WALLET KEPT, NOT ONLY THE NEWEST RUN\'S', async () => {
    const { doors, records, wallet } = adasDevice();
    started(records);
    const s2 = newNonceSecret();
    await wallet.keepRun(VAULT, treeOf(VAULT, s2, [pk(ADA), pk(BO), pk(CAROL)], chain.commitment) as never);
    await wallet.keepRun(VAULT, treeOf(VAULT, s2, [pk(ADA), pk(BO)], chain.commitment) as never);
    Object.assign(chain, { commitment: commitmentOf(s2), written: commitmentOf(s2), secret: s2, copiesTo: [pk(ADA), pk(BO)] });
    Object.assign(chain, { removals: 1, stayers: [pk(ADA), pk(BO)] });
    const [out] = await vaultSecretsRotatedHere(doors, [VAULT], 'finish');
    expect([out!.state, (await newest(records, ADA)).removals], 'RED WHEN: an earlier run that sealed the secret to Carol is forgotten').toEqual(['owed', 0]);
  });

  it('A RUN RAISED BEFORE A REMOVAL IS NEVER CARRIED FROM HERE', async () => {
    const { doors, records } = adasDevice();
    started(records);
    Object.assign(chain, { removals: 1, stayers: [pk(ADA), pk(BO)], beforeARemoval: true });
    const [out] = await vaultSecretsRotatedHere(doors, [VAULT], 'raise');
    expect([out!.state, chain.set], 'RED WHEN: a run raised at a count below the chain\'s is carried').toEqual(['owed', 0]);
  });

  it('THE UPKEEP NEVER APPROVES A RUN THIS SEAT HAS NOT APPROVED; A PRESS DOES', async () => {
    const { doors, records } = adasDevice();
    started(records);
    Object.assign(chain, { removals: 1, stayers: [pk(ADA), pk(BO)], needed: 2, approvedHere: false });
    await vaultSecretsRotatedHere(doors, [VAULT], 'raise');
    expect(chain.approvals, 'RED WHEN: a press does not approve a run this seat has not approved').toBe(2);
    Object.assign(chain, { approvals: 1, approvedHere: false });
    const [out] = await vaultSecretsRotatedHere(doors, [VAULT], 'finish');
    expect([out!.state, chain.approvals], 'RED WHEN: the upkeep approves').toEqual(['awaiting-approvals', 1]);
  });

  it('THE WALLET\'S NEXT RECORD IS WRAPPED TO THE READERS THE RUN WAS RAISED WITH', async () => {
    const { doors, records, wallet } = adasDevice();
    started(records);
    Object.assign(chain, { removals: 1, stayers: [pk(ADA), pk(BO)], needed: 2, stayersAtRaise: [pk(ADA)] });
    await vaultSecretsRotatedHere(doors, [VAULT], 'raise');
    expect(() => openNonceSecrets(wallet.kept.get(VAULT)!, VAULT, recordsKeypairFrom(BO)),
      'RED WHEN: the kept record is wrapped to a signer the run left out').toThrow(/no copy is wrapped/);
  });

  it('STOPS WHEN THE COUNT MOVES WHILE WHO STAYS IS READ', async () => {
    const { doors, records } = adasDevice();
    started(records);
    Object.assign(chain, { removals: 1, stayers: [pk(ADA), pk(BO)], counts: [1, 2] });
    const [out] = await vaultSecretsRotatedHere(doors, [VAULT], 'raise');
    expect([out!.state, chain.raised.length], 'RED WHEN: a removal between the count and the readers is missed').toEqual(['not-rotated', 0]);
  });
});
