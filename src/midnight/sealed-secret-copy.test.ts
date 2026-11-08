/**
 * **A SIGNER'S SEALED COPY OF A VAULT'S SECRET: FOUR PARTS OF THIRTY-TWO BYTES,
 * OPENED ONLY WITH THAT SIGNER'S RECORDS KEY, AND FOUND ON THE CHAIN WITH
 * NOTHING BUT THAT KEY AND WHAT THE VAULT PUBLISHES.**
 */
import { describe, it, expect } from 'vitest';
import {
  sealSecretCopy, openSecretCopy, readersCopyOnTheChain, secretCopyOnTheChain, secretsWalkedBack, SecretCopyUnreadable,
  SEALED_COPY_BYTES, SEALED_COPY_USED_BYTES,
} from './sealed-secret-copy.js';
import { recordsKeypairFrom } from './company-nonce-secret.js';
import { copiesTreeOf } from './sealed-copies-tree.js';
import { fromHex, toHex, wrapKey } from '../core/crypto.js';
import { pureCircuits as V } from '../../contracts/managed-vault/contract/index.js';

const VAULT = 'ab'.repeat(32);
const SECRET = '5e'.repeat(32);
/* Each signer's records key, from the key their wallet releases for the company: their words and its label. */
const A = recordsKeypairFrom(new Uint8Array(32).fill(1));
const B = recordsKeypairFrom(new Uint8Array(32).fill(2));

