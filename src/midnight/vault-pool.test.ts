/**
 * THE POOL'S ENVELOPE. `C202`, `S6d`, `docs/scope-the-vault-system.md` §3.3.
 *
 * The pool is the money: which notes exist, what they are worth, which one to
 * spend. None of it is on chain and none of it is derivable. So the questions
 * this file has to answer are not about encryption working — `seal`, `unseal`,
 * `wrapKey` and `unwrapKey` are already proved in `core.test.ts` — they are
 * about **who can read it, who cannot, and what happens when nobody can.**
 *
 * The one that matters most is the last: **a pool that cannot be read must
 * never be answered as a pool with nothing in it.** Those are opposite claims
 * about a company's treasury and they are the same bytes from here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { newWrappingKeypair } from '../core/crypto.js';
import { redactHex } from '../testing/redact.js';
import type { VaultNotes } from './vault-notes.js';
import {
  sealPool, openPool, wrapFor, SealedNotePool, MemorySealedPoolStore, VaultPoolUnreadable,
  type PoolSigner,
} from './vault-pool.js';

const VAULT = 'ab'.repeat(32);

const signer = (id: string) => {
  const kp = newWrappingKeypair();
  return { who: { id, wrappingPublicKey: kp.publicKey } as PoolSigner, secret: kp.secret };
};

/**
 * Values are bigints on purpose. `M-125`: `canonical` writes one as `{"$n":"…"}`
 * and a plain `JSON.parse` hands it back as an object, which in arithmetic is
 * `NaN` or a concatenation rather than an error. A pool that opens and is wrong
 * is worse than one that refuses.
 */
const POOL: VaultNotes = {
  notes: [
    { nonce: '11'.repeat(32), token: '9b'.repeat(32), value: 1_000n, index: 4n },
    { nonce: '22'.repeat(32), token: '9b'.repeat(32), value: 400n, index: 9n },
  ],
};

