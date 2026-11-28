import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hex } from '../../../../src/core/crypto.js';
import type { StepContext } from './definition.js';

/* The registry the removal's hooks are read from reads the page's address when it loads. */
vi.hoisted(() => {
  Object.assign(globalThis, {
    window: {
      location: { hostname: 'localhost', origin: 'http://localhost', protocol: 'http:', href: 'http://localhost/' },
      addEventListener: () => {},
      removeEventListener: () => {}
    }
  });
});

/*
 * **A REMOVAL NEVER LEAVES A VAULT'S PRIVATE MONEY OPENABLE BY NO SIGNER WHO STAYS.** The judgement runs as built over
 * stand-in reads: the vaults the account holds and retired, what each holds privately, the records keys its newest
 * secret is sealed to, and the records keys of the signers the company's list holds.
 */
const t = vi.hoisted(() => ({
  notes: new Map<string, string[] | Error>(),
  sealedTo: new Map<string, string[]>(),
  /** The signing keys of the seats whose own removal is approved, as the wallet reads who is leaving, or the read's failure. */
  leaving: [] as string[] | Error,
  /** The vaults whose secret change is half written on the chain: a new secret set, not every copy of it written. */
  halfWritten: new Set<string>()
}));
vi.mock('./leaving-read-in-the-wallet.js', async (orig) => ({
  ...(await orig<object>()),
  leavingReadsOf: () => ({}),
  leavingBoundariesRead: async () => {
    if (t.leaving instanceof Error) throw t.leaving;
    return { boundaries: new Map(t.leaving.map((k) => [k, {}])), passedOver: null };
  }
}));
vi.mock('./vault-doors-here.js', async (orig) => ({
  ...(await orig<object>()),
  vaultDoorsFor: () => ({
    account: 'ac'.repeat(32),
    indexer: async () => ({ indexerUri: 'https://indexer.example', indexerWsUri: 'wss://indexer.example' }),
    builder: {
      vaultOnChain: async (i: { vault: string }) => {
        const notes = t.notes.get(i.vault) ?? [];
        if (notes instanceof Error) throw notes;
        const half = t.halfWritten.has(i.vault);
        return {
          onChain: true,
          state: 'S',
          notes,
          publicBalances: half ? [{ token: '01'.repeat(32), amount: '5' }] : [],
          notesFromThisBuild: true,
          everCreated: [],
          account: 'ac'.repeat(32),
          started: !half,
          nonceCommitment: 'ab'.repeat(32)
        };
      }
    },
    records: () => ({
      get: async (vault: string) => {
        const to = t.sealedTo.get(vault);
        return to === undefined ? null : { wrapped: to.map((signerId) => ({ signerId })) };
      }
    })
  })
}));

const { refuseAStrandedSecretHere, vaultLeftUnopenable } = await import('./vaults-a-removal-reaches.js');
const { retiredVaultsOnChain, secretChangeHalfWritten } = await import('./retired-vaults-here.js');
const { afterARemoval } = await import('./registry.js');
const { RemovalRefused } = await import('./remove-signer.js');

const ADOPTED = 'a1'.repeat(32) as Hex;
const RETIRED = 'b2'.repeat(32) as Hex;
const AGAIN = 'c3'.repeat(32) as Hex;
const LEAF = { ada: 'e1'.repeat(32), bo: 'e2'.repeat(32), carol: 'e3'.repeat(32) };
const KEY = { ada: 'f1'.repeat(32), bo: 'f2'.repeat(32), carol: 'f3'.repeat(32), boAgain: 'f4'.repeat(32) };
/** Each signer's signing key, which the wallet's reading of who is leaving names a leaving seat by. */
const SIGNS = { ada: 'a7'.repeat(32), bo: 'b7'.repeat(32), carol: 'c7'.repeat(32) };

/**
 * The company as this wallet reads it: the account holds ADOPTED and AGAIN and retired RETIRED and AGAIN; `signers` are on
 * its list, and the chain seats each of them unless `seated` says which.
 */
const company = (
  signers: Array<{ leaf: string; key?: string; signs?: string }>,
  seated: readonly string[] = signers.map((s) => s.leaf)
) =>
  ({
    account: 'ac'.repeat(32),
    chain: { indexer: { indexerUri: 'https://indexer.example', indexerWsUri: 'wss://indexer.example' } },
    holders: async () => ({ adoptedVaults: [ADOPTED, AGAIN], seats: [...seated] }),
    builder: {
      superAdmins: {
        reads: () => ({
          accountAt: async () => ({ authority: {}, vaults: { adopted: [ADOPTED, AGAIN], retired: [RETIRED, AGAIN] } })
        })
      }
    },
    roster: async () => ({
      signers: signers.map((s) => ({
        status: 'active',
        leafCommitment: s.leaf,
        signingPublicKey: s.signs,
        vaultKeys: s.key === undefined ? {} : { recordsKey: s.key }
      }))
    })
  }) as never;
