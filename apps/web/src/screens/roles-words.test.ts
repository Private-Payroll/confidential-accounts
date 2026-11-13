import { describe, expect, it } from 'vitest';
import { whatAChangeCosts } from '../../../../src/core/change-costs.js';
import { ENGLISH } from '../english.test-support.js';

/*
 * WHAT THE ROLES PAGE AND THE INVITE FORM MAY NOT SAY ABOUT RIGHTS AND HOLDS: a change of who holds a seat is public, so no word says
 * a change of rights is invisible, and a hold is kept and released by seat, so no word says it is a person's or that it can always be
 * released. Read over every word of the page and every word of the invite form, in English.
 */
const OWN = Object.entries(ENGLISH).filter(([key]) => key.startsWith('roles.') || key.startsWith('invite.') || key.startsWith('page.settingsRoles.'));

describe('the words about rights and holds', () => {
  /* RED WHEN: the page has no words of its own, so the rules below read nothing. */
  it('reads the page\'s words and the invite form\'s', () => {
    expect(OWN.filter(([key]) => key.startsWith('roles.')).length).toBeGreaterThan(20);
    expect(OWN.filter(([key]) => key.startsWith('invite.role.')).length).toBeGreaterThan(5);
  });

  /* RED WHEN: a word says a change of rights, of a role or of a seat is invisible, hidden or private. */
  it('says no change of rights is invisible', () => {
    const says = OWN.filter(([, text]) => /(?:invisible|unseen|hidden|not shown|nobody can see|no one can see|cannot be seen)/iu.test(text)
      && /(?:right|role|seat|signer)/iu.test(text));
    expect(says.map(([key]) => key)).toEqual([]);
  });

  /* RED WHEN: a word says a hold is a person's, or that a hold can always be released. */
  it('says no hold is per person and none can always be released', () => {
    const says = OWN.filter(([, text]) => /\b(?:hold|holds|held)\b/iu.test(text)
      && /(?:per person|each person|a person's hold|can always be released|always be released|always released)/iu.test(text));
    expect(says.map(([key]) => key)).toEqual([]);
  });

  /* RED WHEN: the words about a role change leave out that a seat leaving and a seat joining are public, or say it of a fact the change does not make public. */
  it('says a role change makes a seat leaving and a seat joining public, as a change of who is seated does', () => {
    const held = { approvals: 2, vaultThresholds: [], policyBar: null, seatBar: 2, seated: 3 };
    expect(whatAChangeCosts(held, { kind: 'seating', seat: 'remove' }).publicFacts).toContainEqual({ fact: 'a-seat-leaves' });
    expect(whatAChangeCosts(held, { kind: 'seating', seat: 'add' }).publicFacts).toContainEqual({ fact: 'a-seat-joins' });
    const says = ENGLISH['roles.change.public']!;
    expect(says).toMatch(/seat leaving/u);
    expect(says).toMatch(/seat joining/u);
    expect(says).toMatch(/public/u);
  });

  /* RED WHEN: a word says the seat that placed a hold always releases it at once, leaves out that a removed or re-roled seat loses that, or leaves out when a run can be held. */
  it('says only the placing seat releases a hold at once, and what changes that', () => {
    const says = ENGLISH['roles.may.hold']!;
    expect(says).toMatch(/\bOnly the seat that placed the hold releases it at once\./u);
    expect(says).toMatch(/removed or given another role/u);
    expect(says).toMatch(/as many signers as it needed, counted again after each removal/u);
    expect(says).toMatch(/not been charged or paid yet, once, on the vaults the seat is given/u);
    const heldWords = OWN.filter(([, text]) => /\bhold\b/iu.test(text) && /releases? it at once/iu.test(text));
    expect(heldWords.length).toBeGreaterThan(0);
    for (const [key, text] of heldWords) {
      expect(text, key).not.toMatch(/\balways\b/iu);
      expect(text, key).toMatch(/\bOnly the seat that placed the hold releases it at once\b/u);
      expect(text, key).toMatch(/removed or given another role/u);
    }
  });

  /* RED WHEN: taking a reader away is told as closing what they never opened, or as a key change that cannot fail. */
  it('says a reader taken away keeps what their access covered, opened or not, and that the key change can fail', () => {
    const says = ENGLISH['roles.reader.takeAway.says']!;
    expect(says).toMatch(/everything their access covered before that, opened or not/u);
    expect(says).toMatch(/your wallet says so/u);
    expect(says).not.toMatch(/nothing sealed after it|already opened stays/iu);
  });

  /* RED WHEN: giving access is told without that a reader reads the older records and that the company's service is told their name. */
  it('says a new reader reads the older records and that the service is told who they are', () => {
    const says = ENGLISH['roles.give.description']!;
    expect(says).toMatch(/older records of what they read, as well as new ones/u);
    expect(says).toMatch(/service is told their name/u);
  });

  /* RED WHEN: a role change is told without that the person comes back on every vault, or the empty readers list claims nobody but the signers reads. */
  it('says a role change invites again on every vault, and claims no more of who reads than the grants show', () => {
    expect(ENGLISH['roles.change.description']).toMatch(/invited again on every vault, so a seat that held only named vaults comes back on all of them/u);
    expect(ENGLISH['roles.readers.none']).toMatch(/^No reader has been given read access/u);
    expect(ENGLISH['roles.readers.none']).not.toMatch(/nobody|but its signers/iu);
  });
});
