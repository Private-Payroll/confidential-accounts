import { beforeEach, describe, expect, it, vi } from 'vitest';

/* The registry the removal's hook is read from reads the page's address when it loads. */
vi.hoisted(() => { Object.assign(globalThis, { window: { location: { hostname: 'localhost', origin: 'http://localhost', protocol: 'http:', href: 'http://localhost/' }, addEventListener: () => {}, removeEventListener: () => {} } }); });
import { signingPublicKeyOf, toHex, type Hex } from '../../../../src/core/crypto.js';
import { MemorySealedPoolStore, type SealedPool } from '../../../../src/midnight/vault-pool.js';
import { newNonceSecret, openNonceSecrets, recordsKeypairFrom, startNonceSecret } from '../../../../src/midnight/company-nonce-secret.js';
import { sealSecretCopy } from '../../../../src/midnight/sealed-secret-copy.js';
import type { WireRecord } from '../../../../src/midnight/sealed-record-wire.js';
import type { RunKept } from '../../../../packages/web-shared/src/vault-doors.js';
import { recordsReaderOf } from '../../../../packages/web-shared/src/deposit-on-device.js';
import type { StepContext } from './definition.js';

/*
 * **THE WALLET'S CHANGE OF A VAULT'S SECRET, RUN FOR REAL: NEVER ON THE WALLET OF THE SEAT THAT LEFT, AND FINISHED BY THE
 * UPKEEP WITHOUT RAISING OR APPROVING.** The rotation and the removal's waits run as built; only the chain's steps a
 * secret run takes (raise, approve, set, write a copy) and the vault's reads stand in, over one stand-in chain, as in
 * packages/web-shared/src/a-vaults-secret-is-changed-after-a-removal.test.ts, where each is followed against the
 * contracts. The removal's hook is the wallet's own; the upkeep's finish is the call the upkeep makes, with `finish`.
 */

const chain = vi.hoisted(() => ({
  commitment: '', written: '', secret: '', copiesTo: [] as string[], removals: 0, stayers: [] as string[],
  approvals: 1, needed: 1, pending: null as null | { secret: string; readers: string[]; previous: string },
  raised: [] as string[], set: 0, copies: 0, doors: null as unknown, admitted: null as null | Set<string>,
  /** The account's removal count when the run that set each commitment was raised. */
  setAt: new Map<string, number>(),
}));
const commitmentOf = vi.hoisted(() => (secret: string) => `c${secret.split('').reverse().join('').slice(1)}`);
const runOnChain = vi.hoisted(() => () => ({
  proposal: 'p1', open: true, inWindow: true, beforeARemoval: false, approvals: chain.approvals, needed: chain.needed, approvedHere: true,
}));
const treeOf = vi.hoisted(() => (vault: string, secret: string, readers: readonly string[], previous: string, seal: (v: string, s: string, r: string) => string[]) => ({
  vault, commitment: commitmentOf(secret), previous, copies: readers.map((reader) => ({ reader, parts: seal(vault, secret, reader), path: [] })),
}));
const seal = (vault: string, secret: string, reader: string) => sealSecretCopy({ vault: vault as Hex, secret: secret as Hex, reader: reader as Hex }).map((p) => toHex(p));

