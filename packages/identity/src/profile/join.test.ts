// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { x25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { gcm } from '@noble/ciphers/aes.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { ASK_KINDS, RequestError, parseAsk, parseRequest } from './request.js';
import type { JoinRequest } from './request.js';
import { ACCEPTANCE_SCHEMA, InboxError, sealToInbox } from './inbox.js';

/**
 * **ACCEPTING AN INVITATION IS AN ACTION THE WALLET APPROVES.**
 *
 * Two things are pinned here and they are different in kind.
 *
 * **THE PARSER'S HALF** is the shape of the fourth ask: a `join` carries a
 * `wants` list exactly as a disclosure does, and one field no other kind may
 * carry -- the key the acceptance is sealed to. Every refusal is by PRESENCE
 * and by NAME, which is the sentence `origin`, `wants` and `company` are
 * already refused in.
 *
 * **THE SEAL'S HALF IS A WIRE CONTRACT THIS REPOSITORY DOES NOT OWN**, and
 * that is why it is tested by round-tripping through an independent
 * implementation of the READER rather than by asserting what `sealToInbox`
 * returns. `unsealAsTheOtherSideDoes` below is written from the description of
 * the consuming code -- x25519, `sha256(shared)` as the AES key, AES-GCM, the
 * four hex fields -- and not from `inbox.ts`. **A test written from the
 * implementation would agree with a wrong implementation**, which is exactly
 * the failure the encoding note in `inbox.ts` exists to prevent: base64url is
 * this repository's habit and hex is what the reader decodes.
 */

const NOW = 1_755_000_000_000;
const ORIGIN = 'https://payroll-a.example';

/** A company's published inbox key, in the spelling the wire carries. */
const inbox = x25519.keygen();
const inboxSecret = inbox.secretKey;
const INBOX_KEY = bytesToHex(inbox.publicKey);

/** An invitation on the wire. `wants` AND a key -- both, or it is not a join. */
const join = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema: 'midnight-identity/disclosure-request/v1',
  kind: 'join',
  requester: { name: 'Payroll A', rdns: 'example.payroll-a' },
  purpose: 'Accept your invitation so we can pay you.',
  wants: [
    { attribute: 'receiving-address', required: true },
    { attribute: 'given-name', required: false, reason: 'For your payslip.' },
  ],
  inboxPublicKey: INBOX_KEY,
  nonce: 'n1',
  expiresAt: NOW + 60_000,
  ...over,
});

const refusal = (body: unknown, origin = ORIGIN): RequestError => {
  try {
    parseAsk(body, origin, NOW);
  } catch (e) {
    return e as RequestError;
  }
  throw new Error('that was accepted, and the point of the case is that it is refused');
};

/**
 * THE READER, REIMPLEMENTED FROM ITS DESCRIPTION AND NOT FROM `inbox.ts`.
 *
 * x25519 with the inbox secret and the envelope's `ephemeral`; the AES key is
 * the BYTES of `sha256(shared)`; AES-GCM over `body` with `iv`; **`tag` is
 * never read**, which is why this function never looks at it.
 */
const unsealAsTheOtherSideDoes = (
  envelope: { ephemeral: string; iv: string; body: string }, secret: Uint8Array,
): string => {
  const shared = x25519.getSharedSecret(secret, hexToBytes(envelope.ephemeral));
  const key = sha256(shared);
  const opened = gcm(key, hexToBytes(envelope.iv)).decrypt(hexToBytes(envelope.body));
  return new TextDecoder().decode(opened);
};

