// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Buffer as PolyfillBuffer } from 'buffer/';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { identityFromSecret, identityFromWords, newSecret } from 'midnight-identity/keys/derivation';
import { EMAIL, GIVEN_NAME, REGISTRY, registryOf } from 'midnight-identity/profile/attributes';
import { define } from 'midnight-identity/profile/definition';
import {
  editValue, emptyProfile, recordDisclosure, recordIssued, selfAssert,
} from 'midnight-identity/profile/model';
import { save } from 'midnight-identity/profile/store';
import type { Port } from 'midnight-identity/profile/store';
import { ProfileScreen } from './screens/profile.js';

(globalThis as { Buffer?: unknown }).Buffer = PolyfillBuffer;

const NOW = 1_755_000_000_000;
const identity = identityFromWords(TEST_MNEMONIC);

const memory = (): Port => {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => { map.set(k, v); },
    removeItem: (k) => { map.delete(k); },
  };
};

let port: Port;
beforeEach(() => { port = memory(); });
afterEach(() => { cleanup(); });

const show = async (): Promise<void> => {
  render(<ProfileScreen identity={identity} port={port} />);
  await screen.findByText('First name');
};

describe('§6 — NO REVOCATION LANGUAGE, ANYWHERE', () => {
  it('says what is sent, is sent — and offers no control that implies a leash', async () => {
    await show();
    expect(screen.getByText(/What is sent, is sent/u)).toBeTruthy();
    expect(document.body.textContent).toContain('cannot reach into their records');

    /*
     * PINNED ON THE CONTROLS, NOT ON THE PROSE, and that distinction is the
     * whole of it. *"Nothing can take back what has gone"* is the sentence
     * this screen must SAY; a button called *Revoke access* is the thing it
     * must never OFFER. A crude search for the words would forbid the honest
     * half along with the dishonest one, so what is pinned is the interactive
     * surface: nothing you can press here claims to reach a recipient.
     */
    const controls = [...document.querySelectorAll('button, a, [role="button"]')];
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      const words = (control.textContent ?? '').toLowerCase();
      for (const forbidden of [
        'revoke', 'unshare', 'withdraw', 'take back', 'recall', 'delete from', 'undo',
      ]) {
        expect(words).not.toContain(forbidden);
      }
    }
  });

  it('the changed-value notice NAMES the gap and refuses to imply it can close it',
    async () => {
      let profile = selfAssert(emptyProfile(NOW), REGISTRY, GIVEN_NAME, 'Sarah', '', NOW);
      const id = profile.held[0]!.id;
      profile = recordDisclosure(profile, {
        origin: 'https://payroll-a.example', name: 'Payroll A', rdns: 'a',
      }, 3, {
        at: NOW,
        /* The kind, demanded by the writer's type. This test is about the
         * CHANGED-VALUE notice and its ask was a disclosure, as it always was. */
        kind: 'disclosure' as const,
        nonce: 'n1',
        sent: [{
          id,
          about: GIVEN_NAME,
          says: { of: 'value', value: 'Sarah' },
          asserted: { by: 'self', formerly: null },
        }],
        declined: [],
        /* §5.5's field. This test is about the CHANGED-VALUE notice, not about
         * the bytes; a real one is checked in `disclosure.test.ts`. */
        signed: {
          bytes: 'AAAA',
          signature: '00'.repeat(64),
          verifyingKey: '00'.repeat(32),
          scheme: 'schnorr' as const,
        },
      }, NOW);
      profile = editValue(profile, REGISTRY, id, 'Sara', NOW + 1);
      await save(port, identity, profile);
      await show();

      const notice = await waitFor(() => {
        const found = document.querySelector('[data-stale]');
        if (!found) throw new Error('waiting');
        return found;
      });
      expect(notice.textContent).toContain('Payroll A');
      expect(notice.textContent).toContain('Sarah');
      expect(notice.textContent).toContain('Sara');
      expect(document.body.textContent).toContain('cannot update them');
    });
});