vi.mock('../../../../packages/web-shared/src/vault-read-here.js', async (orig) => ({
  ...(await orig<object>()),
  theVaultReadForItsStart: async () => ({ view: { onChain: true, state: 'S', nonceCommitment: chain.commitment }, refusal: null }),
}));
vi.mock('../../../../packages/web-shared/src/removals-on-the-chain.js', () => ({ removalsOnTheChainHere: async () => chain.removals }));
vi.mock('../../../../packages/web-shared/src/vault-secret-run-record.js', async (orig) => ({ ...(await orig<object>()), heldSecretsOf: async () => [] }));
vi.mock('../../../../packages/web-shared/src/vault-start-steps.js', async (orig) => ({
  ...(await orig<object>()),
  standingNow: async (_d: unknown, _v: unknown, run: { secret: string }) => ({
    run: { commitment: commitmentOf(run.secret) },
    standing: { secret: { rootIsThisRuns: true, run: chain.pending !== null && chain.pending.secret === run.secret ? runOnChain() : null } },
  }),
}));
vi.mock('../../../../packages/web-shared/src/vault-secret-run.js', async (orig) => ({
  ...(await orig<object>()),
  readersNow: async () => chain.stayers,
  raiseASecretRunHere: async (doors: { secretKeptHere: { keepRun(v: string, r: unknown): Promise<void> } }, vault: string, secret: string) => {
    chain.raised.push(secret);
    chain.setAt.set(commitmentOf(secret), chain.removals);
    chain.pending = { secret, readers: [...chain.stayers], previous: chain.commitment };
    await doors.secretKeptHere.keepRun(vault, treeOf(vault, secret, chain.stayers, chain.commitment, seal));
    return { at: { standing: { secret: { run: runOnChain() } } }, run: { ...chain.pending }, said: null };
  },
  secretRunApprovedHere: async (_d: unknown, _v: unknown, at: unknown) => { chain.approvals += 1; return at; },
  secretSetHere: async (_d: unknown, _v: unknown, at: object, run: { secret: string; readers: string[] }) => {
    chain.commitment = commitmentOf(run.secret); chain.secret = run.secret; chain.copiesTo = [...run.readers]; chain.set += 1;
    return { ...at, run: {} };
  },
  everyCopyWritten: async () => { chain.written = chain.commitment; chain.copies += 1; },
}));
vi.mock('./vault-doors-here.js', async (orig) => ({ ...(await orig<object>()), vaultDoorsFor: () => chain.doors }));
vi.mock('./upkeep.js', async (orig) => ({
  ...(await orig<object>()),
  rotationDoorsIn: async () => ({ leaving: async () => new Set<string>(), ...(chain.admitted === null ? {} : { admitted: async () => chain.admitted! }) }),
}));

const { afterARemoval } = await import('./registry.js');
const { vaultSecretsChangedHere, toldOf, stillOwed } = await import('./vault-secrets-changed-here.js');

const VAULT = 'ab'.repeat(32) as Hex;
const keyOf = (n: number) => new Uint8Array(32).fill(0x40 + n);
const ADA = keyOf(1); const BO = keyOf(2); const CAROL = keyOf(3);
const pk = (k: Uint8Array) => recordsKeypairFrom(k).publicKey.toLowerCase();
const SIGNING = '11'.repeat(32);
const MINE = signingPublicKeyOf(SIGNING as Hex).toLowerCase();
const SEAT = { ada: 'a1'.repeat(32), bo: 'a2'.repeat(32), carol: 'a3'.repeat(32), dan: 'a5'.repeat(32) };

const storesFor = () => {
  const s = new Map<WireRecord, MemorySealedPoolStore>();
  return (r: WireRecord) => s.get(r) ?? s.set(r, new MemorySealedPoolStore()).get(r)!;
};
/** A wallet's kept secrets and runs, in memory. */
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
/** This wallet's device: the vault's doors as the wallet builds them, keyed to the seat `as`, whose records key is `key`. */
const aDevice = (key: Uint8Array) => {
  const records = storesFor();
  const wallet = aWallet();
  chain.doors = {
    me: { signerId: 'me', wrappingSecret: '01'.repeat(32), companyKey: key }, records, secretKeptHere: wallet,
    material: { signingSecret: SIGNING },
    account: 'ac'.repeat(32),
    indexer: async () => ({ indexerUri: 'https://indexer.example', indexerWsUri: 'wss://indexer.example' }),
    builder: {
      secretSetAt: async (i: { commitment: string }) => chain.setAt.get(i.commitment) ?? 0,
      secretIsTheVaults: async (i: { secret: string }) => commitmentOf(i.secret) === chain.commitment,
      ownChainCopy: async (i: { reader: string; of: string }) => ({
        commitment: i.of === 'commitment' ? chain.commitment : chain.written,
        parts: chain.written === chain.commitment && chain.copiesTo.includes(i.reader.toLowerCase()) ? seal(VAULT, chain.secret, i.reader) : null,
      }),
    },
  };
  return { records, wallet };
};
/** The vault started: its first secret filed for Ada, Bo and Carol and set on the chain with every copy written. */
const started = (records: ReturnType<typeof storesFor>) => {
  const first = startNonceSecret(VAULT, [ADA, BO, CAROL].map((k) => recordsReaderOf(k)), 0);
  void records('nonce-secret').put(VAULT, first);
  const s1 = openNonceSecrets(first, VAULT, recordsKeypairFrom(ADA)).secrets[0]!;
  Object.assign(chain, { commitment: commitmentOf(s1), written: commitmentOf(s1), secret: s1, copiesTo: [ADA, BO, CAROL].map(pk) });
  return s1;
};
const newest = async (records: ReturnType<typeof storesFor>, who: Uint8Array) =>
  openNonceSecrets((await records('nonce-secret').get(VAULT))!, VAULT, recordsKeypairFrom(who));

