import { describe, expect, it } from 'vitest';
import * as L from '@midnightntwrk/ledger-v9';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { identityFromSecret } from '../keys/derivation.js';
import { committeeKeyFor, committeeSigningKeyFor } from './committee-key.js';
import type { AccountAddress, CompanyLabel } from './company-label.js';
import { MOST_ENTRIES_ASKED, parseAsk, type HoldersRequest, type RecordsKeyRequest } from './request.js';
import { unlockKeyFor } from './unlock.js';
import type { UnlockRequest } from './request.js';
import {
  DIRECTORY_ENTRY_STATEMENT_TAG, HOLDERS_ANSWER_SCHEMA, RECORDS_KEY_ANSWER_SCHEMA, RECORDS_KEY_STATEMENT_TAG, RecordsKeyRefused,
  INVITATION_REFUSAL, directoryEntrySignedBy, directoryEntryStatementBytes, whyTheInvitationDoesNotNameIt, holdersAnswerFor, readHoldersAnswer, readRecordsKeyAnswer, recordsKeyAnswerFor,
  recordsKeySignedBy, recordsKeyStatementBytes, recordsPublicKeyOf, signDirectoryEntry, signRecordsKey,
} from './records-key.js';

/*
 * A signer's records key and seat, signed by their wallet with the committee
 * key the chain lists for them, and checked by anybody holding the statement,
 * the committee key and the company's label.
 */
const me = identityFromSecret(new Uint8Array(32).fill(3));
const somebodyElse = identityFromSecret(new Uint8Array(32).fill(9));
const CO = `co_${'c1'.repeat(32)}` as CompanyLabel;
const OTHER_CO = `co_${'d2'.repeat(32)}` as CompanyLabel;
const ACCOUNT = 'a7'.repeat(32) as AccountAddress;
const SEAT = '5e'.repeat(32);
const ANOTHER_SEAT = '6f'.repeat(32);
const companyKey = new Uint8Array(32).fill(4);
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const flip = (h: string, at = 0): string => h.slice(0, at) + (h[at] === '0' ? '1' : '0') + h.slice(at + 1);

describe('A RECORDS KEY AND A SEAT, SIGNED BY THE WALLET WITH THE COMMITTEE KEY', () => {
  const statement = signRecordsKey(me, CO, ACCOUNT, companyKey, SEAT);
  const mine = committeeKeyFor(me, CO);

  it('signs the records key the company key opens, worked out in the records\' own domain', () => {
    /* RED WHEN: the key signed for is derived any other way than the company's records are sealed to it. */
    const secret = hkdf(sha256, companyKey, new TextEncoder().encode('confidential-accounts/company-records-wrapping/v1'), new Uint8Array(0), 32);
    expect(statement.recordsKey).toBe(hex(x25519.getPublicKey(secret)));
    expect(recordsPublicKeyOf(companyKey)).toBe(statement.recordsKey);
    expect(statement.seat).toBe(SEAT);
    /* RED WHEN: a company key of zeros or of the wrong width yields a key. */
    expect(() => recordsPublicKeyOf(new Uint8Array(32))).toThrow(/Nothing was derived/);
    expect(() => recordsPublicKeyOf(new Uint8Array(31).fill(1))).toThrow(/Nothing was derived/);
  });

  it('checks against the signer\'s committee key for that company, and against nothing else', () => {
    /* RED WHEN: the check passes nothing, or the signing key is not the committee key. */
    expect(recordsKeySignedBy(CO, ACCOUNT, mine, statement)).toBe(true);
    /* RED WHEN: another person's committee key, or this person's for another company, passes. */
    expect(recordsKeySignedBy(CO, ACCOUNT, committeeKeyFor(somebodyElse, CO), statement)).toBe(false);
    expect(recordsKeySignedBy(CO, ACCOUNT, committeeKeyFor(me, OTHER_CO), statement)).toBe(false);
    /* RED WHEN: the label is not part of what is signed. */
    expect(recordsKeySignedBy(OTHER_CO, ACCOUNT, mine, statement)).toBe(false);
    /* RED WHEN: the records key is not part of what is signed - a key the service substitutes passes. */
    const substituted = recordsPublicKeyOf(new Uint8Array(32).fill(5));
    expect(recordsKeySignedBy(CO, ACCOUNT, mine, { ...statement, recordsKey: substituted })).toBe(false);
    /* RED WHEN: the seat is not part of what is signed - a statement from a seat somebody left passes for another. */
    expect(recordsKeySignedBy(CO, ACCOUNT, mine, { ...statement, seat: ANOTHER_SEAT })).toBe(false);
    /* RED WHEN: a signature with one bit changed passes. */
    expect(recordsKeySignedBy(CO, ACCOUNT, mine, { ...statement, signature: flip(statement.signature, 70) })).toBe(false);
  });

  it('never throws on what is not a statement, a committee key or a label', () => {
    expect(recordsKeySignedBy(CO, ACCOUNT, { tag: 'ecdsa', value: mine.value }, statement)).toBe(false);
    expect(recordsKeySignedBy(CO, ACCOUNT, { tag: 'schnorr', value: 'ab' }, statement)).toBe(false);
    expect(recordsKeySignedBy('co_nope' as CompanyLabel, ACCOUNT, mine, statement)).toBe(false);
    expect(recordsKeySignedBy(CO, ACCOUNT, mine, { ...statement, signature: 'zz' })).toBe(false);
    expect(recordsKeySignedBy(CO, ACCOUNT, mine, null as never)).toBe(false);
    expect(recordsKeySignedBy(CO, ACCOUNT, mine, { ...statement, recordsKey: statement.recordsKey.toUpperCase() })).toBe(false);
    expect(recordsKeySignedBy(CO, ACCOUNT, mine, { ...statement, seat: 'ab' })).toBe(false);
    expect(() => signRecordsKey(me, CO, ACCOUNT, companyKey, 'not a seat')).toThrow(/no records key was signed/);
  });

  it('IS NEVER A CHANGE TO A CONTRACT\'S RULES, AND NO SUCH CHANGE IS EVER A STATEMENT', () => {
    const bytes = recordsKeyStatementBytes(CO, ACCOUNT, statement.recordsKey, SEAT)!;
    const tag = new TextEncoder().encode(RECORDS_KEY_STATEMENT_TAG);
    /* RED WHEN: what is signed does not begin with the statement's own tag. */
    expect(hex(bytes.subarray(0, tag.length))).toBe(hex(tag));
    /* RED WHEN: the account is not among what is signed. */
    expect(bytes).toHaveLength(tag.length + 1 + CO.length + 1 + 32 + 32 + 32);
    expect(hex(bytes.subarray(tag.length + 1 + CO.length + 1, tag.length + 1 + CO.length + 1 + 32))).toBe(ACCOUNT);
    /* The ledger's own signatures are made a different way: it does not take the statement's as one of its own even over these bytes. */
    expect(L.verifySignature(mine as never, bytes, { tag: 'schnorr', value: statement.signature } as never)).toBe(false);
    /* A maintenance update this key would sign begins with the ledger's own tag, which is not the statement's. */
    const update = new L.MaintenanceUpdate(L.sampleContractAddress(), [
      new L.ReplaceAuthority(new L.ContractMaintenanceAuthority([mine as never], 1, 1n)) as never,
    ], 0n);
    const data = update.dataToSign;
    expect(hex(data.subarray(0, tag.length))).not.toBe(hex(tag));
    /* RED WHEN: the statement's signature would pass as the maintenance update's, or the reverse. */
    expect(L.verifySignature(mine as never, data, { tag: 'schnorr', value: statement.signature } as never)).toBe(false);
    const maintenance = L.signData(committeeSigningKeyFor(me, CO) as never, data) as unknown as { tag: string; value: string };
    expect(L.verifySignature(mine as never, data, maintenance as never)).toBe(true);
    expect(recordsKeySignedBy(CO, ACCOUNT, mine, { ...statement, signature: maintenance.value })).toBe(false);
  });
});

