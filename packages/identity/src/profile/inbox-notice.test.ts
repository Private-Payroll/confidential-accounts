import { describe, expect, it } from 'vitest';
import { gcm } from '@noble/ciphers/aes.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { identityFromSecret } from '../keys/derivation.js';
import type { Identity } from '../keys/derivation.js';
import {
  INBOX_INDEX, NOTICE_KINDS, NOTICE_SCHEMA, inboxKeyOf, inboxKeypair, openAll, openFromInbox,
} from './inbox.js';
import type { InboxAnswer, InboxAsk, InboxHost, SealedItem } from './inbox.js';
import { startInboxPolling } from './inbox-poll.js';
import type { InboxState, Timers } from './inbox-poll.js';

/*
 * ════════════════════════════════════════════════════════════════════════════
 * THE POLLED INBOX.
 *
 * Three properties this change owes, and each one is a refusal rather than a
 * feature:
 *
 *   1. **NOTHING POLLS WITHOUT AN UNLOCKED WALLET**, asserted on every tick
 *      rather than arranged by a caller.
 *   2. **A NOTIFICATION'S CONTENT IS SEALED.** *"No notification content
 *      readable by the server."* An item the host can read is not a
 *      notification, it is a broadcast.
 *   3. **AN UNOPENABLE ITEM IS NOT SILENTLY DROPPED.** The rule one layer up:
 *      *could not read* and *nothing there* are different facts.
 *
 * **THE SENDER IS THIS FILE**, because there is no sender anywhere else: the
 * other repository has no inbox host and posts nothing. So `sealNotice` below
 * is this change's own reading of its own contract, and it is written against
 * `profile/inbox.ts`'s stated fields rather than against `sealToInbox` — if the
 * two disagree, that is exactly the disagreement the change is exposed to and
 * this file is where it shows up.
 * ════════════════════════════════════════════════════════════════════════════
 */

const secretOf = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);
const someone = (fill = 7): Identity => identityFromSecret(secretOf(fill));

/**
 * A SENDER, WRITTEN TO THE CONTRACT AND NOT TO OUR OWN SEALER.
 *
 * Four fields, lowercase hex, `tag` the empty string, the AES key the BYTES of
 * `sha256(shared)` and never its spelling — `profile/inbox.ts`'s three wrong
 * instincts, from the other side.
 */
function sealNotice(plaintext: string, inboxPublicKey: string, id = 'host-ref-1'): SealedItem {
  const ephemeral = x25519.keygen();
  const shared = x25519.getSharedSecret(ephemeral.secretKey, hexToBytes(inboxPublicKey));
  const key = sha256(shared);
  const iv = new Uint8Array(12).fill(3);
  const body = gcm(key, iv).encrypt(new TextEncoder().encode(plaintext));
  return {
    id,
    ephemeral: bytesToHex(ephemeral.publicKey),
    iv: bytesToHex(iv),
    tag: '',
    body: bytesToHex(body),
  };
}

const aNotice = (over: Record<string, unknown> = {}): string => JSON.stringify({
  schema: NOTICE_SCHEMA,
  kind: 'invitation',
  at: 1_756_000_000_000,
  from: { name: 'Bright Coffee Ltd', rdns: 'com.brightcoffee.payroll' },
  where: 'https://payroll.brightcoffee.example',
  says: 'Your start date is the fourth.',
  ...over,
});

describe('the inbox key', () => {
  it('is an X25519 public key in lowercase hex, which is the wire this repository already has', () => {
    const key = inboxKeyOf(someone());
    expect(key).toMatch(/^[0-9a-f]{64}$/u);
    /* The alphabet is the point: `recovery/locks.ts` publishes base64url and
     * this deliberately does not — `profile/inbox.ts` says why. */
    expect(key).not.toContain('-');
    expect(key).not.toContain('_');
  });

  it('is the same key every time, from the secret alone, with nothing stored', () => {
    expect(inboxKeyOf(someone(9))).toBe(inboxKeyOf(someone(9)));
    expect(inboxKeyOf(someone(9))).not.toBe(inboxKeyOf(someone(10)));
  });

  it('is a different key from the recovery key, which is the whole reason it exists', () => {
    /* `Purposes.Recovery` is published for a wallet locking a piece TO this
     * one. Reusing it would put two senders behind one key — trouble at the
     * level of a purpose. */
    const identity = someone(11);
    const inbox = inboxKeypair(identity, INBOX_INDEX);
    const recovery = identity.authority('recovery', 0);
    expect(bytesToHex(inbox.secretKey)).not.toBe(bytesToHex(recovery));
  });
});

