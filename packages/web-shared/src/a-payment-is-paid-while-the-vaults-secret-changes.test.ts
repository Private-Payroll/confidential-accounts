/**
 * **WHILE A VAULT'S SECRET CHANGES, ITS MONEY STILL MOVES.** Once the chain holds a new secret and before the company's
 * records do, a payment, a merge and the check of what overtook a payment take the secret the vault holds now from this
 * signer's own sealed copy on the chain; a carry finds the secret it must carry there too; and a record a wallet kept is
 * never filed over a newer one that carries more secrets.
 */
import { describe, expect, it } from 'vitest';
import { PaymentNotYetSeen, type VaultService, mergeNotesInCompanyVault, openCompanyVaultPool, payPrivatelyFromCompanyVault, settlePaymentInFlight } from './vault-operation.js';
import {
  VAULT, aPrivatePaymentOut, anUnsetNewerSecret, eventsOfAPayment, filedAlready, indexerOf, nothingToCheck, pacing, paymentEvents, readOnTheDevice,
  serviceFrom, startDoors, view, walletReadsTheVault,
} from './vault-operation.test-support.js';
import { heldSecretsOf } from './vault-secret-run-record.js';
import { PaymentJournalInStore } from '../../../src/midnight/vault-journal.js';
import { openNonceSecrets, recordsKeypairFrom, rotateNonceSecret, newNonceSecret, startNonceSecret } from '../../../src/midnight/company-nonce-secret.js';
import { recordsReaderOf } from './deposit-on-device.js';
import { sealSecretCopy } from '../../../src/midnight/sealed-secret-copy.js';
import { toHex, type Hex } from '../../../src/core/crypto.js';
import { vaultNoteCommitment } from '../../../src/midnight/note-index.js';

/** The secret the chain holds once the change has landed, which the company's records do not hold yet. */
const NEW_SECRET = '5e'.repeat(32);
const NOW_COMMITMENT = 'c1'.repeat(32);
const EARLIER_COMMITMENT = 'c0'.repeat(32);

/**
 * This signer's own copy on the chain, as the vault's worker hands it back: under the commitment the vault holds now,
 * `secret` sealed to the asking signer's key (none when null); under the one whose copies were last all written,
 * `written`'s commitment and no copy.
 */
const copyOnTheChain = (secret: string | null, written = NOW_COMMITMENT) => async (i: { reader: string; of: 'commitment' | 'copies-written' }) =>
  i.of === 'commitment'
    ? { commitment: NOW_COMMITMENT, parts: secret === null ? null : sealSecretCopy({ vault: VAULT, secret, reader: i.reader }).map(toHex) }
    : { commitment: written, parts: null };