describe('§3.1 — self-asserted and issued never look alike', () => {
  const registry = registryOf([...REGISTRY.all, define({
    name: 'a-checked-name',
    version: 1,
    source: 'stated',
    validate: { of: 'text', minLength: 1, maxLength: 60 },
    selfAssertable: true,
    acceptedIssuers: 'any',
    multiple: false,
    sensitivity: 'ordinary',
    render: { label: 'A checked name', hint: '', abbreviate: 'none' },
    provable: [],
  })]);

  it('an issued record carries its DATE, and a self-asserted one says nobody checked it',
    async () => {
      let profile = selfAssert(emptyProfile(NOW), registry, GIVEN_NAME, 'Sarah', '', NOW);
      profile = recordIssued(profile, registry, 'a-checked-name',
        { of: 'value', value: 'Sarah Jones' }, '', {
          by: 'issuer',
          issuer: 'a-registrar',
          signature: 'ab',
          issuedAt: Date.UTC(2026, 6, 4),
          expiresAt: null,
          reachableAt: null,
        }, NOW);
      await save(port, identity, profile);
      render(<ProfileScreen identity={identity} registry={registry} port={port} />);
      await screen.findByText('Sarah Jones');

      const issuedMark = document.querySelector(
        '[data-about="a-checked-name"] [data-provenance="issuer"]');
      expect(issuedMark?.textContent).toContain('2026-07-04');
      expect(document.querySelector('[data-about="given-name"] [data-provenance="self"]')
        ?.textContent).toContain('Nobody has checked it');
    });

  it('and changing a SELF-ASSERTED one warns about NOTHING — there is no check to lose',
    async () => {
      /* The survivor this closes. A warning that a check will be lost, shown
       * over a value nobody ever checked, is the same lie as the mark itself
       * — it implies a provenance that was never there. */
      const profile = selfAssert(emptyProfile(NOW), REGISTRY, GIVEN_NAME, 'Sarah', '', NOW);
      await save(port, identity, profile);
      await show();
      fireEvent.click(screen.getByText('Change this first name'));
      expect(document.querySelector('[data-warn="drops-to-self"]')).toBeNull();
    });

  it('changing an issued value WARNS that the check goes with it', async () => {
    const profile = recordIssued(emptyProfile(NOW), registry, 'a-checked-name',
      { of: 'value', value: 'Sarah Jones' }, '', {
        by: 'issuer',
        issuer: 'a-registrar',
        signature: 'ab',
        issuedAt: NOW,
        expiresAt: null,
        reachableAt: null,
      }, NOW);
    await save(port, identity, profile);
    render(<ProfileScreen identity={identity} registry={registry} port={port} />);
    await screen.findByText('Sarah Jones');
    fireEvent.click(screen.getByText('Change this a checked name'));
    expect(document.querySelector('[data-warn="drops-to-self"]')?.textContent)
      .toContain('no longer something they vouched for');
  });
});

