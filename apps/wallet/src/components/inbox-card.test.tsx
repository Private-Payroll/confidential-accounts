// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { gcm } from '@noble/ciphers/aes.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { identityFromSecret } from 'midnight-identity/keys/derivation';
import { NOTICE_KINDS, NOTICE_SCHEMA, inboxKeyOf } from 'midnight-identity/profile/inbox';
import type { InboxAnswer, InboxAsk, InboxHost, SealedItem } from 'midnight-identity/profile/inbox';
import { POLL_EVERY_MS } from 'midnight-identity/profile/inbox-poll';
import { InboxCard, NOTICE_SAYS } from './inbox-card.js';
import { forgetInbox, openInbox } from '../accounts/inbox-live.js';

/*
 * ════════════════════════════════════════════════════════════════════════════
 * THE CARD THAT ASKS, AND THE SENTENCE THAT SAYS WHAT ASKING COSTS.
 *
 * THE RULE: *"THE SCREEN SAYS WHAT THE HOST LEARNS… Not a privacy
 * policy, not a tooltip: a sentence where the thing happens. A product that
 * polls silently while claiming an inbox its host cannot read has told a
 * half-truth, and this sentence is the other half."*
 *
 * **AND THE OTHER HALF OF THE OTHER HALF: A NOTICE MUST NOT LOOK LIKE AN
 * APPROVAL.** `profile/inbox.ts`'s boundary block is why — an inbox item
 * carries no ask, because an observed origin cannot be produced by a channel
 * nobody opened. If this card can be mistaken for the screen that approves
 * things, that boundary is a comment rather than a design, so it is pinned
 * here: no link to a sender's origin, and nothing to press but the control that
 * asks the host.
 * ════════════════════════════════════════════════════════════════════════════
 */

const identity = identityFromSecret(new Uint8Array(32).fill(7));

function sealNotice(over: Record<string, unknown> = {}, id = 'host-ref-1'): SealedItem {
  const plaintext = JSON.stringify({
    schema: NOTICE_SCHEMA,
    kind: 'invitation',
    at: 1_756_000_000_000,
    from: { name: 'Bright Coffee Ltd', rdns: 'com.brightcoffee.payroll' },
    where: 'https://payroll.brightcoffee.example',
    ...over,
  });
  const ephemeral = x25519.keygen();
  const shared = x25519.getSharedSecret(ephemeral.secretKey, hexToBytes(inboxKeyOf(identity)));
  const iv = new Uint8Array(12).fill(3);
  return {
    id,
    ephemeral: bytesToHex(ephemeral.publicKey),
    iv: bytesToHex(iv),
    tag: '',
    body: bytesToHex(gcm(sha256(shared), iv).encrypt(new TextEncoder().encode(plaintext))),
  };
}

function hostHolding(items: readonly SealedItem[]): InboxHost & { asks: InboxAsk[] } {
  const asks: InboxAsk[] = [];
  return {
    describes: 'inbox.midnight.example',
    asks,
    items: (ask: InboxAsk) => {
      asks.push(ask);
      return Promise.resolve<InboxAnswer>({
        schema: 'midnight-identity/inbox-answer/v1', items,
      });
    },
  };
}

afterEach(() => {
  cleanup();
  forgetInbox();
});