describe('A PAYMENT, A MERGE AND A CARRY WHILE THE VAULT\'S SECRET CHANGES', () => {
  const { wrapping, me, signers, TOKEN, PAID_IN, NOTE, order, setUp, landsWhenSent } = aPrivatePaymentOut();

  it('A PAYMENT IS PAID UNDER THE SECRET THE VAULT HOLDS NOW, FROM THIS SIGNER\'S OWN COPY ON THE CHAIN, WHILE THE RECORDS\' NEWEST IS THE ONE BEFORE IT', async () => {
    const t = await setUp();
    const b = t.doors(landsWhenSent());
    b.builder.secretIsTheVaults = async (i) => i.secret === NEW_SECRET;
    b.builder.ownChainCopy = copyOnTheChain(NEW_SECRET);
    let builtWith = '';
    const build = b.builder.payout;
    b.builder.payout = async (i) => { builtWith = i.secret; return build(i); };
    const done = await payPrivatelyFromCompanyVault(b, order());
    /* RED WHEN: the payment refuses, or builds under the records' newest secret, while the chain holds a newer one. */
    expect([builtWith, done.transactionHash]).toEqual([NEW_SECRET, PAID_IN]);
    /* RED WHEN: a payment files the vault's secret on its way: the records follow the chain only by the filing that adds it. */
    expect((await b.records('nonce-secret').get(VAULT))!.version).toBe(1);
  });

  it('A MERGE IS MADE UNDER THE SECRET THE VAULT HOLDS NOW, FROM THIS SIGNER\'S OWN COPY ON THE CHAIN', async () => {
    const A = { nonce: '02'.repeat(32), token: TOKEN, value: 120n, createdIn: '0e'.repeat(32) };
    const B = { nonce: '03'.repeat(32), token: TOKEN, value: 100n, createdIn: '0f'.repeat(32) };
    const merged = { nonce: 'e7'.repeat(32), token: TOKEN, value: 220n };
    const MERGED_IN = 'dc'.repeat(32);
    const t = await setUp([B, A], [`h${A.nonce.slice(1)}`, `h${B.nonce.slice(1)}`]);
    const lands: Partial<VaultService> = {
      merge: async () => {
        paymentEvents.set(MERGED_IN, [
          { transactionHash: MERGED_IN, details: { tag: 'zswapInput' } },
          { transactionHash: MERGED_IN, details: { tag: 'zswapOutput', commitment: await vaultNoteCommitment(merged as never, VAULT as never), contract: VAULT, mtIndex: '13' } },
        ]);
        return { txRef: 'm', transactionHash: MERGED_IN };
      },
    };
    const b = t.doors(lands);
    b.builder.secretIsTheVaults = async (i) => i.secret === NEW_SECRET;
    b.builder.ownChainCopy = copyOnTheChain(NEW_SECRET);
    let builtWith = '';
    const build = b.builder.mergeNotes;
    b.builder.mergeNotes = async (i) => { builtWith = i.secret; return build(i); };
    const wire = (n: typeof A) => ({ nonce: n.nonce, token: n.token, value: n.value.toString() });
    await mergeNotesInCompanyVault(b, { vault: VAULT as never, notes: [wire(A), wire(B)] });
    /* RED WHEN: a merge refuses, or is built under the records' newest secret, while the chain holds a newer one. */
    expect(builtWith).toBe(NEW_SECRET);
  });

  it('WITH NO SECRET THE VAULT HOLDS HERE, A PAYMENT IS REFUSED BEFORE ANYTHING IS WRITTEN DOWN, SAYING WHICH WAIT IT IS AND WHAT ENDS IT', async () => {
    const notFiled = /neither the company's records nor a copy on the chain sealed to your key[^]*Nothing was sent\. A signer whose copy is on the chain can pay now/u;
    /* The third: a copy on the chain sealed to this signer that opens to a secret the vault does not hold, which any raiser can seal. */
    const cases: Array<[string, string | null, RegExp]> = [
      [EARLIER_COMMITMENT, null, /sealed copies of it are still being written[^]*Nothing was sent\. Finishing the vault's secret change on any signer's device writes them/u],
      [NOW_COMMITMENT, null, notFiled],
      [NOW_COMMITMENT, 'ee'.repeat(32), notFiled],
    ];
    for (const [written, copied, says] of cases) {
      const t = await setUp();
      const b = t.doors(landsWhenSent());
      b.builder.secretIsTheVaults = async () => false;
      b.builder.ownChainCopy = copyOnTheChain(copied, written);
      const e = await payPrivatelyFromCompanyVault(b, order()).catch((x: Error) => x);
      /*
       * RED WHEN: the refusal does not say whether the copies are still being written or the records are behind, or what
       * ends it; or a copy on the chain is used without the vault's own check that it is the secret the vault holds.
       */
      expect((e as Error).message).toMatch(says);
      expect(await t.journal()).toEqual([]);
      expect(t.log.filter((l) => l.startsWith('build'))).toEqual([]);
    }
  });

  /**
   * A payment of this signer's whole note, sent and not yet seen, which another device's merge of that note overtook,
   * made under `madeUnder`; `records` changes the company's records before it is settled. Answers how it settles.
   */
  const overtakenUnder = async (madeUnder: () => Promise<string>, records: (r: Parameters<typeof anUnsetNewerSecret>[0]) => Promise<void> = async () => {}) => {
    const B = { nonce: '04'.repeat(32), token: TOKEN, value: 300n, createdIn: '0e'.repeat(32) };
    const merged = { nonce: 'e7'.repeat(32), token: TOKEN, value: 800n };
    const both = view({ heldByCommittee: true, started: true, notes: [`h${NOTE.nonce.slice(1)}`, `h${B.nonce.slice(1)}`] });
    const afterMerge = view({ heldByCommittee: true, started: true, notes: [`h${merged.nonce.slice(1)}`], state: 'AFTER' });
    const t = await setUp([NOTE, B], both.notes as string[]);
    const first = t.doors({ payout: async () => ({ txRef: 'o', transactionHash: null }) }, [both]);
    await expect(payPrivatelyFromCompanyVault(first, order({}, { amount: '500' }))).rejects.toBeInstanceOf(PaymentNotYetSeen);
    /* Another device merged this payment's note first, under the secret the vault holds now, which only the chain shows. */
    await new PaymentJournalInStore(first.records('payment-journal'), VAULT, { id: 'ada', wrappingSecret: wrapping.secret }, signers)
      .record(VAULT, { spent: { nonce: NOTE.nonce as never, token: TOKEN as never, value: 500n }, further: [{ nonce: B.nonce as never, token: TOKEN as never, value: 300n }], step: 'merge', amount: 0n, attemptedAt: 'm' });
    paymentEvents.set('e8'.repeat(32), await eventsOfAPayment('e8'.repeat(32), merged));
    await records(first.records as never);
    const secret = await madeUnder();
    const later = t.doors({}, [afterMerge]);
    return settlePaymentInFlight({
      ...later,
      builder: {
        ...later.builder,
        ownChainCopy: copyOnTheChain(NEW_SECRET),
        stepKept: async (i) => (i.secret === secret ? { nonce: merged.nonce, token: TOKEN, value: '800' } : null),
        commitments: async (i) => ({
          output: await vaultNoteCommitment({ nonce: i.coin.nonce, token: i.coin.token, value: BigInt(i.coin.value) } as never, VAULT as never),
          held: `h${i.coin.nonce.slice(1)}`,
        }),
      },
    }, VAULT);
  };

  it('A STEP MADE UNDER THE SECRET THE VAULT HOLDS NOW, BEFORE THE RECORDS HOLD IT, IS FOUND TO HAVE OVERTAKEN A PAYMENT', async () => {
    /* RED WHEN: a step is looked for only under the records' newest secret, so one made under the chain's newer one is missed. */
    expect(await overtakenUnder(async () => NEW_SECRET)).toEqual({ state: 'overtaken' });
  });

  it('A STEP MADE UNDER A SECRET ONLY AN EARLIER FILED VERSION HOLDS IS FOUND TO HAVE OVERTAKEN A PAYMENT, AFTER THE VAULT\'S SECRET HAS MOVED ON', async () => {
    let earlier = '';
    /* A newer version filed over it that does not carry it, and the chain's copy now under another secret. */
    const settled = await overtakenUnder(async () => earlier, async (records) => { earlier = await anUnsetNewerSecret(records, me.companyKey); });
    /* RED WHEN: a step is looked for under fewer secrets than a step is built with: the newest version's alone. */
    expect(settled).toEqual({ state: 'overtaken' });
  });
});