describe('a join is one of the kinds this wallet answers', () => {
  it('THE KIND IS IN `ASK_KINDS`, AND IT IS APPENDED RATHER THAN INSERTED', () => {
    /* The order is read out onto a screen by `namedKinds`. Appending is what
     * keeps the sentence the other three kinds already produced unchanged. */
    expect(ASK_KINDS).toEqual(['disclosure', 'sign-in', 'unlock', 'join']);
  });

  it('THE SENTENCE THAT LISTS THE KINDS STILL READS CORRECTLY WITH FOUR', () => {
    /*
     * **THE WHOLE SENTENCE, VERBATIM, AND NOT A `toContain` OF THE NEW NAME.**
     * `request.ts`'s `namedKinds` builds it, and it was written for two, fixed
     * for three, and is claimed to be right for any number. A `toContain` would
     * pass on *'disclosure' and 'sign-in' and 'unlock' and 'join'* -- the exact
     * shape removed earlier -- so this asserts the commas and the single final
     * `and`. It is the assertion that goes red if a fifth kind is appended and
     * this function is not read again.
     */
    const said = refusal(join({ kind: 'approve' })).message;
    expect(said).toContain(
      "this wallet answers 'disclosure', 'sign-in', 'unlock' and 'join', and that asks");
    expect(said).not.toContain("'unlock' and 'join' and");
  });

  it('a well-formed invitation parses, and the key is folded to one spelling', () => {
    const ask = parseAsk(
      join({ inboxPublicKey: INBOX_KEY.toUpperCase() }), ORIGIN, NOW) as JoinRequest;
    expect(ask.kind).toBe('join');
    expect(ask.inboxPublicKey).toBe(INBOX_KEY);
    /* The folding argument, applied to a second hex field: one canonical form
     * travels inward, so the screen shows one spelling and the seal is handed
     * one. */
    expect(ask.inboxPublicKey).toBe(ask.inboxPublicKey.toLowerCase());
    expect(ask.wants.map((w) => w.attribute)).toEqual(['receiving-address', 'given-name']);
  });

  it('THE ORIGIN IS STILL THE BROWSER\'S, AND A JOIN THAT NAMES ONE IS REFUSED', () => {
    const ask = parseAsk(join(), ORIGIN, NOW);
    expect(ask.requester.origin).toBe(ORIGIN);
    expect(refusal(join({ origin: 'https://evil.example' })).code)
      .toBe('claims-its-own-origin');
  });

  it('A JOIN THAT NAMES AN ADDRESS IS NOT SERVED THAT ADDRESS', () => {
    /* The refusal is checked before the kind is read, so the fourth kind
     * inherits it rather than needing its own arm. Pinned here because
     * *inherits it* is a claim about a line's position. */
    expect(refusal(join({ address: 'mn_shield-addr_test1abc' })).code)
      .toBe('proposes-an-address');
  });
});