describe('a notice, sealed and opened', () => {
  it('opens what was sealed to it, field for field', () => {
    const keys = inboxKeypair(someone());
    const notice = openFromInbox(sealNotice(aNotice(), keys.publicKey), keys);
    expect(notice.kind).toBe('invitation');
    expect(notice.from.name).toBe('Bright Coffee Ltd');
    expect(notice.where).toBe('https://payroll.brightcoffee.example');
    expect(notice.says).toBe('Your start date is the fourth.');
  });

  /**
   * **NO NOTIFICATION CONTENT READABLE BY THE SERVER**, proved by looking for
   * it. The envelope is the only thing a host ever holds, so every one of its
   * fields is searched — including `id`, which the host itself chose.
   */
  it('puts none of the sender words anywhere a host could read them', () => {
    const keys = inboxKeypair(someone());
    const secretish = 'Bright Coffee Ltd';
    const item = sealNotice(aNotice(), keys.publicKey);
    const onTheWire = JSON.stringify(item);
    expect(onTheWire).not.toContain(secretish);
    expect(onTheWire).not.toContain('brightcoffee');
    expect(onTheWire).not.toContain('start date');
    expect(onTheWire).not.toContain('invitation');
    /* And the envelope carries no field the words could have ridden in. */
    expect(Object.keys(item).sort()).toEqual(['body', 'ephemeral', 'id', 'iv', 'tag']);
  });

  it('refuses an item sealed to somebody else, and says which fact that is', () => {
    const mine = inboxKeypair(someone(1));
    const theirs = inboxKeypair(someone(2));
    expect(() => openFromInbox(sealNotice(aNotice(), theirs.publicKey), mine))
      .toThrowError(/cannot open that item/u);
  });

  it('names the `tag` field rather than leaving a person with "could not open"', () => {
    const keys = inboxKeypair(someone());
    const item = { ...sealNotice(aNotice(), keys.publicKey), tag: 'aa'.repeat(16) };
    expect(() => openFromInbox(item, keys)).toThrowError(/`tag` is not empty/u);
  });

  it('separates "will not open" from "opened and is not a notice"', () => {
    const keys = inboxKeypair(someone());
    const rubbish = sealNotice('not json at all', keys.publicKey);
    let code = '';
    try { openFromInbox(rubbish, keys); } catch (e) { code = (e as { code: string }).code; }
    expect(code).toBe('not-a-notice');
  });

  it('refuses a `where` that is not an https origin, including one with a path', () => {
    const keys = inboxKeypair(someone());
    for (const where of [
      'https://payroll.example/join?token=1',
      'http://payroll.example',
      'payroll.example',
      'javascript:alert(1)',
    ]) {
      expect(
        () => openFromInbox(sealNotice(aNotice({ where }), keys.publicKey), keys),
        where,
      ).toThrowError(/not an `https:` origin|not a place written down/u);
    }
  });

  it('refuses a kind it has no words for rather than rendering a blank', () => {
    const keys = inboxKeypair(someone());
    expect(() => openFromInbox(sealNotice(aNotice({ kind: 'payslip' }), keys.publicKey), keys))
      .toThrowError(/has no words for/u);
  });

  it('reads the three kinds the agreement names, and nothing else', () => {
    expect([...NOTICE_KINDS]).toEqual(['invitation', 'proposal', 'seat']);
  });
});

describe('an unopenable item is reported rather than dropped', () => {
  /**
   * **MADE STRUCTURAL.** The length assertion is the property: one
   * result per item, always. A reader that returned only what it could open
   * would pass every other test in this file.
   */
  it('AN UNOPENABLE ITEM IS REPORTED, NOT DROPPED: one result per item, always', () => {
    const mine = inboxKeypair(someone(1));
    const theirs = inboxKeypair(someone(2));
    const items = [
      sealNotice(aNotice(), mine.publicKey, 'a'),
      sealNotice(aNotice(), theirs.publicKey, 'b'),
      { id: 'c', ephemeral: 'nonsense', iv: '', tag: '', body: '' },
    ];
    const openings = openAll(items, mine);
    expect(openings).toHaveLength(3);
    expect(openings.map((o) => o.of)).toEqual(['notice', 'unopenable', 'unopenable']);
    expect(openings[1]!.id).toBe('b');
  });

  it('names an item the host gave no reference, rather than printing nothing', () => {
    const mine = inboxKeypair(someone(1));
    const openings = openAll([{ ephemeral: '', iv: '', tag: '', body: '' } as SealedItem], mine);
    expect(openings[0]!.id).toContain('no reference');
  });
});

/* ------------------------------------------------------------- the polling */

/** A clock a test turns by hand. Nothing here waits on a real timer. */
function fakeTimers(): Timers & { tick(): void; pending(): number } {
  let queued: (() => void)[] = [];
  return {
    after: (_ms: number, fn: () => void) => { queued.push(fn); return queued.length; },
    cancel: () => { queued = []; },
    tick: () => { const due = queued; queued = []; for (const fn of due) fn(); },
    pending: () => queued.length,
  };
}