describe('A RECORD KEPT IN A WALLET, AND THE SECRET A CARRY MUST CARRY', () => {
  it('A RECORD KEPT IN A WALLET IS NEVER FILED OVER A NEWER ONE THAT CARRIES MORE SECRETS, EVEN WHILE THE CHAIN HOLDS THE KEPT ONE', async () => {
    const doors = await filedAlready();
    const kept = (await doors.records('nonce-secret').get(VAULT))!;
    const by = recordsKeypairFrom(doors.me.companyKey);
    await doors.records('nonce-secret').put(VAULT, rotateNonceSecret(kept, VAULT, by,
      { remaining: [recordsReaderOf(doors.me.companyKey)], leaving: [recordsReaderOf(new Uint8Array(32).fill(9))] }, newNonceSecret(), 0));
    const service = serviceFrom([view({ heldByCommittee: true, state: 'AAAA', nonceCommitment: '5c'.repeat(32), notes: [], everCreated: [] })], []);
    const wallet = { keep: async () => {}, held: async () => kept, drop: async () => {} };
    const s0 = (await heldSecretsOf(doors, VAULT))[0]!;
    const back = await openCompanyVaultPool({
      ...pacing, ...walletReadsTheVault, ...doors, service, indexer: indexerOf(service), builder: { vaultOnChain: readOnTheDevice }, secretKeptHere: wallet as never,
    }, VAULT, nothingToCheck, async (secret) => secret === s0);
    expect(back.secret).toBe(s0);
    /* RED WHEN: the kept record, one secret, is filed over the newer record's two: the secret change is undone in the records. */
    expect((await doors.records('nonce-secret').get(VAULT))!.version).toBe(2);
  });

  it('A RECORD KEPT IN A WALLET IS NEVER FILED OVER ONE OF AS MANY SECRETS WHOSE EARLIER SECRET IT LACKS, EVEN WHILE THE CHAIN HOLDS THE KEPT ONE', async () => {
    const doors = await filedAlready();
    const by = recordsKeypairFrom(doors.me.companyKey);
    const me = [recordsReaderOf(doors.me.companyKey)];
    const filed = (await doors.records('nonce-secret').get(VAULT))!;
    await doors.records('nonce-secret').put(VAULT, rotateNonceSecret(filed, VAULT, by, { remaining: me, leaving: [] }, newNonceSecret(), 0));
    const other = startNonceSecret(VAULT, me);
    const kept = rotateNonceSecret(other, VAULT, by, { remaining: me, leaving: [] }, newNonceSecret(), 0);
    const keptSecret = openNonceSecrets(kept, VAULT, by).secrets[1]!;
    const service = serviceFrom([view({ heldByCommittee: true, state: 'AAAA', nonceCommitment: '5c'.repeat(32), notes: [], everCreated: [] })], []);
    await openCompanyVaultPool({
      ...pacing, ...walletReadsTheVault, ...doors, service, indexer: indexerOf(service), builder: { vaultOnChain: readOnTheDevice },
      secretKeptHere: { keep: async () => {}, held: async () => kept, drop: async () => {} } as never,
    }, VAULT, nothingToCheck, async (secret) => secret === keptSecret);
    /* RED WHEN: the kept record is weighed by how many secrets it holds, not which: the filed record's earlier secret leaves the records. */
    expect((await doors.records('nonce-secret').get(VAULT))!.version).toBe(2);
  });

  it('A RECORD KEPT IN A WALLET IS FILED AGAIN ONLY WHILE EVERY READER IT IS WRAPPED TO STAYS', async () => {
    const doors = await filedAlready();
    const by = recordsKeypairFrom(doors.me.companyKey);
    const me = recordsReaderOf(doors.me.companyKey);
    const gone = recordsReaderOf(new Uint8Array(32).fill(9));
    const kept = rotateNonceSecret((await doors.records('nonce-secret').get(VAULT))!, VAULT, by, { remaining: [me, gone], leaving: [] }, newNonceSecret(), 0);
    const keptSecret = openNonceSecrets(kept, VAULT, by).secrets[1]!;
    const service = serviceFrom([view({ heldByCommittee: true, state: 'AAAA', nonceCommitment: '5c'.repeat(32), notes: [], everCreated: [] })], []);
    const open = (stayers: string[]) => openCompanyVaultPool({
      ...pacing, ...walletReadsTheVault, ...doors, service, indexer: indexerOf(service), builder: { vaultOnChain: readOnTheDevice },
      secretKeptHere: { keep: async () => {}, held: async () => kept, drop: async () => {} } as never,
    }, VAULT, nothingToCheck, async (secret) => secret === keptSecret, undefined, async () => stayers as Hex[]);
    await open([me.publicKey]);
    /* RED WHEN: a kept record wrapped to a signer who has left is filed, so they open the vault's new secret from the records. */
    expect((await doors.records('nonce-secret').get(VAULT))!.version).toBe(1);
    await open([me.publicKey, gone.publicKey]);
    expect((await doors.records('nonce-secret').get(VAULT))!.version, 'RED WHEN: a kept record whose readers all stay is not filed').toBe(2);
  });

  it('A NEW VAULT\'S FIRST SECRET IS FILED GOOD FOR THE ACCOUNT\'S COUNT OF REMOVALS, READ BEFORE ITS READERS ARE CHECKED', async () => {
    const doors = startDoors();
    const order: string[] = [];
    const service = serviceFrom([view({ heldByCommittee: true, state: 'AAAA', notes: [], everCreated: [] })], [], { keys: async () => ({ committee: [], why: null, readers: [] }) as never });
    await openCompanyVaultPool({
      ...pacing, ...walletReadsTheVault, ...doors, service, indexer: indexerOf(service), builder: { vaultOnChain: readOnTheDevice },
    }, VAULT, async () => { order.push('readers checked'); }, undefined, async () => { order.push('count read'); return 3; });
    /* RED WHEN: a new vault's record is good for no removal, so its deposits are refused in a company that ever removed a signer. */
    expect(openNonceSecrets((await doors.records('nonce-secret').get(VAULT))!, VAULT, recordsKeypairFrom(doors.me.companyKey)).removals).toBe(3);
    /* RED WHEN: the count is read after the readers, so a removal between the two reads is missed. */
    expect(order).toEqual(['count read', 'readers checked']);
  });

  it('A CARRY FINDS THE SECRET IT MUST CARRY IN THIS SIGNER\'S OWN COPY ON THE CHAIN WHEN THE COMPANY\'S RECORDS HOLD NONE, AND STOPS WHEN THEY CANNOT BE READ', async () => {
    const EARLIER = '4d'.repeat(32);
    const doors = await filedAlready();
    const filed = await heldSecretsOf(doors, VAULT);
    const service = serviceFrom([view({ heldByCommittee: true, state: 'AAAA', notes: [], everCreated: [] })], []);
    const unread = { ...doors, records: () => ({ get: async () => { throw new Error('the records route is down'); } }) as never };
    const none = { ...doors, records: () => ({ get: async () => null }) as never };
    const withCopy = (d: typeof doors) => ({
      ...pacing, ...walletReadsTheVault, ...d, service, indexer: indexerOf(service),
      builder: {
        vaultOnChain: readOnTheDevice,
        ownChainCopy: async (i: { reader: string; of: string }) => (i.of === 'copies-written'
          ? { commitment: EARLIER_COMMITMENT, parts: sealSecretCopy({ vault: VAULT, secret: EARLIER, reader: i.reader }).map(toHex) }
          : { commitment: NOW_COMMITMENT, parts: null }),
      },
    });
    /* RED WHEN: the secret a carry must carry is looked for only in the company's records. */
    expect(await heldSecretsOf(withCopy(doors) as never, VAULT)).toEqual([...filed, EARLIER]);
    expect(await heldSecretsOf(withCopy(none) as never, VAULT)).toEqual([EARLIER]);
    /* RED WHEN: a records read that fails is taken as the records holding no secret. */
    await expect(heldSecretsOf(withCopy(unread) as never, VAULT)).rejects.toThrow(/the records route is down/u);
  });
});