const everyone = [
  { leaf: LEAF.ada, key: KEY.ada, signs: SIGNS.ada },
  { leaf: LEAF.bo, key: KEY.bo, signs: SIGNS.bo },
  { leaf: LEAF.carol, key: KEY.carol, signs: SIGNS.carol }
];
const ctx = {} as StepContext;
const refusalOf = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e
  );

beforeEach(() => {
  t.notes.clear();
  t.sealedTo.clear();
  t.leaving = [];
  t.halfWritten.clear();
  for (const v of [ADOPTED, RETIRED, AGAIN]) t.sealedTo.set(v, [KEY.ada, KEY.bo, KEY.carol]);
});

describe('THE VAULTS A REMOVAL REACHES', () => {
  it('the retired vaults are the ones the account lists retired and does not hold again', async () => {
    /* RED WHEN: a vault adopted again is counted twice, or a retired one is left out. */
    expect(await retiredVaultsOnChain(company(everyone))).toEqual([RETIRED]);
  });

  it('a secret change is half written while a secret is set and the vault is not started; a read that failed is never finished', () => {
    const read = (nonceCommitment: string | undefined, started: boolean) => ({
      onChain: true as const,
      state: 'S',
      notesFromThisBuild: true,
      everCreated: [],
      account: 'ac'.repeat(32),
      started,
      ...(nonceCommitment === undefined ? {} : { nonceCommitment })
    });
    /* RED WHEN: a vault whose new secret is set and not every copy written is taken as finished, so its public money waits for ever. */
    expect(secretChangeHalfWritten(read('ab'.repeat(32), false))).toBe(true);
    /* RED WHEN: a vault never started, or one on its secret with every copy written, is taken as owing copies. */
    expect([
      secretChangeHalfWritten(read('00'.repeat(32), false)),
      secretChangeHalfWritten(read('ab'.repeat(32), true))
    ]).toEqual([false, false]);
    /* RED WHEN: a read that failed, a vault the chain does not show, or a read with no commitment is taken as finished. */
    expect([null, { onChain: false as const }, read(undefined, false)].map(secretChangeHalfWritten)).toEqual([
      true,
      true,
      true
    ]);
  });

  it('a vault whose private side reads empty is never judged; one holding money, or not read, is', async () => {
    const judged = await vaultLeftUnopenable({
      vaults: [ADOPTED, RETIRED],
      atStake: async (v) => (v === RETIRED ? 'private-money' : null),
      readersOf: async () => [KEY.carol],
      staying: [KEY.ada],
      leaver: KEY.carol
    });
    /* RED WHEN: an empty vault refuses a removal it puts nothing at stake for, or a funded one stranded is passed. */
    expect(judged).toEqual({ vault: RETIRED, stake: 'private-money', why: 'no-reader' });
    expect(
      await vaultLeftUnopenable({
        vaults: [ADOPTED],
        atStake: async () => null,
        readersOf: async () => null,
        staying: [],
        leaver: null
      })
    ).toBeNull();
  });
});