describe('the form reads the registry and refuses in the definition\'s own words', () => {
  it('a bad email is refused with the entry\'s own sentence', async () => {
    await show();
    fireEvent.change(screen.getByLabelText('New email'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByText('Add email'));
    expect(await screen.findByText('An email address looks like name@example.com.')).toBeTruthy();
  });

  it('an attribute that holds several offers to add another; one that holds one does not',
    async () => {
      await show();
      fireEvent.change(screen.getByLabelText('New email'),
        { target: { value: 'sarah@work.example' } });
      fireEvent.click(screen.getByText('Add email'));
      await screen.findByText('s…h@work.example');
      /* `multiple: true`, so the field is still there for a second one. */
      expect(document.querySelector(`[data-add="${EMAIL}"]`)).not.toBeNull();
    });
});

describe('a record that will not open is SHOWN, never started again over', () => {
  it('the screen says so, offers no fresh start, and nothing is written', async () => {
    await save(port, identityFromSecret(newSecret()),
      selfAssert(emptyProfile(NOW), REGISTRY, GIVEN_NAME, 'Somebody', '', NOW));
    const before = port.getItem('midnight-identity:profile');
    render(<ProfileScreen identity={identity} port={port} />);
    await screen.findByText('There are details here that this account cannot open');
    expect(document.body.textContent).toContain('Nothing has been changed or deleted');
    /* No form at all — a form here would be the door to overwriting it. */
    expect(document.querySelector('[data-add]')).toBeNull();
    expect(port.getItem('midnight-identity:profile')).toBe(before);
  });
});

describe('the record groups for reading, and grouping NEVER DROPS AN EVENT', () => {
  const recipient = {
    origin: 'https://payroll-a.example', name: 'Payroll A', rdns: 'a',
  };
  const signedNothing = {
    bytes: 'AAAA',
    signature: '00'.repeat(64),
    verifyingKey: '00'.repeat(32),
    scheme: 'schnorr' as const,
  };
  const DAY = 86_400_000;

  it('EIGHTEEN CONSECUTIVE SIGN-INS ARE ONE LINE AND ALL EIGHTEEN ARE STILL IN IT',
    async () => {
      /*
       * Eighteen identical lines running down the page is a wall, and nobody
       * reads the eighteenth — so nobody notices the nineteenth is a send.
       * **A RECORD MAY BE SUMMARISED AND MAY NEVER BE SHORTENED.** Both halves
       * are asserted below: the run is one line that says how many and over
       * what span, AND every one of the eighteen is still in the document.
       */
      let profile = selfAssert(emptyProfile(NOW), REGISTRY, GIVEN_NAME, 'Sarah', '', NOW);
      const id = profile.held[0]!.id;
      for (let i = 0; i < 18; i += 1) {
        profile = recordDisclosure(profile, recipient, 3, {
          at: NOW + i * DAY,
          kind: 'sign-in' as const,
          nonce: `s${i}`,
          sent: [],
          declined: [],
          signed: signedNothing,
        }, NOW + i * DAY);
      }
      /* A SEND IS A DIFFERENT EVENT AND MUST NOT JOIN THE RUN — the rule,
       * falling out of the grouping rather than bolted onto it. */
      profile = recordDisclosure(profile, recipient, 3, {
        at: NOW + 18 * DAY,
        kind: 'disclosure' as const,
        nonce: 'd1',
        sent: [{
          id,
          about: GIVEN_NAME,
          says: { of: 'value', value: 'Sarah' },
          asserted: { by: 'self', formerly: null },
        }],
        declined: [],
        signed: signedNothing,
      }, NOW + 18 * DAY);
      await save(port, identity, profile);
      await show();

      const run = await waitFor(() => {
        const found = document.querySelector('[data-entries="18"]');
        if (!found) throw new Error('waiting');
        return found;
      });
      const summary = run.querySelector('summary')?.textContent ?? '';
      expect(summary).toContain('you signed in 18 times');
      expect(summary).toContain('Between ');
      expect(summary).toContain('Nothing about you was sent.');

      /* NOT DROPPED. Every event, with its own date, inside the run. */
      expect(run.querySelectorAll('[data-run-entries] > li')).toHaveLength(18);
      expect(document.querySelectorAll('[data-sign-in-entry]')).toHaveLength(18);

      /* AND THE SEND IS ITS OWN LINE. */
      const alone = document.querySelectorAll('[data-entries="1"]');
      expect(alone).toHaveLength(1);
      expect(alone[0]?.textContent).toContain('you sent: Sarah');
    });
});

describe('the history names WHICH KIND of ask each entry was', () => {
  it('A SIGN-IN IS NOT SHOWN AS A DISCLOSURE THAT SENT NOTHING', async () => {
    /*
     * Both are real and both are normal: *you signed in* and *you were asked
     * for things and sent none of them*. They are different events and this
     * screen is the one place a person reads them back, so telling them the
     * second when it was the first is a false statement about the one subject
     * the record exists to be true about (§3.2b).
     */
    const recipient = {
      origin: 'https://payroll-a.example', name: 'Payroll A', rdns: 'a',
    };
    const signedNothing = {
      bytes: 'AAAA',
      signature: '00'.repeat(64),
      verifyingKey: '00'.repeat(32),
      scheme: 'schnorr' as const,
    };
    let profile = selfAssert(emptyProfile(NOW), REGISTRY, GIVEN_NAME, 'Sarah', '', NOW);
    profile = recordDisclosure(profile, recipient, 3, {
      at: NOW,
      kind: 'sign-in' as const,
      nonce: 'n1',
      sent: [],
      declined: [],
      signed: signedNothing,
    }, NOW);
    profile = recordDisclosure(profile, recipient, 3, {
      at: NOW + 1,
      kind: 'disclosure' as const,
      nonce: 'n2',
      sent: [],
      declined: [GIVEN_NAME],
      signed: signedNothing,
    }, NOW + 1);
    await save(port, identity, profile);
    await show();

    const entry = await waitFor(() => {
      const found = document.querySelector('[data-sign-in-entry]');
      if (!found) throw new Error('waiting');
      return found;
    });
    expect(entry.textContent).toContain('you signed in');
    expect(entry.textContent).not.toContain('you sent');
    /* The disclosure beside it still reads exactly as it did. */
    expect(document.body.textContent).toContain('you sent: nothing');
    expect(document.querySelectorAll('[data-sign-in-entry]')).toHaveLength(1);
  });
});
