import { describe, expect, it, vi } from 'vitest';

vi.mock('./act-intents.js', () => ({
  ACT_INTENTS: Object.freeze({ 'move-between-vaults': { fields: { vault: 'vault' } } }),
}));

import { ACT_KEEP_SCHEMA, ACT_KEPT_SCHEMA, ACT_RELAY_SCHEMA, listen } from './channel.js';
import { readActKeep } from './act-channel.js';
import type { ActingChannel, ChannelWindow, KeptOver } from './channel.js';
import { RequestError, parseAsk } from './request.js';
import { MOST_SEALED_KEYRING } from './unlock.js';

/*
 * **AN ACTION CARRIES THE PERSON'S SAVED KEYS SEALED, AND HANDS THEM BACK SEALED.** The page holds the sealed copy
 * the service gave it and never the key; the wallet opens it, and hands back what it sealed again for the page to
 * keep, hearing `kept` only from the page that asked and only with the version the service now holds.
 */

const NOW = 1_755_000_000_000;
const PAGE = 'https://app.payroll.example';
const SEALED = { iv: '00'.repeat(12), tag: '', body: 'ab'.repeat(40) };

const act = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema: 'midnight-identity/disclosure-request/v1', kind: 'act', requester: { name: 'Payroll', rdns: 'example.payroll' },
  purpose: 'To move money.', nonce: 'n1', expiresAt: NOW + 600_000,
  intent: { name: 'move-between-vaults', vault: 'c'.repeat(64) },
  person: 'usr_a', keyring: { sealed: SEALED, version: 3 },
  ...over,
});
const refusal = (raw: unknown): string => {
  try {
    parseAsk(raw, PAGE, NOW);
  } catch (e) {
    if (e instanceof RequestError) return e.code;
    throw e;
  }
  return 'accepted';
};
const without = (field: string): Record<string, unknown> => {
  const a = act();
  delete a[field];
  return a;
};

describe('an action ask carries the person and their saved keys, sealed, together or not at all', () => {
  it('reads the person and the sealed saved keys with the service\'s version', () => {
    const read = parseAsk(act(), PAGE, NOW);
    expect(read.kind).toBe('act');
    if (read.kind !== 'act') return;
    /* RED WHEN: the saved keys or the person they are for do not reach the wallet, so an action cannot open them. */
    expect(read.person).toBe('usr_a');
    expect(read.keyring).toEqual({ sealed: SEALED, version: 3 });
    const none = parseAsk(act({ keyring: { sealed: null, version: 0 } }), PAGE, NOW);
    /* RED WHEN: a person with no saved keys yet cannot be handed to an action. */
    expect(none.kind === 'act' ? none.keyring : undefined).toEqual({ sealed: null, version: 0 });
    const neither = without('person');
    delete neither['keyring'];
    const plain = parseAsk(neither, PAGE, NOW);
    /* RED WHEN: an action that opens no saved keys is made to carry them. */
    expect(plain.kind === 'act' ? [plain.person, plain.keyring] : null).toEqual([undefined, undefined]);
  });

  it('refuses a person without saved keys, saved keys without a person, and either in a shape it cannot use', () => {
    /* RED WHEN: one of the pair is accepted alone, so an action runs on saved keys it cannot open, or on none. */
    expect(refusal(without('keyring'))).toBe('not-an-act');
    expect(refusal(without('person'))).toBe('not-an-act');
    /* RED WHEN: a person named in a shape the key cannot be derived from reaches the wallet. */
    expect(refusal(act({ person: 'has space' }))).toBe('not-a-person');
    /* RED WHEN: saved keys that are not sealed saved keys of a size this wallet reads are taken as given. */
    for (const keyring of [
      'AAAA',
      { sealed: SEALED },
      { sealed: SEALED, version: -1 },
      { sealed: SEALED, version: 1.5 },
      { sealed: { ...SEALED, iv: '00' }, version: 0 },
      { sealed: { ...SEALED, body: 'zz'.repeat(40) }, version: 0 },
      { sealed: { ...SEALED, body: 'a'.repeat(MOST_SEALED_KEYRING + 2) }, version: 0 },
      { sealed: { ...SEALED, key: 'ab' }, version: 0 },
      { sealed: SEALED, version: 0, opened: true },
    ]) {
      expect(refusal(act({ keyring })), JSON.stringify(keyring).slice(0, 60)).toBe('not-an-act');
    }
  });

  it('a person still belongs to no kind but the ones that use one', () => {
    /* RED WHEN: allowing a person on an action lets any other kind carry one unread. */
    const signIn = { ...act(), kind: 'sign-in' } as Record<string, unknown>;
    delete signIn['intent'];
    delete signIn['keyring'];
    expect(refusal(signIn)).toBe('keyring-fields-on-another-kind');
  });
});