describe('THE KEY AN ACCEPTANCE IS SEALED TO IS REFUSED BY NAME AND BY PRESENCE', () => {
  it('a join with no key at all is refused, and nothing is shown', () => {
    const { inboxPublicKey, ...withoutKey } = join();
    expect(inboxPublicKey).toBeDefined();
    const said = refusal(withoutKey);
    expect(said.code).toBe('not-an-inbox-key');
    expect(said.message).toContain('nothing has been shown to them');
  });

  it('A MALFORMED KEY IS REFUSED RATHER THAN SEALED TO', () => {
    /* Sealing to a key nothing can open destroys the answer instead of
     * delivering it, and the person would never learn that it had. */
    for (const bad of [
      INBOX_KEY.slice(0, 63),
      `${INBOX_KEY}0`,
      `0x${INBOX_KEY.slice(2)}`,
      INBOX_KEY.replace(/^../u, 'zz'),
      '',
      42,
      null,
    ]) {
      expect(refusal(join({ inboxPublicKey: bad })).code).toBe('not-an-inbox-key');
    }
  });

  it('A DISCLOSURE MAY NOT NAME AN INBOX KEY — refused by presence, its own code', () => {
    const said = refusal({
      schema: 'midnight-identity/disclosure-request/v1',
      requester: { name: 'Payroll A', rdns: 'example.payroll-a' },
      purpose: 'To pay you.',
      wants: [{ attribute: 'given-name', required: true }],
      inboxPublicKey: INBOX_KEY,
      nonce: 'n1',
      expiresAt: NOW + 60_000,
    });
    expect(said.code).toBe('inbox-key-on-a-disclosure');
    /* IGNORING IT IS THE FAULT. A requester answered in the clear after naming
     * a key would be entitled to believe its answer had been sealed. */
    expect(said.message).toContain('refused rather than ignored');
  });

  it('a sign-in and an unlock may not name one either, each with its own code', () => {
    expect(refusal({
      schema: 'midnight-identity/disclosure-request/v1',
      kind: 'sign-in',
      requester: { name: 'Payroll A', rdns: 'example.payroll-a' },
      purpose: 'So we know it is you.',
      inboxPublicKey: INBOX_KEY,
      nonce: 'n1',
      expiresAt: NOW + 60_000,
    }).code).toBe('inbox-key-on-a-sign-in');

    expect(refusal({
      schema: 'midnight-identity/disclosure-request/v1',
      kind: 'unlock',
      requester: { name: 'Payroll A', rdns: 'example.payroll-a' },
      purpose: 'To open your records.',
      company: 'a'.repeat(64),
      inboxPublicKey: INBOX_KEY,
      nonce: 'n1',
      expiresAt: NOW + 60_000,
    }).code).toBe('inbox-key-on-an-unlock');
  });

  it('a join may not name a company — two powers, one press, refused whole', () => {
    expect(refusal(join({ company: 'a'.repeat(64) })).code).toBe('company-on-a-join');
  });

  it('AN INVITATION THAT ASKS FOR NOTHING IS A BUG IN THE INVITER', () => {
    expect(refusal(join({ wants: [] })).code).toBe('nothing-asked-for');
    const { wants, ...withoutWants } = join();
    expect(wants).toBeDefined();
    expect(refusal(withoutWants).code).toBe('nothing-asked-for');
  });

  it('AN INVITATION THAT NEVER ASKS WHERE TO PAY IS NOT AN INVITATION', () => {
    /*
     * **THE ONE REFUSAL THIS WALLET OWNS ABOUT WHAT A JOIN ASKS FOR.** §6.
     *
     * It is not the wallet fixing the company's list -- the company still
     * chooses every attribute, and this adds none. It refuses a message whose
     * shape contradicts its own kind, exactly as `not-an-inbox-key` and
     * `company-on-a-join` do: accepting an invitation is handing over somewhere
     * to be paid, and one that does not ask for that is asking for something
     * else.
     */
    const said = refusal(join({
      wants: [{ attribute: 'given-name', required: true }],
    }));
    expect(said.code).toBe('not-an-invitation');
    expect(said.message).toContain("'receiving-address'");
    expect(said.message).toContain('Nothing has been shown to them');
    /* And it names the door that IS open for a company that wants a name and
     * not an address, rather than leaving it to be guessed. */
    expect(said.message).toContain('ordinary request for details');
  });

  it('AND ASKING FOR IT OPTIONALLY IS THE SAME EMPTINESS ONE STEP REMOVED', () => {
    /*
     * `required` is what the approval screen reads to warn a person who
     * declines the address. An invitation that marked it optional would make
     * that warning unreachable while still calling itself an invitation.
     */
    expect(refusal(join({
      wants: [
        { attribute: 'receiving-address', required: false },
        { attribute: 'given-name', required: true },
      ],
    })).code).toBe('not-an-invitation');
  });

  it('the company still chooses the rest of the list, and the order', () => {
    /* **THE HALF THAT IS NOT REFUSED.** The wallet requires that ONE thing is
     * asked for. Everything else about the list -- which attributes, how many,
     * in what order, with what reasons -- is the company's, and is carried
     * through untouched. */
    const ask = parseAsk(join({
      wants: [
        { attribute: 'email', required: false, reason: 'For your payslip.' },
        { attribute: 'receiving-address', required: true },
        { attribute: 'family-name', required: true },
      ],
    }), ORIGIN, NOW) as JoinRequest;
    expect(ask.wants.map((w) => w.attribute))
      .toEqual(['email', 'receiving-address', 'family-name']);
    expect(ask.wants[0]?.reason).toBe('For your payslip.');
  });

  it('a want on a join is the same three fields, and a fourth is refused', () => {
    expect(refusal(join({
      wants: [{ attribute: 'receiving-address', required: true, address: 'mn_shield-addr_x' }],
    })).code).toBe('a-want-proposes-a-value');
  });
});