describe('a sealed copy of a vault\'s secret', () => {
  it('IS FOUR PARTS OF THIRTY-TWO BYTES AND OPENS BACK TO THE SECRET WITH THE READER\'S RECORDS KEY', () => {
    const parts = sealSecretCopy({ vault: VAULT, secret: SECRET, reader: A.publicKey });
    expect(parts.map((p) => p.length)).toEqual([32, 32, 32, 32]);
    /* RED WHEN: the copy does not round-trip - the signer's own words would then open nothing. */
    expect(openSecretCopy({ vault: VAULT, parts, reader: A })).toBe(SECRET);
  });

  it('FITS THE VAULT\'S 128 BYTES, WHICH THE WRAPPED-KEY FORM OF THE SAME SECRET FITS TOO, AND PADS WITH ZEROS', () => {
    expect(SEALED_COPY_BYTES).toBe(128);
    /* The wrapped-key form: the ephemeral key, the nonce and the secret's hex text sealed with its tag. */
    const wrapped = wrapKey(SECRET, A.publicKey);
    const wrappedBytes = fromHex(wrapped.ephemeral).length + fromHex(wrapped.iv).length + fromHex(wrapped.body).length;
    expect(wrappedBytes).toBeLessThanOrEqual(128);
    /* This form carries the secret as its bytes, so it uses less and pads the rest. */
    expect(SEALED_COPY_USED_BYTES).toBe(93);
    const whole = Uint8Array.from(sealSecretCopy({ vault: VAULT, secret: SECRET, reader: A.publicKey }).flatMap((p) => [...p]));
    expect([...whole.subarray(SEALED_COPY_USED_BYTES)].every((b) => b === 0)).toBe(true);
  });

  it('IS THE SAME FOUR PARTS EVERY TIME FOR ONE SECRET, ONE READER AND ONE VAULT, AND DIFFERENT FOR ANOTHER READER', () => {
    const once = sealSecretCopy({ vault: VAULT, secret: SECRET, reader: A.publicKey });
    /* RED WHEN: sealing is random - a start run again could not rebuild the tree its signers approved. */
    expect(sealSecretCopy({ vault: VAULT, secret: SECRET, reader: A.publicKey }).map(toHex)).toEqual(once.map(toHex));
    expect(sealSecretCopy({ vault: VAULT, secret: SECRET, reader: B.publicKey }).map(toHex)).not.toEqual(once.map(toHex));
  });

  it('OPENS ONLY WITH THE READER\'S OWN RECORDS KEY, ONLY FOR ITS OWN VAULT, AND NOT ONCE TAMPERED WITH', () => {
    const parts = sealSecretCopy({ vault: VAULT, secret: SECRET, reader: A.publicKey });
    /* RED WHEN: another signer's records key opens a copy sealed to somebody else. */
    expect(() => openSecretCopy({ vault: VAULT, parts, reader: B })).toThrow(SecretCopyUnreadable);
    expect(() => openSecretCopy({ vault: 'cd'.repeat(32), parts, reader: A })).toThrow(SecretCopyUnreadable);
    const flipped = parts.map((p) => Uint8Array.from(p));
    flipped[2]![0]! ^= 1;
    expect(() => openSecretCopy({ vault: VAULT, parts: flipped, reader: A })).toThrow(SecretCopyUnreadable);
    const padded = parts.map((p) => Uint8Array.from(p));
    padded[3]![31] = 1;
    expect(() => openSecretCopy({ vault: VAULT, parts: padded, reader: A })).toThrow(/padding is not empty/);
    expect(() => openSecretCopy({ vault: VAULT, parts: parts.slice(0, 3), reader: A })).toThrow(/4 parts of 32 bytes/);
  });

  it('IS FOUND ON THE VAULT\'S LEDGER WITH THE READER\'S KEY AND THE COMMITMENT ALONE, AND OPENS FROM THERE', () => {
    const commitment = V.secretCommitmentOf(fromHex(VAULT), fromHex(SECRET));
    const copies = [A, B].map((r) => ({ reader: fromHex(r.publicKey), parts: sealSecretCopy({ vault: VAULT, secret: SECRET, reader: r.publicKey }) }));
    const tree = copiesTreeOf(V as never, commitment, copies);
    expect(tree.count).toBe(2n);
    /* Written as the vault writes them: each part under the vault's own key for its place. */
    const onChain = new Map<string, Uint8Array>();
    copies.forEach((c, place) => c.parts.forEach((p, part) =>
      onChain.set(toHex(V.copyKeyOf(commitment, c.reader, BigInt(place), BigInt(part))), p)));
    const ledger = { member: (k: Uint8Array) => onChain.has(toHex(k)), lookup: (k: Uint8Array) => onChain.get(toHex(k))! };
    const keyOf = (c: Uint8Array, r: Uint8Array, place: bigint, part: bigint) => V.copyKeyOf(c, r, place, part);
    const found = secretCopyOnTheChain(ledger, keyOf, { commitment: toHex(commitment), reader: B.publicKey, count: tree.count });
    expect(found).not.toBeNull();
    /* RED WHEN: the signer cannot get the secret back from the chain with their records key alone. */
    expect(openSecretCopy({ vault: VAULT, parts: found!, reader: B })).toBe(SECRET);
    const stranger = recordsKeypairFrom(new Uint8Array(32).fill(9));
    expect(secretCopyOnTheChain(ledger, keyOf, { commitment: toHex(commitment), reader: stranger.publicKey, count: tree.count })).toBeNull();
  });

  it('IS READ UNDER THE COMMITMENT THE VAULT HOLDS NOW, OR THE ONE WHOSE COPIES WERE LAST ALL WRITTEN, AT THE PLACES THE VAULT\'S OWN COUNT NAMES', () => {
    const EARLIER = '4d'.repeat(32);
    const onChain = new Map<string, Uint8Array>();
    /* Written as the vault writes them, with the number of copies under the vault's own key for it. */
    const written = (secret: string) => {
      const commitment = V.secretCommitmentOf(fromHex(VAULT), fromHex(secret));
      [A, B].forEach((r, place) => sealSecretCopy({ vault: VAULT, secret, reader: r.publicKey })
        .forEach((p, part) => onChain.set(toHex(V.copyKeyOf(commitment, fromHex(r.publicKey), BigInt(place), BigInt(part))), p)));
      onChain.set(toHex(V.copiesCountKeyOf(commitment)), Uint8Array.of(2));
      return commitment;
    };
    const earlier = written(EARLIER);
    const now = written(SECRET);
    onChain.set(toHex(V.copiesWrittenKey()), earlier);
    const ledger = { nonceCommitment: now, secretCopies: { member: (k: Uint8Array) => onChain.has(toHex(k)), lookup: (k: Uint8Array) => onChain.get(toHex(k))! } };
    const read = (of: 'commitment' | 'copies-written') => readersCopyOnTheChain(ledger, V as never, (c) => BigInt(c[0]!), { reader: B.publicKey, of });
    /* RED WHEN: a signer's copy is read under any commitment but the one asked about, so a payment or a carry takes the wrong secret. */
    expect(openSecretCopy({ vault: VAULT, parts: read('commitment').parts!, reader: B })).toBe(SECRET);
    expect(openSecretCopy({ vault: VAULT, parts: read('copies-written').parts!, reader: B })).toBe(EARLIER);
    expect([read('commitment').commitment, read('copies-written').commitment]).toEqual([toHex(now), toHex(earlier)]);
    /* RED WHEN: a place past the vault's own count is looked at: a copy the vault does not count is not the secret's. */
    onChain.set(toHex(V.copiesCountKeyOf(now)), Uint8Array.of(1));
    expect(read('commitment')).toEqual({ commitment: toHex(now), parts: null });
  });
});

