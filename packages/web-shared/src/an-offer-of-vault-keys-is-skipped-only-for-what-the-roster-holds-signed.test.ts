/**
 * **A SEAT'S DEVICE OFFERS ITS VAULT KEYS AGAIN UNLESS THE ROSTER ALREADY HOLDS EXACTLY WHAT IT WOULD OFFER, SIGNED.**
 *
 * Each signing makes new signature bytes over the same content, so offering what the roster holds would only file a
 * roster version that changes nothing. But what is held is skipped only when its records-key statement verifies for
 * this company and account under the committee key held, and every field the offer carries is the same: a statement
 * another seat filed wrong, a new seat, a new committee key or records key, or a changed entry is offered again, so the
 * seat's own press repairs the roster.
 */
import { describe, expect, it } from 'vitest';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { identityFromWords } from 'midnight-identity';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { signRecordsKey } from 'midnight-identity/profile/records-key';
import { offerAlreadyHeld, type HeldForTheSeat } from './vault-keys-given.js';

const CO = 'co_1f2e3d4c5b6a79880a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6071' as CompanyLabel;
const ACCOUNT = 'dbe119a304f8e7ea882353435c1d536cf2faf4298236a9aae77670e750af65c8' as AccountAddress;
const SEAT = '5a'.repeat(32);
const identity = identityFromWords(TEST_MNEMONIC);
const committeeKey = committeeKeyFor(identity, CO) as { tag: string; value: string };
const recordsKey = signRecordsKey(identity, CO, ACCOUNT, new Uint8Array(32).fill(7), SEAT);
const entry = { account: ACCOUNT as string, signingKey: '11'.repeat(32), wrappingKey: recordsKey.recordsKey, seat: SEAT, signature: '22'.repeat(64) };
const offer = { committeeKey, recordsKey, entry };
const company = { label: CO, account: ACCOUNT };

/** What the roster holds for the seat when it holds exactly what is offered, with `change` applied. */
const heldAs = (change: (h: { keys: Record<string, unknown>; entry: Record<string, unknown>; committee: Record<string, unknown> }) => void = () => {}): HeldForTheSeat => {
  const h = {
    keys: { committeeKey: { ...committeeKey }, recordsKey: recordsKey.recordsKey, signature: '33'.repeat(64), recordsKeyStatement: recordsKey.signature, recordsKeySeat: SEAT },
    entry: { ...entry },
    committee: { ...committeeKey },
  };
  change(h);
  return { vaultKeys: h.keys as never, directoryEntry: { committeeKey: h.committee, statement: h.entry } as never };
};

describe('AN OFFER OF VAULT KEYS IS SKIPPED ONLY FOR WHAT THE ROSTER HOLDS, SIGNED', () => {
  it('skips an offer of exactly what the roster holds, its statement verifying', () => {
    expect(offerAlreadyHeld(heldAs(), offer, company)).toBe(true);
  });
  it('offers again where another seat filed the seat\'s statement wrong, or none, so the seat repairs it', () => {
    /* RED WHEN: a held statement is believed without checking it verifies, so the seat whose statement is wrong is left out of every re-seal and its own press reports done. */
    expect(offerAlreadyHeld(heldAs((h) => { h.keys['recordsKeyStatement'] = '00'.repeat(64); }), offer, company)).toBe(false);
    expect(offerAlreadyHeld(heldAs((h) => { h.keys['recordsKeyStatement'] = null; }), offer, company)).toBe(false);
    expect(offerAlreadyHeld(heldAs(), offer, { label: CO, account: '00'.repeat(32) as AccountAddress })).toBe(false);
  });
  it('offers again for a new seat, committee key or records key, and for any field of the entry changed', () => {
    /* RED WHEN: a field of what is offered is not compared, so a re-seated signer or a key change is never offered. */
    expect(offerAlreadyHeld(heldAs((h) => { h.keys['recordsKeySeat'] = '6b'.repeat(32); }), offer, company)).toBe(false);
    expect(offerAlreadyHeld(heldAs((h) => { h.keys['recordsKey'] = '44'.repeat(32); }), offer, company)).toBe(false);
    expect(offerAlreadyHeld(heldAs((h) => { h.keys['committeeKey'] = { tag: 'schnorr', value: '55'.repeat(32) }; }), offer, company)).toBe(false);
    expect(offerAlreadyHeld(heldAs((h) => { h.committee['value'] = '55'.repeat(32); }), offer, company)).toBe(false);
    for (const k of ['account', 'signingKey', 'wrappingKey', 'seat'] as const) {
      expect(offerAlreadyHeld(heldAs((h) => { h.entry[k] = '66'.repeat(32); }), offer, company), k).toBe(false);
    }
  });
  it('offers when the roster holds no keys or no entry for the seat', () => {
    expect(offerAlreadyHeld(undefined, offer, company)).toBe(false);
    expect(offerAlreadyHeld({ vaultKeys: null, directoryEntry: heldAs().directoryEntry } as HeldForTheSeat, offer, company)).toBe(false);
  });
});