const opened = () => {
  const posted: unknown[] = [];
  const opener = { postMessage: (m: unknown) => { posted.push(m); } };
  let handler: ((e: MessageEvent) => void) | null = null;
  const view = {
    opener, parent: null, addEventListener: (_t: string, h: (e: MessageEvent) => void) => { handler = h; },
    removeEventListener: () => { handler = null; },
  } as unknown as ChannelWindow;
  const from = (data: unknown, source: unknown = opener, origin = PAGE) =>
    handler?.({ source, origin, data } as unknown as MessageEvent);
  const channel = listen(view, () => NOW, () => {}, PAGE) as ActingChannel;
  return { posted, from, channel };
};
const kept = (n: number, over: Record<string, unknown> = {}) => ({ schema: ACT_KEPT_SCHEMA, nonce: 'n1', n, outcome: 'kept', version: 4, ...over });
const settle = async (): Promise<void> => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };

describe('saved keys an action seals again are kept only on the word of the page that asked', () => {
  it('hands them over numbered apart from transactions, and hears `kept` with the version only from the asking window', async () => {
    const { posted, from, channel } = opened();
    from(act());
    void channel.relay({ step: 1, steps: 2 }, 'AAAA');
    let heard: KeptOver | null = null;
    void channel.keep({ step: 1, steps: 2 }, SEALED, 3).then((r) => { heard = r; });
    expect((posted.at(-2) as { schema: string }).schema).toBe(ACT_RELAY_SCHEMA);
    /* RED WHEN: saved keys go to the page in another shape, or without the version they are to be written over. */
    expect(posted.at(-1)).toEqual({ schema: ACT_KEEP_SCHEMA, nonce: 'n1', n: 1, step: 1, steps: 2, sealed: SEALED, ifVersion: 3 });
    expect(readActKeep(posted.at(-1), 'n1')).not.toBeNull();
    /* RED WHEN: another window, another origin, another ask or another number can say the saved keys were kept. */
    from(kept(1), { postMessage: () => {} });
    from(kept(1), undefined, 'https://evil.example');
    from(kept(1, { nonce: 'another-ask' }));
    from(kept(2));
    from({ schema: 'midnight-identity/act-relayed/v1', nonce: 'n1', n: 1, outcome: 'relayed' });
    await settle();
    expect(heard).toBeNull();
    from(kept(1));
    await settle();
    expect(heard).toEqual({ of: 'kept', version: 4 });
  });

  it('a `kept` without the version the service holds is not taken as kept', async () => {
    const { from, channel } = opened();
    from(act());
    const waiting = channel.keep({ step: 1, steps: 1 }, SEALED, 3);
    /* RED WHEN: the page can say the saved keys were kept without saying what the service now holds. */
    from(kept(1, { version: undefined }));
    expect(await waiting).toBe('refused');
  });

  it('once the action has ended, a wait still open hears it went unanswered and nothing more is handed over', async () => {
    const { posted, from, channel } = opened();
    from(act());
    const waiting = channel.keep({ step: 1, steps: 1 }, SEALED, 3);
    channel.answer({ schema: 'midnight-identity/act-ended/v1' } as never);
    /* RED WHEN: saved keys still waiting for the page's word are left waiting for ever once the action has ended. */
    expect(await waiting).toBe('unanswered');
    const count = posted.length;
    expect(await channel.keep({ step: 1, steps: 1 }, SEALED, 3)).toBe('gone');
    expect(posted.length).toBe(count);
  });
});