describe('the sentence naming what the host learns', () => {
  /**
   * **THE PROOF THIS CHANGE OWES, AND MUTATION 03 IS ITS MUTATION.** It is not
   * a test that some words are present: it names the five things the sentence
   * has to admit, so a rewrite that keeps the paragraph and drops one of them
   * fails here rather than reading fine.
   */
  it('THE SCREEN SAYS WHAT THE HOST LEARNS: named, on the card, in five parts', async () => {
    openInbox(identity, () => true, hostHolding([]));
    render(<InboxCard />);
    const said = await screen.findByText(/While this wallet is open it asks/u);
    const text = said.textContent ?? '';
    /* 1. WHICH HOST. Named, not "a server". */
    expect(text).toContain('inbox.midnight.example');
    /* 2. THAT IT IS POLLED, AND HOW OFTEN — the same number the poller uses. */
    expect(text).toContain(`about every ${String(Math.round(POLL_EVERY_MS / 1000))} seconds`);
    /* 3. THAT IT CANNOT READ THE CONTENTS. */
    expect(text).toMatch(/cannot read a word of what it holds/u);
    /* 4. WHAT IT DOES LEARN — the half a silent poller leaves out. */
    expect(text).toMatch(/when you look and how often/u);
    /* 5. AND THE ONE ADDRESS, which is the cost the opaque-per-company round
     *    removes. A sentence without it would be true and incomplete. */
    expect(text).toMatch(/one address/u);
    expect(text).toMatch(/the same person/u);
    /* AND THE PROMISE. */
    expect(text).toMatch(/Nothing is asked when the wallet is shut/u);
  });

  it('offers the refresh control beside it, because asking on purpose is the other half', async () => {
    openInbox(identity, () => true, hostHolding([]));
    render(<InboxCard />);
    expect(await screen.findByRole('button', { name: 'Check now' })).toBeTruthy();
  });

  it('says nothing is being asked when there is no host — a different fact from an empty inbox', () => {
    openInbox(identity, () => true, null);
    render(<InboxCard />);
    expect(screen.getByText('Nothing is being asked')).toBeTruthy();
    expect(screen.queryByText(/While this wallet is open it asks/u)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Check now' })).toBeNull();
  });
});

describe('a notice on the card', () => {
  it('has a sentence for every kind the wallet reads', () => {
    for (const kind of NOTICE_KINDS) {
      expect(NOTICE_SAYS[kind], kind).toBeTruthy();
    }
    expect(Object.keys(NOTICE_SAYS).sort()).toEqual([...NOTICE_KINDS].sort());
  });

  it('renders the sender words as TEXT and never as markup', async () => {
    const nasty = '<img src=x onerror="document.title=1">';
    openInbox(identity, () => true, hostHolding([
      sealNotice({ from: { name: nasty, rdns: 'com.example' }, says: nasty }),
    ]));
    const { container } = render(<InboxCard />);
    await screen.findByText(NOTICE_SAYS.invitation);
    expect(container.querySelector('img'), 'the sender drew markup on this screen').toBeNull();
    /* The ESCAPED form is what proves it is text: `&lt;img …&gt;` in the HTML
     * and no `<img` anywhere. Asserting on the substring `onerror` would pass
     * either way, because escaped text contains it too — which is how a check
     * like this dies without anybody noticing. */
    expect(container.innerHTML, 'an element the sender wrote reached the DOM')
      .not.toContain('<img');
    expect(container.innerHTML).toContain('&lt;img');
    expect(screen.getAllByText((_, node) => (node?.textContent ?? '').includes(nasty)))
      .not.toHaveLength(0);
  });

  /**
   * **A NOTICE MUST NOT LOOK LIKE AN APPROVAL.** The origin is shown whole, as
   * text, beside a copy control — and this wallet does not link to it. A button
   * to a stranger's address is a button that helps somebody land on the wrong
   * one, and there is nothing on this card that could be agreed to anyway.
   */
  it('shows where to go and does NOT link to it', async () => {
    openInbox(identity, () => true, hostHolding([sealNotice()]));
    const { container } = render(<InboxCard />);
    await screen.findByText('https://payroll.brightcoffee.example');
    const links = [...container.querySelectorAll('a')]
      .map((a) => a.getAttribute('href') ?? '');
    expect(links.filter((h) => h.includes('brightcoffee'))).toEqual([]);
    expect(screen.getByText(/go to\s+this address yourself/u)).toBeTruthy();
    expect(screen.getByText(/Nothing here approves anything/u)).toBeTruthy();
  });

  it('says the sender said the time, rather than that the time happened', async () => {
    openInbox(identity, () => true, hostHolding([sealNotice()]));
    render(<InboxCard />);
    expect(await screen.findByText(/said to be from/u)).toBeTruthy();
  });
});

describe('an item nobody can open', () => {
  /**
   * **THE RULE ON THE SCREEN, AND MUTATION 04.** *"A person with an item nobody
   * can open should be told, not shown an empty list."*
   */
  it('AN UNOPENABLE ITEM IS REPORTED, NOT DROPPED: it is on the screen, named', async () => {
    const others = identityFromSecret(new Uint8Array(32).fill(9));
    const ephemeral = x25519.keygen();
    const shared = x25519.getSharedSecret(ephemeral.secretKey, hexToBytes(inboxKeyOf(others)));
    const iv = new Uint8Array(12).fill(4);
    const notMine: SealedItem = {
      id: 'host-ref-9',
      ephemeral: bytesToHex(ephemeral.publicKey),
      iv: bytesToHex(iv),
      tag: '',
      body: bytesToHex(gcm(sha256(shared), iv).encrypt(new TextEncoder().encode('{}'))),
    };
    openInbox(identity, () => true, hostHolding([notMine]));
    render(<InboxCard />);
    /* TWO ELEMENTS SAY IT — the heading and the reason. `findAllByText`
     * deliberately: a query that demanded exactly one would go red the day the
     * reason stopped being shown, which is the opposite of this test's point. */
    expect(await screen.findAllByText(/cannot open/u)).not.toHaveLength(0);
    expect(screen.queryByText('Nothing is waiting'), 'an unopenable item was shown as nothing')
      .toBeNull();
    expect(screen.getByText('host-ref-9')).toBeTruthy();
  });
});

describe('the inbox lives for the unlocked phase and no longer', () => {
  /**
   * **MUTATION 05.** `openInbox` returns its own teardown so a caller cannot
   * start one and forget to stop it, and the teardown both stops the poller
   * and empties the store: a store that outlived the phase would be a locked
   * wallet's notices still readable by whatever renders next.
   */
  it('THE TEARDOWN STOPS AND FORGETS: nothing is left on the card after it runs', async () => {
    const host = hostHolding([sealNotice()]);
    const stop = openInbox(identity, () => true, host);
    const view = render(<InboxCard />);
    await screen.findByText(NOTICE_SAYS.invitation);

    stop();
    view.rerender(<InboxCard />);

    await waitFor(() => {
      expect(screen.queryByText(NOTICE_SAYS.invitation), 'a notice survived the phase').toBeNull();
    });
    expect(screen.getByText('Nothing is being asked')).toBeTruthy();
  });
});