describe('every secret that opened, walked back from the one the vault holds now', () => {
  /* Three secrets in turn, each a field element, with its last byte zero as the product makes them (vault-start.ts:156-157). */
  const FIRST = `${'11'.repeat(31)}00`;
  const SECOND = `${'22'.repeat(31)}00`;
  const THIRD = `${'33'.repeat(31)}00`;
  const commitmentOf = (s: string) => toHex(V.secretCommitmentOf(fromHex(VAULT), fromHex(s)));
  /* The links as the vault writes them when a secret is set over one that opened: the earlier one masked by the later. */
  const chainOf = (links: Array<[earlier: string, later: string]>) => {
    const onChain = new Map<string, Uint8Array>();
    for (const [earlier, later] of links) {
      onChain.set(toHex(V.earlierSecretKeyOf(fromHex(commitmentOf(later)))), V.sealedEarlierOf(fromHex(earlier), fromHex(later)));
    }
    return { member: (k: Uint8Array) => onChain.has(toHex(k)), lookup: (k: Uint8Array) => onChain.get(toHex(k))!, onChain };
  };

  it('AFTER TWO CHANGES, THE NEWEST SECRET ALONE OPENS THE ONE BEFORE IT AND THE FIRST, NEWEST FIRST', () => {
    const chain = chainOf([[FIRST, SECOND], [SECOND, THIRD]]);
    const walked = secretsWalkedBack(chain, V, { vault: VAULT, commitment: commitmentOf(THIRD), secrets: [THIRD] });
    /* RED WHEN: the walk stops after one link, or lifts a link with another secret than the one it belongs to. */
    expect(walked).toEqual({ secrets: [THIRD, SECOND, FIRST], repeated: false });
  });

  it('A FIRST SECRET WALKS TO ITSELF ONLY, AND SECRETS NONE OF WHICH IS THE VAULT\'S ARE ANSWERED AS GIVEN, WITH NOTHING WALKED', () => {
    const chain = chainOf([[FIRST, SECOND]]);
    expect(secretsWalkedBack(chain, V, { vault: VAULT, commitment: commitmentOf(FIRST), secrets: [FIRST] }))
      .toEqual({ secrets: [FIRST], repeated: false });
    /* RED WHEN: a walk starts from a secret the vault does not hold now, which would read a link it never wrote for it. */
    expect(secretsWalkedBack(chain, V, { vault: VAULT, commitment: commitmentOf(THIRD), secrets: [SECOND] }))
      .toEqual({ secrets: [SECOND], repeated: false });
  });

  it('KEEPS EVERY SECRET GIVEN AND ADDS ONLY THE EARLIER ONES NOT AMONG THEM, STARTING FROM WHICHEVER GIVEN SECRET IS THE VAULT\'S', () => {
    const chain = chainOf([[FIRST, SECOND], [SECOND, THIRD]]);
    /* RED WHEN: the walk starts from the first secret given rather than the vault's, or names a secret twice. */
    expect(secretsWalkedBack(chain, V, { vault: VAULT, commitment: commitmentOf(THIRD), secrets: [SECOND, THIRD] }).secrets)
      .toEqual([SECOND, THIRD, FIRST]);
  });

  it('A LEDGER WHOSE LINKS COME BACK TO A COMMITMENT ALREADY MET STOPS THERE AND SAYS SO, WITH WHAT IT WALKED', () => {
    /* A link the vault never writes: the second's link lifts to the third, whose link was already followed. */
    const chain = chainOf([[SECOND, THIRD], [THIRD, SECOND]]);
    /* RED WHEN: the walk follows a link back to a secret already met and never ends. */
    expect(secretsWalkedBack(chain, V, { vault: VAULT, commitment: commitmentOf(THIRD), secrets: [THIRD] }))
      .toEqual({ secrets: [THIRD, SECOND], repeated: true });
  });
});
