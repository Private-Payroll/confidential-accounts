// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Buffer as PolyfillBuffer } from 'buffer/';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { identityFromWords, secretFromWords } from '../keys/derivation.js';
import { REGISTRY, registryOf } from './attributes.js';
import { define } from './definition.js';
import type { AttributeDefinition } from './definition.js';
import { emptyProfile, recordIssued, selfAssert } from './model.js';
import { save } from './store.js';
import type { Port } from './store.js';
import { verify } from './disclosure.js';
import { ProfileScreen } from '../../../../apps/wallet/src/screens/profile.js';
import { Approve } from '../../../../apps/wallet/src/screens/approve.js';
import type { ChannelWindow } from './channel.js';

/**
 * **§3.4's CLAIM, PROVED THE WAY THIS PROJECT PROVES THINGS.**
 *
 * *Adding an attribute is adding an entry. If adding one requires touching a
 * `switch`, an `if`, a form component, or the approval screen, the registry is
 * not doing its job.* Decided 21 Aug, and the design asks for it to be shown
 * rather than asserted — with a throwaway attribute that has an awkward rule,
 * **and an ISSUED one, so the issuer path is exercised before any issuer
 * exists** (§9).
 *
 * **WHAT MAKES THIS A PROOF AND NOT A DEMONSTRATION.** The registry below is
 * built HERE, in this file, and handed to the two real screens as a prop. Not
 * one line of `screens/profile.tsx`, `screens/approve.tsx`, `definition.ts`,
 * `model.ts`, `payload.ts` or `disclosure.ts` mentions this attribute, knows it
 * exists, or was changed to make the tests below pass. Everything it does — a
 * form field of the right shape, a validation message in its own words, a
 * refusal to let a person type it, an approval row, a signed disclosure — comes
 * out of the entry.
 *
 * **THE AWKWARD RULE IS DELIBERATE.** `sanctions-status` is an ENUM (a kind no
 * shipped attribute uses), is `selfAssertable: false` (no shipped attribute
 * is), accepts exactly one issuer (no shipped attribute accepts any), is
 * `sensitivity: 'sensitive'` (no shipped attribute is), abbreviates in the
 * MIDDLE (no shipped attribute does), and carries a `provable` predicate. Every
 * one of those is a path the three shipped attributes never take.
 */

const THROWAWAY: AttributeDefinition = define({
  name: 'sanctions-status',
  version: 1,
  source: 'stated',
  validate: {
    of: 'enum',
    members: [
      { value: 'not-listed', label: 'Not on any list' },
      { value: 'listed', label: 'On a list' },
      { value: 'inconclusive', label: 'Could not be determined' },
    ],
  },
  selfAssertable: false,
  acceptedIssuers: ['a-checking-service'],
  multiple: false,
  sensitivity: 'sensitive',
  render: {
    label: 'Sanctions status',
    hint: 'Whether a check found you on a sanctions list. Only a checker can say this.',
    abbreviate: 'middle',
  },
  provable: ['not-listed'],
});

const EXTENDED = registryOf([...REGISTRY.all, THROWAWAY]);

/* The address-format codec runs on a Buffer, and jsdom has none — the same
 * two lines `balance.test.tsx` already carries, for the same reason. */
(globalThis as { Buffer?: unknown }).Buffer = PolyfillBuffer;

const NOW = 1_755_000_000_000;
const identity = identityFromWords(TEST_MNEMONIC);

const SECRET = secretFromWords(TEST_MNEMONIC);

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

const issued = (expiresAt: number | null) => ({
  by: 'issuer' as const,
  issuer: 'a-checking-service',
  signature: 'ab12',
  issuedAt: NOW - 86_400_000,
  expiresAt,
  reachableAt: 'https://a-checking-service.example/again',
});

describe('the shipped registry does not know it, and that is the baseline', () => {
  it('nothing outside this file has heard of it', () => {
    expect(REGISTRY.knows('sanctions-status')).toBe(false);
    expect(EXTENDED.knows('sanctions-status')).toBe(true);
    expect(EXTENDED.all).toHaveLength(REGISTRY.all.length + 1);
  });
});