describe('THE RECORDS-KEY ASK: SIGNED ONLY FOR A SEAT THE ACCOUNT HOLDS NOW, AND READ BACK BY THE PAGE THAT ASKED', () => {
  const PAGE = 'https://payroll.example';
  const NOW = 1_755_000_000_000;
  const ask = (over: Record<string, unknown> = {}) => parseAsk({
    schema: 'midnight-identity/disclosure-request/v1', kind: 'records-key',
    requester: { name: 'Payroll', rdns: 'example.payroll' }, purpose: 'To check your records key.',
    nonce: 'r1', expiresAt: NOW + 60_000, company: CO, account: ACCOUNT, seat: SEAT, ...over,
  }, PAGE, NOW) as RecordsKeyRequest;
  const seats = { committee: [committeeKeyFor(me, CO) as { tag: string; value: string }], threshold: 1, seats: [ANOTHER_SEAT, SEAT] };
  const expecting = { atOrigin: PAGE, expectingNonce: 'r1', company: CO, account: ACCOUNT, seat: SEAT };

  it('SIGNS ONLY FOR THE ACCOUNT THIS WALLET PINNED FOR THE COMPANY WHEN IT CREATED IT, WHERE IT PINNED ONE', () => {
    /* RED WHEN: a wallet that pinned the company's account signs a records key or an entry for another account carrying the label. */
    expect(() => recordsKeyAnswerFor(me, ask({ signingKey: '3c'.repeat(32) }), seats, NOW, undefined, 'a8'.repeat(32) as AccountAddress))
      .toThrow(/other than the one this wallet kept as its account/);
    const answer = recordsKeyAnswerFor(me, ask({ signingKey: '3c'.repeat(32) }), seats, NOW, undefined, ACCOUNT);
    expect(recordsKeySignedBy(CO, ACCOUNT, answer.committeeKey, answer.statement)).toBe(true);
    expect(answer.entry?.account).toBe(ACCOUNT);
  });

  it('A WALLET THAT KEPT NO ACCOUNT SIGNS NOTHING; THE INVITATION IS ONLY READ, AND EACH WAY IT CAN BE WRONG IS SAID', () => {
    /* The inviting signer: their committee key and the entry their wallet signed, as the invitation carries them. */
    const INVITER_SEAT = '7a'.repeat(32);
    const inviterKey = committeeKeyFor(somebodyElse, CO) as { tag: 'schnorr'; value: string };
    const entry = signDirectoryEntry(somebodyElse, CO, ACCOUNT, new Uint8Array(32).fill(6), '2b'.repeat(32), INVITER_SEAT);
    const invitedBy = { committeeKey: inviterKey, statement: entry };
    const onChain = { committee: [...seats.committee, inviterKey], threshold: 1, seats: [...seats.seats, INVITER_SEAT] };
    /* An invitation that checks out still sets nothing: the person's fingerprint confirmation does, on the screen. */
    expect(whyTheInvitationDoesNotNameIt(ask({ invitedBy }), onChain)).toBeNull();
    /* RED WHEN: a wallet with no account kept signs for an account the page named, with or without an invitation. */
    expect(() => recordsKeyAnswerFor(me, ask({ invitedBy }), onChain, NOW)).toThrow(/Compare the company's fingerprint/);
    expect(() => recordsKeyAnswerFor(me, ask(), onChain, NOW)).toThrow(INVITATION_REFUSAL['no-invitation']);
    const signed = recordsKeyAnswerFor(me, ask({ invitedBy }), onChain, NOW, undefined, ACCOUNT);
    expect(recordsKeySignedBy(CO, ACCOUNT, signed.committeeKey, signed.statement)).toBe(true);
    for (const [why, bent, chain, code] of [
      ['an entry for another account', { ...invitedBy, statement: signDirectoryEntry(somebodyElse, CO, 'a8'.repeat(32) as AccountAddress, new Uint8Array(32).fill(6), '2b'.repeat(32), INVITER_SEAT) }, onChain, 'other-account'],
      ['an entry signed by a key it does not name', { ...invitedBy, committeeKey: committeeKeyFor(me, CO) as { tag: 'schnorr'; value: string } }, onChain, 'not-signed'],
      ['an inviter whose key is not on the account', invitedBy, { ...onChain, committee: seats.committee }, 'inviter-not-on-account'],
      ['an inviter whose seat is not on the account', invitedBy, { ...onChain, seats: seats.seats }, 'inviter-not-on-account'],
      ['the same key value under another tag on the chain', invitedBy, { ...onChain, committee: [...seats.committee, { tag: 'ecdsa', value: inviterKey.value }] }, 'inviter-not-on-account'],
    ] as const) {
      /* RED WHEN: the named invitation is read as naming the account, so the screen offers to keep it. */
      expect(whyTheInvitationDoesNotNameIt(ask({ invitedBy: bent }), chain as never), why).toBe(code);
      /* RED WHEN: what the person is told is anything but the sentence for that defect, which says what to do. */
      expect(() => recordsKeyAnswerFor(me, ask({ invitedBy: bent }), chain as never, NOW), why).toThrow(INVITATION_REFUSAL[code]);
    }
    /* RED WHEN: the tag or the value is compared in one spelling only, so a key the chain writes in upper case is not found. */
    expect(whyTheInvitationDoesNotNameIt(ask({ invitedBy }), { ...onChain, committee: [{ tag: 'SCHNORR', value: inviterKey.value.toUpperCase() }] })).toBeNull();
    for (const code of ['other-account', 'not-signed', 'inviter-not-on-account'] as const) {
      /* RED WHEN: an invitation that cannot be repaired by opening it again is told to be opened again. */
      expect(INVITATION_REFUSAL[code]).toMatch(/ask the person who invited you for a new invitation, and compare the company's fingerprint with them/i);
    }
    /* RED WHEN: an invitation is read anywhere but on a records-key ask, or a malformed one is taken. */
    expect(() => ask({ invitedBy: { ...invitedBy, statement: { ...entry, signature: 'zz' } } })).toThrow(/is not a signer's committee key/);
    expect(() => parseAsk({
      schema: 'midnight-identity/disclosure-request/v1', kind: 'holders', requester: { name: 'Payroll', rdns: 'example.payroll' },
      purpose: 'x', nonce: 'h1', expiresAt: NOW + 60_000, company: CO, account: ACCOUNT, invitedBy,
    }, PAGE, NOW)).toThrow(/an invitation/);
  });

  it('signs the records key of this company\'s key for the seat asked about, and hands back the seats it read', () => {
    const answer = recordsKeyAnswerFor(me, ask(), seats, NOW, undefined, ACCOUNT);
    expect(answer.schema).toBe(RECORDS_KEY_ANSWER_SCHEMA);
    const companyKeyHere = unlockKeyFor(me, { ...ask(), kind: 'unlock' } as unknown as UnlockRequest);
    /* RED WHEN: the statement is for any other records key than the one this company's key opens. */
    expect(answer.statement.recordsKey).toBe(recordsPublicKeyOf(companyKeyHere));
    expect(answer.statement.seat).toBe(SEAT);
    expect(recordsKeySignedBy(CO, ACCOUNT, answer.committeeKey, answer.statement)).toBe(true);
    /* RED WHEN: who holds the account, as the wallet read it, does not travel with the answer. */
    expect(answer.seats).toEqual(seats);
    /* No secret crosses. */
    expect(JSON.stringify(answer)).not.toContain(hex(companyKeyHere));
    expect(JSON.stringify(answer)).not.toContain(committeeSigningKeyFor(me, CO).value);
    const read = readRecordsKeyAnswer(answer, expecting);
    expect(read.ok && read.statement).toEqual(answer.statement);
    expect(read.ok && read.seats).toEqual(seats);
  });

  it('A SEAT THE ACCOUNT DOES NOT HOLD NOW IS REFUSED, AND NOTHING IS SIGNED', () => {
    /* RED WHEN: the wallet signs a seat somebody has left. */
    expect(() => recordsKeyAnswerFor(me, ask(), { ...seats, seats: [ANOTHER_SEAT] }, NOW, undefined, ACCOUNT)).toThrow(RecordsKeyRefused);
    expect(() => recordsKeyAnswerFor(me, ask(), { ...seats, seats: [] }, NOW, undefined, ACCOUNT)).toThrow(/not one this company's account holds now/);
  });

  it('the ask is read whole: a seat that is not one, or a seat on any other kind, is refused', () => {
    expect(() => ask({ seat: 'AB'.repeat(32) })).toThrow(/not one \(64 lower-case hex characters\)/);
    expect(() => ask({ seat: undefined })).toThrow(/not one/);
    expect(() => ask({ wants: [] })).toThrow(/two different powers/);
    /* RED WHEN: a seat rides along on another kind of ask and is ignored. */
    expect(() => parseAsk({
      schema: 'midnight-identity/disclosure-request/v1', kind: 'sign-in',
      requester: { name: 'Payroll', rdns: 'example.payroll' }, purpose: 'Sign in.', nonce: 'n', expiresAt: NOW + 60_000, seat: SEAT,
    }, PAGE, NOW)).toThrow(/names a seat/);
  });

  it('THE PAGE REFUSES AN ANSWER TO ANY OTHER QUESTION, OR ONE NOT SIGNED FOR ITS SEAT', () => {
    const answer = recordsKeyAnswerFor(me, ask(), seats, NOW, undefined, ACCOUNT);
    const code = (over: Record<string, unknown>, exp = expecting) => {
      const r = readRecordsKeyAnswer({ ...answer, ...over }, exp);
      return r.ok ? 'accepted' : r.code;
    };
    expect(code({})).toBe('accepted');
    expect(code({ schema: 'x' })).toBe('not-an-answer');
    expect(code({ origin: 'https://elsewhere.example' })).toBe('origin-mismatch');
    expect(code({ nonce: 'r2' })).toBe('nonce-mismatch');
    expect(code({ company: OTHER_CO })).toBe('other-company');
    /* RED WHEN: an answer signed for another seat than the one asked about is taken. */
    expect(code({}, { ...expecting, seat: ANOTHER_SEAT })).toBe('not-signed');
    /* RED WHEN: a statement signed by another key is taken. */
    expect(code({ committeeKey: committeeKeyFor(somebodyElse, CO) })).toBe('not-signed');
    /* RED WHEN: seats in a shape no wallet writes are taken as who holds the account. */
    expect(code({ seats: { ...seats, seats: [SEAT, SEAT] } })).toBe('not-an-answer');
    expect(code({ seats: { ...seats, seats: ['nope'] } })).toBe('not-an-answer');
    expect(code({ seats: { ...seats, committee: [{ tag: 'ecdsa', value: '11'.repeat(32) }] } })).toBe('not-an-answer');
  });

  describe('WITH A VAULT NAMED', () => {
    const VAULT = '9a'.repeat(32);
    const held = { vault: VAULT, account: ACCOUNT as string, committee: seats.committee, threshold: 1 };

    it('the ask names one vault by its address, never the account itself, and nothing else of a payment', () => {
      expect(ask({ vault: VAULT.toUpperCase() }).vault).toBe(VAULT);
      /* RED WHEN: a vault that is not an address, or the company's account named as its own vault, is taken. */
      expect(() => ask({ vault: 'co_x' })).toThrow(/names one of its vaults by something that is not a vault's address/);
      expect(() => ask({ vault: ACCOUNT })).toThrow(/names one of its vaults by something that is not a vault's address/);
      /* RED WHEN: a transaction rides along on a records-key ask and is ignored. */
      expect(() => ask({ vault: VAULT, transaction: 'AAAA' })).toThrow(/carries a transaction or names a vault/);
      /* RED WHEN: a vault is let through on a kind that does not read it. */
      expect(() => parseAsk({
        schema: 'midnight-identity/disclosure-request/v1', kind: 'sign-in',
        requester: { name: 'Payroll', rdns: 'example.payroll' }, purpose: 'Sign in.', nonce: 'n', expiresAt: NOW + 60_000, vault: VAULT,
      }, PAGE, NOW)).toThrow(/carries a transaction or names a vault/);
    });

    it('the answer carries who holds the vault as the wallet read it, and the wallet signs nothing without that read', () => {
      const answer = recordsKeyAnswerFor(me, ask({ vault: VAULT }), seats, NOW, held, ACCOUNT);
      /* RED WHEN: the vault the wallet read does not travel with the answer, or travels changed. */
      expect(answer.vault).toEqual(held);
      /* RED WHEN: the wallet signs for a vault it did not read, or read another vault in its place. */
      expect(() => recordsKeyAnswerFor(me, ask({ vault: VAULT }), seats, NOW, undefined, ACCOUNT)).toThrow(/has not read the vault the page names/);
      expect(() => recordsKeyAnswerFor(me, ask({ vault: VAULT }), seats, NOW, { ...held, vault: '9b'.repeat(32) }, ACCOUNT))
        .toThrow(/has not read the vault the page names/);
      /* RED WHEN: the wallet signs while the vault it read is pinned to another company's account. */
      expect(() => recordsKeyAnswerFor(me, ask({ vault: VAULT }), seats, NOW, { ...held, account: 'ad'.repeat(32) }, ACCOUNT))
        .toThrow(/belongs to a different company account/);
      /* An ask that names no vault is answered with none. */
      expect('vault' in recordsKeyAnswerFor(me, ask(), seats, NOW, held, ACCOUNT)).toBe(false);
    });

    it('THE PAGE TAKES AN ANSWER ONLY WHEN IT SAYS WHO HOLDS THE VAULT IT ASKED ABOUT', () => {
      const answer = recordsKeyAnswerFor(me, ask({ vault: VAULT }), seats, NOW, held, ACCOUNT);
      const withVault = { ...expecting, vault: VAULT };
      const read = readRecordsKeyAnswer(answer, withVault);
      expect(read.ok && read.vault).toEqual(held);
      const code = (over: Record<string, unknown>) => {
        const r = readRecordsKeyAnswer({ ...answer, ...over }, withVault);
        return r.ok ? 'accepted' : r.code;
      };
      /* RED WHEN: an answer about another vault, or about none, or in a shape no wallet writes, is taken. */
      expect(code({ vault: { ...held, vault: '9b'.repeat(32) } })).toBe('not-an-answer');
      expect(code({ vault: undefined })).toBe('not-an-answer');
      expect(code({ vault: { ...held, account: 'nope' } })).toBe('not-an-answer');
      expect(code({ vault: { ...held, committee: [{ tag: 'ecdsa', value: '11'.repeat(32) }] } })).toBe('not-an-answer');
      expect(code({ vault: { ...held, threshold: -1 } })).toBe('not-an-answer');
      /* A page that asked about no vault reads none, whatever the answer carries. */
      const none = readRecordsKeyAnswer(answer, expecting);
      expect(none.ok && none.vault).toBeNull();
    });
  });
});

describe('A STATEMENT AND AN ENTRY ARE FOR ONE ACCOUNT: ANOTHER ACCOUNT CARRYING THE SAME LABEL IS NOT IT', () => {
  const OTHER = 'a8'.repeat(32) as AccountAddress;
  const mine = committeeKeyFor(me, CO);
  it('A RECORDS-KEY STATEMENT SIGNED FOR ONE ACCOUNT DOES NOT VERIFY FOR ANOTHER', () => {
    const statement = signRecordsKey(me, CO, ACCOUNT, companyKey, SEAT);
    /* RED WHEN: the account is not part of what is signed, so a statement for one account passes for another. */
    expect(recordsKeySignedBy(CO, ACCOUNT, mine, statement)).toBe(true);
    expect(recordsKeySignedBy(CO, OTHER, mine, statement)).toBe(false);
    expect(recordsKeySignedBy(CO, 'not an account' as AccountAddress, mine, statement)).toBe(false);
    expect(recordsKeyStatementBytes(CO, OTHER, statement.recordsKey, SEAT)).not.toEqual(recordsKeyStatementBytes(CO, ACCOUNT, statement.recordsKey, SEAT));
  });
  it('AN ENTRY IS FALSE FOR ANY ACCOUNT BUT THE ONE IT NAMES AND WAS SIGNED FOR', () => {
    const entry = signDirectoryEntry(me, CO, ACCOUNT, companyKey, '3c'.repeat(32), SEAT);
    expect(entry.account).toBe(ACCOUNT);
    /* RED WHEN: an entry signed for one account is believed for another. */
    expect(directoryEntrySignedBy(CO, OTHER, mine, entry)).toBe(false);
    /* RED WHEN: an entry is believed for the account it names, when its signature is over another. */
    const forOther = signDirectoryEntry(me, CO, OTHER, companyKey, '3c'.repeat(32), SEAT);
    expect(directoryEntrySignedBy(CO, ACCOUNT, mine, { ...forOther, account: ACCOUNT })).toBe(false);
    expect(directoryEntrySignedBy(CO, OTHER, mine, forOther)).toBe(true);
  });
});

describe('A DIRECTORY ENTRY, SIGNED BY THE WALLET WITH THE COMMITTEE KEY, IN THE SAME PRESS AS THE RECORDS KEY', () => {
  const FILING = '3c'.repeat(32);
  const PAGE = 'https://payroll.example';
  const NOW = 1_755_000_000_000;
  const entry = signDirectoryEntry(me, CO, ACCOUNT, companyKey, FILING, SEAT);
  const mine = committeeKeyFor(me, CO);

  it('signs the filing key, the records key the company key opens and the seat, and checks against that committee key only', () => {
    /* RED WHEN: the wrapping key signed is anything but the records key this company key opens. */
    expect(entry.wrappingKey).toBe(recordsPublicKeyOf(companyKey));
    expect(directoryEntrySignedBy(CO, ACCOUNT, mine, entry)).toBe(true);
    /* RED WHEN: an entry verifies under another wallet's key, another company's label, or with any part changed. */
    expect(directoryEntrySignedBy(CO, ACCOUNT, committeeKeyFor(somebodyElse, CO), entry)).toBe(false);
    expect(directoryEntrySignedBy(OTHER_CO, ACCOUNT, mine, entry)).toBe(false);
    for (const part of ['signingKey', 'wrappingKey', 'seat'] as const) {
      expect(directoryEntrySignedBy(CO, ACCOUNT, mine, { ...entry, [part]: flip(entry[part]) }), part).toBe(false);
    }
  });

  it('IS NEVER THE RECORDS-KEY STATEMENT, AND THE RECORDS-KEY STATEMENT IS NEVER AN ENTRY', () => {
    expect(DIRECTORY_ENTRY_STATEMENT_TAG).not.toBe(RECORDS_KEY_STATEMENT_TAG);
    const statement = signRecordsKey(me, CO, ACCOUNT, companyKey, SEAT);
    /* RED WHEN: the two statements share a domain, so one signature passes as the other. */
    expect(directoryEntrySignedBy(CO, ACCOUNT, mine, { account: ACCOUNT, signingKey: statement.recordsKey, wrappingKey: statement.recordsKey, seat: SEAT, signature: statement.signature })).toBe(false);
    expect(Buffer.from(directoryEntryStatementBytes(CO, ACCOUNT, FILING, entry.wrappingKey, SEAT)!).toString('utf8')).toContain(DIRECTORY_ENTRY_STATEMENT_TAG);
    expect(directoryEntryStatementBytes(CO, ACCOUNT, 'nope', entry.wrappingKey, SEAT)).toBeNull();
  });

  it('THE RECORDS-KEY ANSWER CARRIES THE ENTRY EXACTLY WHEN THE ASK NAMED A FILING KEY, AND THE PAGE REFUSES ONE THAT IS NOT FOR IT', () => {
    const ask = (over: Record<string, unknown> = {}) => parseAsk({
      schema: 'midnight-identity/disclosure-request/v1', kind: 'records-key',
      requester: { name: 'Payroll', rdns: 'example.payroll' }, purpose: 'To check your records key.',
      nonce: 'r1', expiresAt: NOW + 60_000, company: CO, account: ACCOUNT, seat: SEAT, ...over,
    }, PAGE, NOW) as RecordsKeyRequest;
    const seats = { committee: [mine as { tag: string; value: string }], threshold: 1, seats: [SEAT] };
    const expecting = { atOrigin: PAGE, expectingNonce: 'r1', company: CO, account: ACCOUNT, seat: SEAT };
    /* RED WHEN: an entry is signed when the page asked for none. */
    expect(recordsKeyAnswerFor(me, ask(), seats, NOW, undefined, ACCOUNT).entry).toBeUndefined();
    const answer = recordsKeyAnswerFor(me, ask({ signingKey: FILING }), seats, NOW, undefined, ACCOUNT);
    /* RED WHEN: the entry is for another filing key, records key or seat than the ask's, or does not verify. */
    const companyKeyHere = unlockKeyFor(me, { ...ask(), kind: 'unlock' } as unknown as UnlockRequest);
    expect({ ...answer.entry, signature: '' }).toEqual({ account: ACCOUNT, signingKey: FILING, wrappingKey: recordsPublicKeyOf(companyKeyHere), seat: SEAT, signature: '' });
    expect(directoryEntrySignedBy(CO, ACCOUNT, answer.committeeKey, answer.entry!)).toBe(true);
    const read = readRecordsKeyAnswer(answer, { ...expecting, signingKey: FILING });
    expect(read.ok && read.entry).toEqual(answer.entry);
    /* RED WHEN: the page takes an entry for another filing key, or an answer with no entry, as the one it asked for. */
    const other = readRecordsKeyAnswer(answer, { ...expecting, signingKey: '4d'.repeat(32) });
    expect(other.ok ? 'accepted' : other.code).toBe('not-signed');
    const none = readRecordsKeyAnswer(recordsKeyAnswerFor(me, ask(), seats, NOW, undefined, ACCOUNT), { ...expecting, signingKey: FILING });
    expect(none.ok ? 'accepted' : none.code).toBe('not-signed');
    /* RED WHEN: the page takes an entry whose signature does not verify against the wallet's committee key. */
    const forged = { ...answer, entry: { ...answer.entry!, signature: answer.entry!.signature.replace(/^./u, (c) => (c === '0' ? '1' : '0')) } };
    const unsigned = readRecordsKeyAnswer(forged, { ...expecting, signingKey: FILING });
    expect(unsigned.ok ? 'accepted' : unsigned.code).toBe('not-signed');
    /* RED WHEN: the page takes an entry whose wrapping key is not the records key the same answer signed, even one the wallet signed. */
    const otherWrapping = { ...answer, entry: signDirectoryEntry(me, CO, ACCOUNT, new Uint8Array(32).fill(0x5e), FILING, SEAT) };
    const moved = readRecordsKeyAnswer(otherWrapping, { ...expecting, signingKey: FILING });
    expect(moved.ok ? 'accepted' : moved.code).toBe('not-signed');
    /* RED WHEN: a filing key rides along on another kind of ask and is ignored, or is not a key. */
    expect(() => ask({ signingKey: 'zz' })).toThrow(/key your filings are signed with/);
    expect(() => parseAsk({
      schema: 'midnight-identity/disclosure-request/v1', kind: 'sign-in',
      requester: { name: 'Payroll', rdns: 'example.payroll' }, purpose: 'Sign in.', nonce: 'n', expiresAt: NOW + 60_000, signingKey: FILING,
    }, PAGE, NOW)).toThrow(/or a filing key/);
  });
});

describe('THE HOLDERS ASK: PUBLIC CHAIN FACTS, NO PRESS, AND NOTHING ELSE', () => {
  const PAGE = 'https://payroll.example';
  const NOW = 1_755_000_000_000;
  const VAULT = '9a'.repeat(32);
  /* A founding seat no longer held: the deploy's seat is answered whoever holds the account now. */
  const FOUNDING = '5f'.repeat(32);
  const ask = (over: Record<string, unknown> = {}) => parseAsk({
    schema: 'midnight-identity/disclosure-request/v1', kind: 'holders',
    requester: { name: 'Payroll', rdns: 'example.payroll' }, purpose: 'Who holds the company.',
    nonce: 'h1', expiresAt: NOW + 60_000, company: CO, account: ACCOUNT, ...over,
  }, PAGE, NOW) as HoldersRequest;
  const holders = {
    committee: [committeeKeyFor(me, CO) as { tag: string; value: string }], threshold: 1, seats: [SEAT], approvals: 2, adoptedVaults: [VAULT],
    founding: FOUNDING, foundingCommittee: [committeeKeyFor(me, CO) as { tag: string; value: string }],
  };
  const expecting = { atOrigin: PAGE, expectingNonce: 'h1', company: CO, account: ACCOUNT };

  it('ANSWERS WITH WHAT THE WALLET READ AND NO PRIVATE FIELD', () => {
    const answer = holdersAnswerFor(ask(), holders, NOW);
    expect(answer.schema).toBe(HOLDERS_ANSWER_SCHEMA);
    /* RED WHEN: the answer carries any field but the public chain facts and the echo of the ask. */
    expect(Object.keys(answer).sort()).toEqual(['account', 'at', 'company', 'holders', 'nonce', 'origin', 'schema']);
    expect(Object.keys(answer.holders).sort()).toEqual(['adoptedVaults', 'approvals', 'committee', 'founding', 'foundingCommittee', 'seats', 'threshold']);
    /* RED WHEN: the founding seat the wallet read from the deploy is not handed on as read. */
    expect(answer.holders.founding).toBe(FOUNDING);
    /* RED WHEN: whatever else the wallet's read carries is passed on rather than only the five facts named. */
    const carrying = holdersAnswerFor(ask(), { ...holders, companyKey: 'aa'.repeat(32) } as typeof holders, NOW);
    expect(Object.keys(carrying.holders).sort()).toEqual(['adoptedVaults', 'approvals', 'committee', 'founding', 'foundingCommittee', 'seats', 'threshold']);
    /* RED WHEN: a key the wallet holds crosses: no committee secret, no company key, no signature. */
    const said = JSON.stringify(answer);
    expect(said).not.toContain(committeeSigningKeyFor(me, CO).value);
    expect(said).not.toContain(hex(unlockKeyFor(me, { ...ask(), seat: SEAT, kind: 'unlock' } as unknown as UnlockRequest)));
    expect(said).not.toMatch(/signature/);
    const read = readHoldersAnswer(answer, expecting);
    /* RED WHEN: who holds an account is read without the account the wallet read it for. */
    expect(read.ok && read.holders).toEqual({ ...holders, account: ACCOUNT });
  });

  it('THE PAGE REFUSES AN ANSWER TO ANOTHER QUESTION, OR HOLDERS IN A SHAPE NO WALLET WRITES', () => {
    const answer = holdersAnswerFor(ask(), holders, NOW);
    const code = (message: unknown, exp: Parameters<typeof readHoldersAnswer>[1]) => {
      const r = readHoldersAnswer(message, exp);
      return r.ok ? 'accepted' : r.code;
    };
    expect(code(answer, expecting)).toBe('accepted');
    /* RED WHEN: an answer for another nonce or another company is taken. */
    expect(code({ ...answer, nonce: 'h2' }, expecting)).toBe('nonce-mismatch');
    expect(code({ ...answer, company: OTHER_CO }, expecting)).toBe('other-company');
    /* RED WHEN: holders in a shape no wallet writes are taken. */
    expect(code({ ...answer, holders: { ...holders, approvals: 0 } }, expecting)).toBe('not-an-answer');
    expect(code({ ...answer, holders: { ...holders, adoptedVaults: [VAULT, VAULT] } }, expecting)).toBe('not-an-answer');
    /* RED WHEN: holders with no founding seat, or one that is not a seat, are taken: a page would anchor to nothing. */
    const { founding: _f, ...noFounding } = holders;
    expect(code({ ...answer, holders: noFounding }, expecting)).toBe('not-an-answer');
    expect(code({ ...answer, holders: { ...holders, founding: 'AB'.repeat(32) } }, expecting)).toBe('not-an-answer');
    /* RED WHEN: holders with no committee the deploy held the account by are taken: the founding seat's entry could then be anybody's. */
    expect(code({ ...answer, holders: { ...holders, foundingCommittee: [] } }, expecting)).toBe('not-an-answer');
    expect(code({ ...answer, holders: { ...holders, foundingCommittee: [{ tag: 'schnorr' }] } }, expecting)).toBe('not-an-answer');
  });

  it('A PAGE ABOUT TO APPROVE A RUN ASKS ABOUT ITS PAYMENTS, AND IS TOLD ONLY ABOUT THE ENTRIES IT ASKED', () => {
    const asked = ['a1'.repeat(32), 'b2'.repeat(32), 'c3'.repeat(32)];
    const request = ask({ movements: asked });
    /* RED WHEN: the entries a page asked about are dropped from the ask. */
    expect(request.movements).toEqual(asked);
    const payments = { payKeyCommitment: 'cc'.repeat(32), held: [asked[2]!, asked[0]!] };
    const answer = holdersAnswerFor(request, holders, NOW, payments);
    /* RED WHEN: what is held is not answered in the order asked, or the commitment is not passed on as read. */
    expect(answer.payments).toEqual({ payKeyCommitment: 'cc'.repeat(32), held: [asked[0], asked[2]] });
    const exp = { ...expecting, movements: asked };
    const read = readHoldersAnswer(answer, exp);
    expect(read.ok && read.payments).toEqual(answer.payments);
    const refuses = (message: unknown, e: Parameters<typeof readHoldersAnswer>[1] = exp) => readHoldersAnswer(message, e).ok;
    /* RED WHEN: a page that asked about payments takes an answer that says nothing about them as nobody paid. */
    expect(refuses({ ...answer, payments: undefined })).toBe(false);
    /* RED WHEN: an entry the page did not ask about is taken as held, or one entry twice, or a commitment in no wallet's shape. */
    expect(refuses({ ...answer, payments: { ...payments, held: ['dd'.repeat(32)] } })).toBe(false);
    expect(refuses({ ...answer, payments: { ...payments, held: [asked[0], asked[0]] } })).toBe(false);
    expect(refuses({ ...answer, payments: { ...payments, payKeyCommitment: 'CC'.repeat(32) } })).toBe(false);
    /* RED WHEN: an account that committed to no pay-record key is read as one that did. */
    expect(readHoldersAnswer(holdersAnswerFor(request, holders, NOW, { payKeyCommitment: null, held: [] }), exp)).toMatchObject({ ok: true, payments: { payKeyCommitment: null, held: [] } });
    /* RED WHEN: a page that asked nothing about payments takes an answer that volunteers them. */
    expect(refuses(answer, expecting)).toBe(false);
    /* RED WHEN: a wallet answers an ask about payments without reading them, or answers payments nobody asked about. */
    expect(() => holdersAnswerFor(request, holders, NOW)).toThrow(/did not read the payments/);
    expect(() => holdersAnswerFor(ask(), holders, NOW, payments)).toThrow(/did not read the payments/);
    /* RED WHEN: a wallet answers as held an entry the page did not ask about. */
    expect(() => holdersAnswerFor(request, holders, NOW, { ...payments, held: ['dd'.repeat(32)] })).toThrow(/did not read the payments/);
    /* RED WHEN: an ask names no entries, an entry in no shape, one twice, or more than the most allowed, and is answered. */
    for (const bad of [[], ['zz'], [asked[0], asked[0]], Array.from({ length: MOST_ENTRIES_ASKED + 1 }, (_, i) => i.toString(16).padStart(64, '0')), 'a1']) {
      expect(() => ask({ movements: bad }), JSON.stringify(bad).slice(0, 40)).toThrow(/between 1 and/);
    }
  });

  it('THE ASK REFUSES ANY FIELD BUT THE LABEL AND THE ACCOUNT', () => {
    /* RED WHEN: a holders ask carries a seat, a filing key, a vault, details to hand over, a key to seal to, or anything else, and is answered with no press. */
    for (const extra of [{ seat: SEAT }, { signingKey: '3c'.repeat(32) }, { vault: VAULT }, { wants: [] }, { inboxPublicKey: '11'.repeat(32) }, { anything: 1 }]) {
      expect(() => ask(extra), JSON.stringify(extra)).toThrow();
    }
    expect(() => ask({ anything: 1 })).toThrow(/'anything'/);
  });
});