/** The company as this wallet reads it: this device's seat is `mine` in the directory, with `entered`; the chain holds `held`. */
const companyParts = (mine: { seat: string; retired?: number }, held: readonly string[], entered: readonly string[] = held.filter((s) => s !== mine.seat)) => ({
  accountId: 'acc_1', label: 'L', account: 'c0'.repeat(32), companyKeys: {}, roster: async () => null,
  holders: async () => ({ seats: held, adoptedVaults: [VAULT], approvals: 1, seatBar: 1 }),
  judges: {
    directoryHereFor: () => async () => ({
      dir: {
        seats: [{ seat: mine.seat, signingKey: MINE, wrappingKey: '00'.repeat(32), role: 'admin', retired: mine.retired ?? null, retiredAt: mine.retired },
          ...entered.map((seat) => ({ seat, signingKey: `k${seat}`, wrappingKey: '00'.repeat(32), role: 'admin', retired: null }))],
        rotations: [],
      },
      holders: { seats: held, approvals: 1, seatBar: 1 }, records: { directory: new Set<number>() },
    }),
  },
});
const companyRead = (...a: Parameters<typeof companyParts>): never => companyParts(...a) as never;
const ctx = { person: 'usr_a', tell: () => {} } as unknown as StepContext;
const removed = (leaf: string) => ({ leaf, round: { id: 'prp_1', chainId: 'dd'.repeat(32) } }) as never;
const hook = afterARemoval({ secrets: () => ({}) as never, pause: async () => {}, indexerHttp: 'https://indexer.example' }).afterCarried!;

beforeEach(() => {
  Object.assign(chain, { removals: 1, stayers: [pk(ADA), pk(BO)], approvals: 1, needed: 1, pending: null, raised: [], set: 0, copies: 0, admitted: null, setAt: new Map() });
});