function countingHost(answer: InboxAnswer = {
  schema: 'midnight-identity/inbox-answer/v1', items: [],
}): InboxHost & { asks: InboxAsk[] } {
  const asks: InboxAsk[] = [];
  return {
    describes: 'inbox.example',
    asks,
    items: (ask: InboxAsk) => { asks.push(ask); return Promise.resolve(answer); },
  };
}

describe('nothing polls without an unlocked wallet', () => {
  /**
   * **THE ONE THIS CHANGE OWES, AND THE MUTATION IS NUMBER
   * 01.** Removing the guard before the ask leaves a poller that keeps asking a
   * host from a wallet nobody is in — which tells the host somebody is at this
   * browser when nobody is.
   */
  it('POLLING STOPS WHEN THE WALLET LOCKS: no ask leaves after the lock', async () => {
    const host = countingHost();
    const timers = fakeTimers();
    let unlocked = true;
    const poll = startInboxPolling({
      host, keys: inboxKeypair(someone()), unlocked: () => unlocked,
      onState: () => {}, timers, everyMs: 1,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(host.asks).toHaveLength(1);

    unlocked = false;
    timers.tick();
    await Promise.resolve();
    await Promise.resolve();

    expect(host.asks, 'an ask reached the host from a locked wallet').toHaveLength(1);
    expect(poll.stopped(), 'the poller did not stop itself when the wallet locked').toBe(true);
    expect(timers.pending(), 'a timer outlived the unlocked phase').toBe(0);
  });

  /**
   * **THE SUBTLE HALF, AND MUTATION 02.** A wallet can lock while the host is
   * answering. Delivering that answer would put a locked wallet's notices into
   * a store that outlives the phase.
   */
  it('drops an answer that arrives after the lock rather than delivering it', async () => {
    let release: (answer: InboxAnswer) => void = () => {};
    const host: InboxHost = {
      describes: 'inbox.example',
      items: () => new Promise<InboxAnswer>((resolve) => { release = resolve; }),
    };
    const seen: InboxState[] = [];
    let unlocked = true;
    const poll = startInboxPolling({
      host, keys: inboxKeypair(someone()), unlocked: () => unlocked,
      onState: (s) => seen.push(s), timers: fakeTimers(), everyMs: 1,
    });
    await Promise.resolve();
    unlocked = false;
    release({
      schema: 'midnight-identity/inbox-answer/v1',
      items: [sealNotice(aNotice(), inboxKeyOf(someone()))],
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(seen.map((s) => s.of), 'an answer was delivered into a locked phase')
      .not.toContain('answered');
    expect(poll.stopped()).toBe(true);
  });

  /**
   * **AND THE TIMER ITSELF GOES.** `stopped()` answering true is a flag; a tick
   * already on the queue is a thing that will happen. Mutation 07 is the one
   * that leaves the cancel out.
   */
  it('stop cancels the tick that was already scheduled', async () => {
    const host = countingHost();
    const timers = fakeTimers();
    const poll = startInboxPolling({
      host, keys: inboxKeypair(someone()), unlocked: () => true,
      onState: () => {}, timers, everyMs: 1,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(timers.pending()).toBe(1);
    poll.stop();
    expect(timers.pending(), 'a timer survived stop()').toBe(0);
    timers.tick();
    await Promise.resolve();
    expect(host.asks).toHaveLength(1);
  });

  it('asks on purpose when refreshed, which is the control the agreement requires', async () => {
    const host = countingHost();
    const poll = startInboxPolling({
      host, keys: inboxKeypair(someone()), unlocked: () => true,
      onState: () => {}, timers: fakeTimers(), everyMs: 60_000,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(host.asks).toHaveLength(1);
    poll.refresh();
    await Promise.resolve();
    await Promise.resolve();
    expect(host.asks).toHaveLength(2);
    poll.stop();
  });

  it('a host that did not answer is not an empty inbox', async () => {
    const host: InboxHost = {
      describes: 'inbox.example',
      items: () => Promise.reject(new Error('the network refused')),
    };
    const seen: InboxState[] = [];
    const poll = startInboxPolling({
      host, keys: inboxKeypair(someone()), unlocked: () => true,
      onState: (s) => seen.push(s), timers: fakeTimers(), everyMs: 1,
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const last = seen[seen.length - 1]!;
    expect(last.of).toBe('failed');
    poll.stop();
  });

  it('never reads the cursor it echoes back', async () => {
    const host = countingHost({
      schema: 'midnight-identity/inbox-answer/v1', items: [], cursor: 'opaque-42',
    });
    const poll = startInboxPolling({
      host, keys: inboxKeypair(someone()), unlocked: () => true,
      onState: () => {}, timers: fakeTimers(), everyMs: 1,
    });
    await Promise.resolve();
    await Promise.resolve();
    poll.refresh();
    await Promise.resolve();
    await Promise.resolve();
    expect(host.asks[0]!.after).toBeUndefined();
    expect(host.asks[1]!.after).toBe('opaque-42');
    poll.stop();
  });
});