describe('the FORM gets it right with no line changed in the form', () => {
  it('shows the entry\'s own label and hint', async () => {
    render(<ProfileScreen identity={identity} registry={EXTENDED} port={port} />);
    await screen.findByText('Sanctions status');
    expect(screen.getByText(
      'Whether a check found you on a sanctions list. Only a checker can say this.'))
      .toBeTruthy();
  });

  it('OFFERS NO FIELD, because the entry says a person may not state it', async () => {
    render(<ProfileScreen identity={identity} registry={EXTENDED} port={port} />);
    await screen.findByText('Sanctions status');
    /* The form has no idea WHY. It reads `selfAssertable`. */
    expect(document.querySelector('[data-add="sanctions-status"]')).toBeNull();
    expect(document.querySelector('[data-issued-only="sanctions-status"]')).not.toBeNull();
    /* And the shipped ones, which ARE self-assertable, still have theirs. */
    expect(document.querySelector('[data-add="given-name"]')).not.toBeNull();
  });

  it('a shipped attribute still renders a TEXT field and an enum would render a select',
    async () => {
      /* The one `switch` in the form is on the RULE'S KIND, which is the cost
       * `definition.ts` names. Adding an attribute adds no arm to it; this is
       * that arm working for an entry it has never seen. */
      const selfAssertableEnum = registryOf([...REGISTRY.all, define({
        ...THROWAWAY,
        name: 'a-self-enum',
        selfAssertable: true,
        render: { label: 'A self enum', hint: '', abbreviate: 'none' },
      })]);
      render(<ProfileScreen identity={identity} registry={selfAssertableEnum} port={port} />);
      await waitFor(() => {
        if (!document.querySelector('[data-add="a-self-enum"]')) throw new Error('waiting');
      });
      expect(document.querySelector('[data-add="a-self-enum"] [data-kind="enum"]')).not.toBeNull();
      expect(document.querySelector('[data-add="given-name"] [data-kind="text"]')).not.toBeNull();
    });
});

describe('the ISSUER path, exercised before any issuer exists', () => {
  it('a CLAIM about it is held, with no value invented for the attribute', async () => {
    const profile = recordIssued(
      emptyProfile(NOW), EXTENDED, 'sanctions-status',
      { of: 'predicate', predicate: 'not-listed', result: true }, '',
      issued(NOW + 30 * 86_400_000), NOW);
    await save(port, identity, profile);
    render(<ProfileScreen identity={identity} registry={EXTENDED} port={port} />);

    await screen.findByText('not-listed: yes');
    /* §3.1 — an issued record NEVER appears without its date. */
    const mark = document.querySelector('[data-about="sanctions-status"] [data-provenance="issuer"]');
    expect(mark?.textContent).toContain('a-checking-service');
    expect(mark?.textContent).toContain('2025-08-11');
    /* §4 — where to ask again, so decision 4 does not mean losing it for good. */
    expect(screen.getByText('https://a-checking-service.example/again')).toBeTruthy();
  });

  it('AND IT LOOKS NOTHING LIKE A SELF-ASSERTED ONE — §3.1', async () => {
    let profile = recordIssued(
      emptyProfile(NOW), EXTENDED, 'sanctions-status',
      { of: 'predicate', predicate: 'not-listed', result: true }, '', issued(null), NOW);
    profile = selfAssert(profile, EXTENDED, 'given-name', 'Sarah', '', NOW);
    await save(port, identity, profile);
    render(<ProfileScreen identity={identity} registry={EXTENDED} port={port} />);

    await screen.findByText('Sarah');
    const self = document.querySelector('[data-about="given-name"] [data-provenance]');
    const other = document.querySelector('[data-about="sanctions-status"] [data-provenance]');
    expect(self?.getAttribute('data-provenance')).toBe('self');
    expect(other?.getAttribute('data-provenance')).toBe('issuer');
    expect(self?.textContent).toContain('Nobody has checked it');
  });

  it('a claim cannot be edited, and the screen says why', async () => {
    const profile = recordIssued(
      emptyProfile(NOW), EXTENDED, 'sanctions-status',
      { of: 'predicate', predicate: 'not-listed', result: true }, '', issued(null), NOW);
    await save(port, identity, profile);
    render(<ProfileScreen identity={identity} registry={EXTENDED} port={port} />);
    await screen.findByText('not-listed: yes');
    expect(screen.getByText(/There is no text in it to change/u)).toBeTruthy();
  });
});