describe('a vault pool wrapped per signer', () => {
  it('every signer opens the same pool with their own secret and no viewing key', () => {
    const a = signer('sgn_a'), b = signer('sgn_b');
    const rec = sealPool(VAULT, POOL, [a.who, b.who], 1);

    expect(openPool(rec, 'sgn_a', a.secret)).toEqual(POOL);
    expect(openPool(rec, 'sgn_b', b.secret)).toEqual(POOL);
    /* Bigints, not objects that look like them. */
    expect(openPool(rec, 'sgn_a', a.secret).notes[0].value).toBe(1_000n);
  });

  it('THE POOL NEVER TOUCHES THE ACCOUNT VIEWING KEY, and the source says so', () => {
    /*
     * **This is the decision the whole file exists for, and it is the one a
     * later round would undo without noticing.** A purpose key is derived from
     * the account viewing key, and the viewing key crosses the wire to our
     * server on the vault-threshold routes — so a pool sealed that way hands us
     * the vault's balance the first time a signer changes a threshold.
     *
     * A grep-style check rather than a behavioural one, because the failure is
     * somebody ADDING a parameter to make a signature tidier. There is no
     * behaviour to observe: a pool sealed under a purpose key opens perfectly
     * and reads identically from every side except the server's.
     */
    const source = readFileSync(new URL('./vault-pool.ts', import.meta.url), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/viewingKey/);
    expect(code).not.toMatch(/purposeKey|sealRecord|openRecord/);
    /* And the reasoning is kept where it will be read, not only here. */
    expect(source).toMatch(/crosses the wire to our\s*\*?\s*server/i);
  });

  it('a fresh key on every write, so no key outlives one version of the pool', () => {
    const a = signer('sgn_a');
    const one = sealPool(VAULT, POOL, [a.who], 1);
    const two = sealPool(VAULT, POOL, [a.who], 2);
    /* Same plaintext, different ciphertext and different wrapped keys. */
    expect(two.sealed.body).not.toBe(one.sealed.body);
    expect(two.wrapped[0].wrapped.body).not.toBe(one.wrapped[0].wrapped.body);
    expect(openPool(two, 'sgn_a', a.secret)).toEqual(POOL);
  });

  it('REFUSES to seal to nobody, rather than producing ciphertext with no key in the world', () => {
    expect(() => sealPool(VAULT, POOL, [], 1)).toThrow(/no signers/i);
  });

  it('a signer with no wrapped copy is told so, and is never handed an empty pool', () => {
    const a = signer('sgn_a'), late = signer('sgn_late');
    const rec = sealPool(VAULT, POOL, [a.who], 1);

    let caught: unknown;
    try { openPool(rec, 'sgn_late', late.secret); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(VaultPoolUnreadable);
    expect((caught as Error).message).toMatch(/sgn_late/);
    expect((caught as Error).message).toMatch(/not the same as the vault holding nothing/i);
  });

  it('a wrong secret is a refusal, not a pool', () => {
    const a = signer('sgn_a'), impostor = signer('sgn_a');
    const rec = sealPool(VAULT, POOL, [a.who], 1);
    expect(() => openPool(rec, 'sgn_a', impostor.secret)).toThrow(VaultPoolUnreadable);
  });

  it('adds a reader WITHOUT re-sealing the money', () => {
    /*
     * Adding a signer changes who can read, not what the vault holds. Re-sealing
     * would be a rewrite of the money for a reason that is not about the money —
     * and every rewrite is a chance to write half of it (`M-73`, `M-74`).
     */
    const a = signer('sgn_a'), c = signer('sgn_c');
    const rec = sealPool(VAULT, POOL, [a.who], 1);
    const wider = wrapFor(rec, { signerId: 'sgn_a', wrappingSecret: a.secret }, [c.who]);

    expect(wider.sealed).toEqual(rec.sealed);
    expect(wider.version).toBe(rec.version);
    expect(openPool(wider, 'sgn_c', c.secret)).toEqual(POOL);
    expect(openPool(wider, 'sgn_a', a.secret)).toEqual(POOL);
  });

  it('will not add a reader on the word of somebody who cannot read it themselves', () => {
    /*
     * The key exists only inside the wrapped copies, so a caller who holds none
     * has nothing to give away. **That is the mechanism working**: a server that
     * could add a reader without a signer present is a server that could add
     * itself.
     */
    const a = signer('sgn_a'), outsider = signer('sgn_x'), c = signer('sgn_c');
    const rec = sealPool(VAULT, POOL, [a.who], 1);
    expect(() => wrapFor(rec, { signerId: 'sgn_x', wrappingSecret: outsider.secret }, [c.who]))
      .toThrow(/holds no copy/i);
  });

  it('adding somebody twice does not give them two copies', () => {
    const a = signer('sgn_a'), c = signer('sgn_c');
    const rec = sealPool(VAULT, POOL, [a.who, c.who], 1);
    const again = wrapFor(rec, { signerId: 'sgn_a', wrappingSecret: a.secret }, [c.who]);
    expect(again.wrapped).toHaveLength(2);
  });

  it('a removed signer cannot open what is written AFTER they go — and keeps what they had',
    () => {
      /*
       * **STATED RATHER THAN ENGINEERED AROUND.** Removing a signer does not
       * un-tell them a pool they have already read, exactly as it does not
       * un-tell them their own key material. What it does is stop them reading
       * anything further, which is the only meaning revocation can have.
       *
       * And the residue is smaller than it sounds: a departed signer with a
       * stale pool can RECOGNISE the vault's notes, not spend them. Spending
       * needs an approved run, and that is the threshold's job.
       */
      const a = signer('sgn_a'), leaver = signer('sgn_b');
      const before = sealPool(VAULT, POOL, [a.who, leaver.who], 1);
      expect(openPool(before, 'sgn_b', leaver.secret)).toEqual(POOL);

      const moved: VaultNotes = { notes: [POOL.notes[0]] };
      const after = sealPool(VAULT, moved, [a.who], 2);

      expect(openPool(after, 'sgn_a', a.secret)).toEqual(moved);
      expect(() => openPool(after, 'sgn_b', leaver.secret)).toThrow(VaultPoolUnreadable);
      /* And what they already held still opens, which is the honest half. */
      expect(openPool(before, 'sgn_b', leaver.secret)).toEqual(POOL);
    });
});

describe('the pool VaultLedger actually uses', () => {
  const build = () => {
    const a = signer('sgn_a'), b = signer('sgn_b');
    const store = new MemorySealedPoolStore();
    const pool = new SealedNotePool(
      store, { signerId: 'sgn_a', wrappingSecret: a.secret },
      async () => [a.who, b.who]);
    return { a, b, store, pool };
  };

  it('AN ABSENT RECORD IS A REFUSAL, NOT AN EMPTY POOL', async () => {
    /*
     * `C197`'s rule on the pool rather than on a Zswap state. Answering
     * `{notes: []}` here would make `balance` report zero, `noteToSpend` say the
     * vault holds nothing, and a reconciliation call every note the chain holds
     * an unexplained one — for a vault whose money is perfectly fine.
     */
    const { pool } = build();
    await expect(pool.load(VAULT)).rejects.toThrow(VaultPoolUnreadable);
    await expect(pool.load(VAULT)).rejects.toThrow(/no pool for it at all/i);
  });

  it('will not advance a pool that was never created', async () => {
    const { pool } = build();
    await expect(pool.save(VAULT, POOL)).rejects.toThrow(/no pool to advance/i);
  });

  it('creates once, then round-trips through save', async () => {
    const { pool } = build();
    await pool.create(VAULT, POOL);
    expect(await pool.load(VAULT)).toEqual(POOL);

    const moved: VaultNotes = { notes: [POOL.notes[1]] };
    await pool.save(VAULT, moved);
    expect(await pool.load(VAULT)).toEqual(moved);

  });

  it('every save stays readable by the OTHER signer too', async () => {
    const { pool, store, b } = build();
    await pool.create(VAULT, POOL);
    const moved: VaultNotes = { notes: [POOL.notes[0]] };
    await pool.save(VAULT, moved);

    const rec = (await store.get(VAULT))!;
    expect(openPool(rec, 'sgn_b', b.secret)).toEqual(moved);
  });

  it('will not create a second pool over the first', async () => {
    const { pool } = build();
    await pool.create(VAULT, POOL);
    await expect(pool.create(VAULT, POOL)).rejects.toThrow(/already has a note pool/i);
  });

  it('REFUSES a stale write rather than merging two beliefs about the money', async () => {
    /*
     * `B3`: two operators reconciling the same vault at once is not exotic. A
     * later write landing under an earlier one is a pool that has forgotten a
     * payment, and there is no correct merge — the union invents notes the
     * chain never had, the intersection drops ones it does.
     */
    const { store, a } = build();
    await store.put(VAULT, sealPool(VAULT, POOL, [a.who], 5));
    await expect(store.put(VAULT, sealPool(VAULT, POOL, [a.who], 5)))
      .rejects.toThrow(/refusing to write version 5/i);
    await expect(store.put(VAULT, sealPool(VAULT, POOL, [a.who], 4)))
      .rejects.toThrow(/reconcile against the chain/i);
    await store.put(VAULT, sealPool(VAULT, POOL, [a.who], 6));
  });

  it('nothing readable in a stored pool says what the vault holds', () => {
    /*
     * The stored record's plaintext fields are Tier 4 — an address that is
     * already public and a counter. **Not the note count**, which would be the
     * pool leaking the one number the chain already publishes anyway and the
     * only one it publishes.
     */
    const a = signer('sgn_a');
    const rec = sealPool(VAULT, POOL, [a.who], 1);
    const readable = JSON.stringify({ vault: rec.vault, version: rec.version });
    expect(readable).not.toMatch(/1000|400/);
    expect(readable).not.toContain(POOL.notes[0].nonce);

    /*
     * And the whole record, ciphertext included, carries no note in the clear.
     * **Redacted before it is searched** — `M-101`, and the reason
     * `src/testing/redact.ts` exists: ciphertext is hex and every decimal digit
     * is a hex digit, so a test grepping a sealed record for a value fails on
     * correct code about one run in a hundred and twenty.
     */
    const whole = redactHex(rec);
    expect(whole).not.toMatch(/1000/);
    expect(whole).not.toMatch(/400/);
  });
});