describe("A REMOVAL THAT WOULD STRAND A VAULT'S PRIVATE MONEY IS REFUSED, NAMING THE VAULT", () => {
  it("passes while a signer who stays can open every funded vault's secret", async () => {
    t.notes.set(RETIRED, ['n1']);
    /* RED WHEN: a removal is refused though a signer who stays still opens the vault's secret. */
    expect(await refuseAStrandedSecretHere(ctx, company(everyone), {} as never, LEAF.carol as Hex)).toBeUndefined();
  });

  it("refuses the removal of the last signer a funded retired vault's secret is sealed to, by the keys the secret is sealed to", async () => {
    t.notes.set(RETIRED, ['n1']);
    t.sealedTo.set(RETIRED, [KEY.carol]);
    const e = await refusalOf(refuseAStrandedSecretHere(ctx, company(everyone), {} as never, LEAF.carol as Hex));
    /* RED WHEN: a removal leaves a retired vault's private money with a secret only the signer leaving can open. */
    expect(e).toBeInstanceOf(RemovalRefused);
    expect((e as Error).message).toMatch(
      new RegExp(`the vault ${RETIRED} openable by no signer who stays.*Nothing was sent\\.$`, 'u')
    );
    /* RED WHEN: the refusal says the secret is sealed only to signers who are leaving or have left, untrue when a seated signer merely has no records key here. */
    expect((e as Error).message).toMatch(
      /its secret is sealed to no signer who stays, so once this signer has left no one could change it or pay it out/u
    );
    expect((e as Error).message).not.toMatch(/leaving or have left/u);
    /*
     * RED WHEN: the refusal does not name the step that works once the removal is approved: it is withdrawn by the signer
     * who raised it, the signer leaving gives the others a copy in their next action, and it is raised again.
     */
    expect((e as Error).message).toMatch(
      /The signer who raised it withdraws it; the signer leaving then takes any action in the company, /u
    );
    expect((e as Error).message).toMatch(
      /their wallet gives a copy of the secret to each seat that lacks one; then the removal is raised again\./u
    );
    expect((e as Error).message).not.toMatch(/pay its private money out/u);
    /* An adopted vault is judged the same way. */
    t.notes.clear();
    t.notes.set(ADOPTED, ['n1']);
    t.sealedTo.set(ADOPTED, [KEY.carol]);
    expect(
      await refusalOf(refuseAStrandedSecretHere(ctx, company(everyone), {} as never, LEAF.carol as Hex))
    ).toBeInstanceOf(RemovalRefused);
  });

  it("a seat the company's list still names after the chain dropped it does not count as a signer who stays", async () => {
    t.notes.set(ADOPTED, ['n1']);
    t.sealedTo.set(ADOPTED, [KEY.bo, KEY.carol]);
    /* Bo is active on the list this wallet believes, and the chain holds only Ada and Carol. */
    const e = await refusalOf(
      refuseAStrandedSecretHere(ctx, company(everyone, [LEAF.ada, LEAF.carol]), {} as never, LEAF.carol as Hex)
    );
    /* RED WHEN: staying is read off the list alone, so Bo, whom the chain no longer seats, is counted as still opening the secret. */
    expect(e).toBeInstanceOf(RemovalRefused);
    expect(await refuseAStrandedSecretHere(ctx, company(everyone), {} as never, LEAF.carol as Hex)).toBeUndefined();
  });

  it('a seat taken again with a new key counts as a seat that left: the secret sealed to its old key strands', async () => {
    t.notes.set(ADOPTED, ['n1']);
    t.sealedTo.set(ADOPTED, [KEY.bo, KEY.carol]);
    const reseated = [
      { leaf: LEAF.ada, key: KEY.ada },
      { leaf: LEAF.bo, key: KEY.boAgain },
      { leaf: LEAF.carol, key: KEY.carol }
    ];
    /* RED WHEN: staying is judged by seats, not keys, so Bo's seat taken again with a new key is counted as still opening the secret. */
    expect(
      await refusalOf(refuseAStrandedSecretHere(ctx, company(reseated), {} as never, LEAF.carol as Hex))
    ).toBeInstanceOf(RemovalRefused);
  });

  it('a vault whose private side could not be read is judged as funded, and one whose secret record is missing refuses', async () => {
    t.notes.set(RETIRED, new Error('the indexer did not answer'));
    t.sealedTo.set(RETIRED, [KEY.carol]);
    /* RED WHEN: a vault whose notes could not be read is passed as empty, so its money may be stranded. */
    expect(
      await refusalOf(refuseAStrandedSecretHere(ctx, company(everyone), {} as never, LEAF.carol as Hex))
    ).toBeInstanceOf(RemovalRefused);
    t.sealedTo.delete(RETIRED);
    t.notes.set(RETIRED, ['n1']);
    const e = await refusalOf(refuseAStrandedSecretHere(ctx, company(everyone), {} as never, LEAF.carol as Hex));
    /* RED WHEN: a funded vault with no readable secret record is taken as safe to leave. */
    expect((e as Error).message).toMatch(/records hold no secret of it this wallet can read/u);
  });

  it("a secret the signer leaving cannot open either is not this removal's doing, and the removal is not refused for that vault", async () => {
    t.notes.set(RETIRED, ['n1']);
    t.sealedTo.set(RETIRED, [KEY.boAgain]);
    /* RED WHEN: a removal is refused, for good, over a vault whose secret no one seated opens before or after it, with a remedy that cannot work. */
    expect(await refuseAStrandedSecretHere(ctx, company(everyone), {} as never, LEAF.carol as Hex)).toBeUndefined();
  });

  it('a signer leaving whose records key is not known is judged as reading the secret', async () => {
    t.notes.set(RETIRED, ['n1']);
    t.sealedTo.set(RETIRED, [KEY.boAgain]);
    const keyless = [
      { leaf: LEAF.ada, key: KEY.ada, signs: SIGNS.ada },
      { leaf: LEAF.bo, key: KEY.bo, signs: SIGNS.bo },
      { leaf: LEAF.carol, signs: SIGNS.carol }
    ];
    /* RED WHEN: a leaver whose key this wallet does not know is taken as no reader, so a removal that may strand the vault is passed. */
    const e = await refusalOf(refuseAStrandedSecretHere(ctx, company(keyless), {} as never, LEAF.carol as Hex));
    expect((e as Error).message).toMatch(/openable by no signer who stays/u);
  });

  it("two removals approved together: each counts the other's seat as leaving, so the second carried out is refused", async () => {
    t.notes.set(ADOPTED, ['n1']);
    t.sealedTo.set(ADOPTED, [KEY.ada, KEY.bo]);
    t.leaving = [SIGNS.ada, SIGNS.bo.toUpperCase()];
    /* RED WHEN: a seat whose own removal is approved and not yet carried out counts as staying, so two removals at once strand the vault. */
    for (const leaf of [LEAF.ada, LEAF.bo]) {
      expect(
        await refusalOf(refuseAStrandedSecretHere(ctx, company(everyone), {} as never, leaf as Hex))
      ).toBeInstanceOf(RemovalRefused);
    }
    t.leaving = [SIGNS.ada];
    expect(await refuseAStrandedSecretHere(ctx, company(everyone), {} as never, LEAF.ada as Hex)).toBeUndefined();
  });

  it('a read of who is leaving that fails refuses the carrying out, never taken as nobody leaving', async () => {
    t.leaving = new Error('the seat bar of the company was not read');
    /* RED WHEN: who is leaving could not be read and the removal is carried out as if nobody else were leaving. */
    await expect(refuseAStrandedSecretHere(ctx, company(everyone), {} as never, LEAF.carol as Hex)).rejects.toThrow(
      /seat bar of the company was not read/u
    );
  });

  it('a vault holding only public money whose secret change is half written refuses the removal of its one reader', async () => {
    for (const v of [RETIRED, ADOPTED]) {
      t.halfWritten.clear();
      t.halfWritten.add(v);
      t.sealedTo.set(v, [KEY.carol]);
      const e = await refusalOf(refuseAStrandedSecretHere(ctx, company(everyone), {} as never, LEAF.carol as Hex));
      /*
       * RED WHEN: a vault with no notes whose new secret is set and not every copy written is passed, so once the one
       * signer who reads that secret has left no one could write the copies, and its public payouts wait for ever.
       */
      expect(e).toBeInstanceOf(RemovalRefused);
      /* RED WHEN: the refusal speaks of private money the vault does not hold, not of the copies its payouts wait on. */
      expect((e as Error).message).toMatch(
        new RegExp(`the vault ${v} paying nothing out: a change of its secret is not yet finished`, 'u')
      );
      expect((e as Error).message).toMatch(
        /its payouts wait until a signer who reads the new secret writes its copies/u
      );
      expect((e as Error).message).toMatch(/then the removal is raised again\. Nothing was sent\.$/u);
      t.sealedTo.set(v, [KEY.ada, KEY.bo, KEY.carol]);
    }
  });

  it('an adopted vault that holds nothing today but takes deposits refuses the removal of the one signer its secret is sealed to', async () => {
    t.sealedTo.set(ADOPTED, [KEY.carol]);
    const e = await refusalOf(refuseAStrandedSecretHere(ctx, company(everyone), {} as never, LEAF.carol as Hex));
    /*
     * RED WHEN: an adopted vault read empty is passed, though it still takes deposits, so private money put in after the
     * removal is openable by no one seated.
     */
    expect(e).toBeInstanceOf(RemovalRefused);
    expect((e as Error).message).toMatch(
      new RegExp(`the vault ${ADOPTED}, which takes deposits, with a secret sealed to no signer who stays`, 'u')
    );
    /* A retired vault read empty with its change finished takes no deposit, so it puts nothing at stake. */
    t.sealedTo.set(ADOPTED, [KEY.ada, KEY.bo, KEY.carol]);
    t.sealedTo.set(RETIRED, [KEY.carol]);
    expect(await refuseAStrandedSecretHere(ctx, company(everyone), {} as never, LEAF.carol as Hex)).toBeUndefined();
  });

  it('public money alone puts no secret at stake', async () => {
    t.sealedTo.set(RETIRED, [KEY.carol]);
    /* RED WHEN: a vault holding only public money, which needs no secret to pay out, refuses a removal. */
    expect(await refuseAStrandedSecretHere(ctx, company(everyone), {} as never, LEAF.carol as Hex)).toBeUndefined();
  });

  it('the wallet runs the judgement before every removal it carries out', () => {
    /* RED WHEN: the removal's reach carries no judgement, so the wallet carries a removal out unjudged. */
    expect(typeof afterARemoval({} as never).beforeCarried).toBe('function');
  });
});