describe('THE FOURTH KIND LANDS ON THE SAME FAIL-CLOSED EDGE AS THE SECOND AND THIRD', () => {
  it('stripping `kind: join` in flight leaves a disclosure carrying a key — refused', () => {
    const { kind, ...stripped } = join();
    expect(kind).toBe('join');
    expect(refusal(stripped).code).toBe('inbox-key-on-a-disclosure');
  });

  it('adding `kind: join` to a disclosure leaves a join with no key — refused', () => {
    expect(refusal({
      schema: 'midnight-identity/disclosure-request/v1',
      kind: 'join',
      requester: { name: 'Payroll A', rdns: 'example.payroll-a' },
      purpose: 'To pay you.',
      wants: [{ attribute: 'given-name', required: true }],
      nonce: 'n1',
      expiresAt: NOW + 60_000,
    }).code).toBe('not-an-inbox-key');
  });

  it('`parseRequest` still answers only a disclosure, and names what it got', () => {
    expect(() => parseRequest(join(), ORIGIN, NOW)).toThrow(RequestError);
    try {
      parseRequest(join(), ORIGIN, NOW);
    } catch (e) {
      expect((e as RequestError).code).toBe('not-a-disclosure');
      expect((e as RequestError).message).toContain("that is a 'join'");
    }
  });
});

describe('THE SEAL IS THE READER\'S SHAPE, NOT THIS REPOSITORY\'S HABIT', () => {
  it('AN ACCEPTANCE ROUND-TRIPS THROUGH AN INDEPENDENT READER', () => {
    const sealed = sealToInbox('{"payload":"whatever this mints"}', INBOX_KEY);
    expect(unsealAsTheOtherSideDoes(sealed, inboxSecret))
      .toBe('{"payload":"whatever this mints"}');
  });

  it('EVERY FIELD IS LOWERCASE HEX, AND `tag` IS THE EMPTY STRING', () => {
    /*
     * **THE THREE PLACES THE INSTINCT IS WRONG**, asserted rather than
     * commented. Base64url is this repository's convention for an X25519
     * public key (`recovery/locks.ts`); the reader decodes with `fromHex`. And
     * `tag` is `''` because the reader emits `''` and never reads it -- the
     * authentication tag is the last sixteen bytes of `body`.
     */
    const sealed = sealToInbox('x', INBOX_KEY);
    expect(sealed.schema).toBe(ACCEPTANCE_SCHEMA);
    expect(sealed.tag).toBe('');
    expect(sealed.ephemeral).toMatch(/^[0-9a-f]{64}$/u);
    expect(sealed.iv).toMatch(/^[0-9a-f]{24}$/u);
    expect(sealed.body).toMatch(/^[0-9a-f]+$/u);
    /* One byte of plaintext plus a sixteen-byte tag, so the tag is inside
     * `body` and there is nowhere else it could be. */
    expect(sealed.body.length).toBe((1 + 16) * 2);
  });

  it('sealing the same thing twice produces two different envelopes', () => {
    /* A fresh ephemeral key every time, so nobody watching the wire can tell
     * that the same acceptance was sent again. */
    const a = sealToInbox('same', INBOX_KEY);
    const b = sealToInbox('same', INBOX_KEY);
    expect(a.ephemeral).not.toBe(b.ephemeral);
    expect(a.body).not.toBe(b.body);
  });

  it('THE DOOR CHECKS THE KEY ITSELF RATHER THAN TRUSTING ITS CALLER', () => {
    /* A known shape: the parser checks it too, and the day something else
     * calls this the check must be in the function and not in that caller's
     * memory. */
    try {
      sealToInbox('x', 'not a key');
      throw new Error('that was sealed, and the point of the case is that it is not');
    } catch (e) {
      expect(e).toBeInstanceOf(InboxError);
      expect((e as InboxError).code).toBe('not-an-inbox-key');
      expect((e as InboxError).message).toContain('Nothing has been sealed');
    }
  });
});