describe('the APPROVAL SCREEN gets it right with no line changed in the approval screen',
  () => {
    const wire = (attribute: string) => ({
      schema: 'midnight-identity/disclosure-request/v1',
      requester: { name: 'Payroll A', rdns: 'example.payroll-a' },
      purpose: 'To pay you.',
      wants: [{ attribute, required: true, reason: 'Our regulator makes us.' }],
      nonce: 'n1',
      expiresAt: NOW + 600_000,
    });

    const openWith = (data: unknown, registry = EXTENDED) => {
      const sent: { message: unknown; target: string }[] = [];
      const opener = {
        postMessage: (message: unknown, target: string) => { sent.push({ message, target }); },
      };
      const handlers: ((event: MessageEvent) => void)[] = [];
      const view: ChannelWindow = {
        opener: opener as ChannelWindow['opener'],
        addEventListener: (_t, h) => { handlers.push(h); },
        removeEventListener: () => { /* torn down by cleanup */ },
      };
      render(
        <Approve
          identity={identity}
          secret={SECRET}
          registry={registry}
          port={port}
          view={view}
          now={() => NOW}
        />);
      for (const h of handlers) {
        h({ source: opener, origin: 'https://payroll-a.example', data } as unknown as MessageEvent);
      }
      return sent;
    };

    it('renders a row for it, labelled and marked sensitive, from the entry alone', async () => {
      const profile = recordIssued(
        emptyProfile(NOW), EXTENDED, 'sanctions-status',
        { of: 'predicate', predicate: 'not-listed', result: true }, '', issued(null), NOW);
      await save(port, identity, profile);
      openWith(wire('sanctions-status'));
      const row = await waitFor(() => {
        const found = document.querySelector('[data-row="sanctions-status"]');
        if (!found) throw new Error('no row yet');
        return found;
      });
      expect(row.getAttribute('data-sensitivity')).toBe('sensitive');
      expect(row.getAttribute('data-required')).toBe('yes');
      expect(row.textContent).toContain('Sanctions status');
      expect(row.textContent).toContain('Our regulator makes us.');
    });

    it('OFFERS NO WAY TO TYPE IT IN, because the entry says so', async () => {
      openWith(wire('sanctions-status'));
      await waitFor(() => {
        if (!document.querySelector('[data-row="sanctions-status"]')) throw new Error('waiting');
      });
      expect(document.querySelector('[data-fill="sanctions-status"]')).toBeNull();
      expect(screen.getByText(/not something you can state about yourself/u)).toBeTruthy();
    });

    it('THE WHOLE WAY THROUGH: the claim is chosen, signed, and VERIFIES', async () => {
      const profile = recordIssued(
        emptyProfile(NOW), EXTENDED, 'sanctions-status',
        { of: 'predicate', predicate: 'not-listed', result: true }, '',
        issued(NOW + 30 * 86_400_000), NOW);
      await save(port, identity, profile);
      const sent = openWith(wire('sanctions-status'));

      const option = await waitFor(() => {
        const found = document.querySelector<HTMLInputElement>(
          '[data-row="sanctions-status"] [data-option] input');
        if (!found) throw new Error('no option yet');
        return found;
      });
      fireEvent.click(option);
      /* The button is written in the OBSERVED origin's words now. The
       * same button, found where it is. */
      fireEvent.click(screen.getByText('Send these to https://payroll-a.example'));

      await waitFor(() => {
        if (sent.length < 2) throw new Error('nothing answered yet');
      });
      const response = sent[sent.length - 1]!;
      expect(response.target).toBe('https://payroll-a.example');

      const body = response.message as Parameters<typeof verify>[0];
      /* The claim crossed as a PREDICATE, with its issuer and its date, and
       * with no value invented for the attribute it is about. */
      expect(body.payload.disclosed).toHaveLength(1);
      expect(body.payload.disclosed[0]!.about).toBe('sanctions-status');
      expect(body.payload.disclosed[0]!.says)
        .toEqual({ of: 'predicate', predicate: 'not-listed', result: true });
      expect(body.payload.disclosed[0]!.asserted).toMatchObject({
        by: 'issuer', issuer: 'a-checking-service',
      });

      /* And the recipient's own check passes — the same function the payroll
       * product will run. */
      expect(verify(body, {
        atOrigin: 'https://payroll-a.example',
        expectingNonce: 'n1',
        payingAddress: body.payload.address,
        networkId: 'stagenet',
        now: NOW,
      })).toEqual({ ok: true });

      /* AND IS REFUSED AT A SECOND RECIPIENT. */
      expect(verify(body, {
        atOrigin: 'https://payroll-b.example',
        expectingNonce: 'n1',
        payingAddress: body.payload.address,
        networkId: 'stagenet',
        now: NOW,
      })).toMatchObject({ ok: false, code: 'origin-mismatch' });
    });

    it('the SHIPPED registry shows the same name as unknown, and invents nothing',
      async () => {
        /* The other half of §3.4: an application asking for a name our
         * vocabulary does not know gets a row that says so. It is not dropped
         * — a request asking for one thing and a screen showing none is a
         * screen lying about what was asked — and it does not become an
         * attribute. */
        openWith(wire('sanctions-status'), REGISTRY);
        const row = await waitFor(() => {
          const found = document.querySelector('[data-row="sanctions-status"]');
          if (!found) throw new Error('no row yet');
          return found;
        });
        expect(row.hasAttribute('data-unknown')).toBe(true);
        expect(row.textContent).toContain('will not invent it');
        expect(REGISTRY.knows('sanctions-status')).toBe(false);
      });
  });
