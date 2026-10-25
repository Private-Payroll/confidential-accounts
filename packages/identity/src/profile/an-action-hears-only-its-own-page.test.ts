import { describe, expect, it, vi } from 'vitest';

vi.mock('./act-intents.js', () => ({
  ACT_INTENTS: Object.freeze({ 'move-between-vaults': { fields: { vault: 'vault' } } }),
}));

import { ACT_RELAYED_SCHEMA, ACT_RELAY_SCHEMA, PROGRESS_SCHEMA, listen } from './channel.js';
import type { ActingChannel, ChannelWindow } from './channel.js';

/*
 * **WHAT A PAGE SAYS ABOUT A TRANSACTION IS HEARD ONLY FROM THE PAGE THAT ASKED.** The wallet hands each built
 * transaction to the page and waits for it to say what it did with it; anything else on the window - another page,
 * another ask, a transaction never handed over - is not that answer.
 */

const NOW = 1_755_000_000_000;
const PAGE = 'https://app.payroll.example';

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
  return { posted, from, channel, opener };
};
const ask = (kind = 'act'): Record<string, unknown> => ({
  schema: 'midnight-identity/disclosure-request/v1', kind, requester: { name: 'Payroll', rdns: 'example.payroll' },
  purpose: 'To move money.', nonce: 'n1', expiresAt: NOW + 600_000,
  ...(kind === 'act' ? { intent: { name: 'move-between-vaults', vault: 'c'.repeat(64) } } : {}),
});
const relayed = (n: number, outcome = 'relayed', nonce = 'n1') => ({ schema: ACT_RELAYED_SCHEMA, nonce, n, outcome });
const settle = async (): Promise<void> => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };

describe('what a page says about a transaction is heard only from the page that asked', () => {
  it('a transaction handed over is answered by its number, from the asking window only', async () => {
    const { posted, from, channel } = opened();
    from(ask());
    let heard: string | null = null;
    void channel.relay({ step: 1, steps: 2 }, 'AAAA').then((r) => { heard = r; });
    expect(posted.at(-1)).toEqual({ schema: ACT_RELAY_SCHEMA, nonce: 'n1', n: 1, step: 1, steps: 2, transaction: 'AAAA' });
    /* RED WHEN: another window, another origin, another ask or another number can say the transaction was sent. */
    from(relayed(1), { postMessage: () => {} });
    from(relayed(1), undefined, 'https://evil.example');
    from(relayed(1, 'relayed', 'another-ask'));
    from(relayed(2));
    await settle();
    expect(heard).toBeNull();
    from(relayed(1, 'refused'));
    await settle();
    expect(heard).toBe('refused');
  });

  it('once the action has ended nothing more is handed over, and a wait still open hears it went unanswered', async () => {
    const { posted, from, channel } = opened();
    from(ask());
    const waiting = channel.relay({ step: 1, steps: 1 }, 'AAAA');
    channel.answer({ schema: 'midnight-identity/act-ended/v1' } as never);
    /* RED WHEN: a transaction still waiting for the page's word is left waiting for ever once the action has ended,
     * or is said never to have been handed over although the page holds it. */
    expect(await waiting).toBe('unanswered');
    const count = posted.length;
    /* RED WHEN: a transaction or a step can still be sent after the action's one terminal answer. */
    expect(await channel.relay({ step: 1, steps: 1 }, 'AAAA')).toBe('gone');
    expect(channel.step({ step: 1, steps: 1 })).toBe(false);
    expect(posted.length).toBe(count);
  });

  it('only an action hands transactions over or says its step', async () => {
    const { posted, from, channel } = opened();
    from({ ...ask('sign-in'), progress: PROGRESS_SCHEMA });
    /* RED WHEN: an ask that is not an action can be made to post a transaction or a step to the page. */
    expect(await channel.relay({ step: 1, steps: 1 }, 'AAAA')).toBe('gone');
    expect(channel.step({ step: 1, steps: 1 })).toBe(false);
    expect(posted.filter((m) => (m as { schema?: unknown }).schema !== 'midnight-identity/wallet-ready/v1')).toEqual([]);
  });
});