describe('THE REMOVAL\'S HOOK, RUN FOR REAL, CHANGES THE VAULT SECRET ONLY ON A WALLET WHOSE SEAT STAYS', () => {
  it('the wallet of the seat that left makes no secret, raises nothing and files nothing, whether or not its directory shows it retired yet', async () => {
    const { records, wallet } = aDevice(CAROL);
    started(records);
    const notYet = await hook(ctx, companyRead({ seat: SEAT.carol }, [SEAT.ada, SEAT.bo, SEAT.carol]), removed(SEAT.carol));
    const retired = await hook(ctx, companyRead({ seat: SEAT.carol, retired: 4 }, [SEAT.ada, SEAT.bo]), removed(SEAT.carol));
    /* RED WHEN: the wallet of the seat that left makes, keeps, raises or files a new secret it could then open. */
    expect([chain.raised.length, wallet.kept.size, wallet.runs.size, (await records('nonce-secret').versions(VAULT)).length]).toEqual([0, 0, 0, 1]);
    expect([notYet, retired]).toEqual([0, 0].map(() => ({ vaultsRotated: 0, vaultsAwaiting: 0, vaultsOwed: 0, vaultsWaiting: 1, vaultsNotChanged: 0 })));
  });

  it('the wallet of a seat that stays leaves the vault on a new secret the seat that left cannot open', async () => {
    const { records } = aDevice(ADA);
    started(records);
    const told = await hook(ctx, companyRead({ seat: SEAT.ada }, [SEAT.ada, SEAT.bo]), removed(SEAT.carol));
    /* RED WHEN: the hook, run for real on a staying seat's wallet, stops short of the new secret. */
    expect(told).toEqual({ vaultsRotated: 1, vaultsAwaiting: 0, vaultsOwed: 0, vaultsWaiting: 0, vaultsNotChanged: 0 });
    await expect(newest(records, CAROL)).rejects.toThrow(/no copy is wrapped/);
  });

  it('a seat taken by address and admitted while the company key is owed its change holds every vault until its entry is filed and the key changed', async () => {
    const { records } = aDevice(ADA);
    started(records);
    chain.admitted = new Set([SEAT.dan]);
    const entry = (seat: string, retiredAt?: number) => ({ seat, signingKey: seat === SEAT.ada ? MINE : `k${seat}`, wrappingKey: '00'.repeat(32), role: 'admin', retired: retiredAt === undefined ? null : { at: retiredAt }, retiredAt });
    /* Carol's retirement is filed and anchored at version 3; the chain now holds Ada, Bo and Dan, whom the roster admitted by address. */
    const read = (danEntered: boolean, keyChanged: boolean) => ({
      ...companyParts({ seat: SEAT.ada }, [SEAT.ada, SEAT.bo, SEAT.dan]),
      judges: { directoryHereFor: () => async () => ({
        dir: { seats: [entry(SEAT.ada), entry(SEAT.bo), entry(SEAT.carol, 3), ...(danEntered ? [entry(SEAT.dan)] : [])], rotations: keyChanged ? [{ version: 4, by: SEAT.ada }] : [] },
        holders: { seats: [SEAT.ada, SEAT.bo, SEAT.dan], approvals: 1, seatBar: 1 }, records: { directory: new Set(keyChanged ? [3, 4] : [3]) },
      }) },
    }) as never;
    const press = async (r: never) => (await vaultSecretsChangedHere(ctx, r, {} as never, await rotation(), 'raise', { leaf: SEAT.carol }))[0]!;
    const rotation = async () => ({ leaving: async () => new Set<string>(), admitted: async () => chain.admitted! });
    /* RED WHEN: a new key or vault secret is made while the chain holds a seat the roster admitted and the directory has no entry for. */
    expect(await press(read(false, false))).toMatchObject({ state: 'waits', why: expect.stringMatching(/files its entry first/) });
    expect(await press(read(true, false))).toMatchObject({ state: 'waits', why: expect.stringMatching(/company's key is changed first/) });
    expect(chain.raised).toEqual([]);
    /* RED WHEN: the vault's secret is not changed once the admitted seat is entered and the company's key changed after the removal. */
    expect(await press(read(true, true))).toMatchObject({ state: 'rotated' });
  });
});

describe('THE UPKEEP FINISHES A VAULT SECRET\'S CHANGE THAT STOPPED PART WAY, AND NEVER RAISES OR APPROVES', () => {
  const finish = (r: never) => vaultSecretsChangedHere(ctx, r, {} as never, { leaving: async () => new Set<string>() }, 'finish');

  it('a change stopped after the new secret was set has its copies written and its record filed', async () => {
    const { records, wallet } = aDevice(ADA);
    const s1 = started(records);
    const s2 = newNonceSecret();
    await wallet.keepRun(VAULT, treeOf(VAULT, s2, [pk(ADA), pk(BO)], chain.commitment, seal) as never);
    /* The chain holds the new secret; no copy of it is written yet, so the vault is paused. */
    Object.assign(chain, { commitment: commitmentOf(s2), secret: s2, copiesTo: [pk(ADA), pk(BO)] });
    /* Its run was raised after Carol's removal. */
    chain.setAt.set(commitmentOf(s2), chain.removals);
    const changed = await finish(companyRead({ seat: SEAT.ada }, [SEAT.ada, SEAT.bo]));
    /* RED WHEN: the upkeep leaves the vault paused on unwritten copies, or raises a new run instead of finishing this one. */
    expect(changed.map((v) => v.did)).toEqual([['copies written', 'new secret filed']]);
    expect([chain.written === chain.commitment, chain.raised.length, chain.approvals]).toEqual([true, 0, 1]);
    expect((await newest(records, BO)).secrets).toEqual([s1, s2]);
    expect([toldOf(changed).vaultsRotated, stillOwed(changed)]).toEqual([1, false]);
  });

  it('a run this wallet raised and kept, approved since by another seat, is carried with no raise and no approval from here', async () => {
    const { records } = aDevice(ADA);
    started(records);
    chain.needed = 2;
    const read = companyRead({ seat: SEAT.ada }, [SEAT.ada, SEAT.bo]);
    const raised = await hook(ctx, read, removed(SEAT.carol));
    expect(raised).toEqual({ vaultsRotated: 0, vaultsAwaiting: 1, vaultsOwed: 0, vaultsWaiting: 0, vaultsNotChanged: 0 });
    /* Bo approves the run in his own wallet. */
    chain.approvals = 2;
    const changed = await finish(read);
    /* RED WHEN: the upkeep raises a run again, approves one, or leaves an approved run kept in the wallet uncarried. */
    expect(changed.map((v) => v.did)).toEqual([['new secret set', 'new secret filed']]);
    expect([chain.raised.length, chain.approvals, chain.set]).toEqual([1, 2, 1]);
    await expect(newest(records, CAROL)).rejects.toThrow(/no copy is wrapped/);
  });
});
