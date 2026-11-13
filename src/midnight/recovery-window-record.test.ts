/**
 * **THE RECOVERY WINDOW, JUDGED VERSION BY VERSION.** A change counts once seats the chain holds at the seat bar signed
 * it; only an admin or the founding seat starts a change, any seat adds its signature; a length outside the window's
 * range is refused; a signer who leaves after a version is anchored does not drop it. Pure: no service, no chain.
 */
import { describe, expect, it } from 'vitest';
import { newSymmetricKey, sign, signingPublicKeyOf, unwrapKey, type Hex } from '../core/crypto.js';
import type { Role } from '../core/roles.js';
import { recordsKeypairFrom } from './company-nonce-secret.js';
import {
  openRecoveryWindow, RECOVERY_WINDOW_RANGE, recoveryWindowInForceOf, sealRecoveryWindow, windowMessage, windowOpenedWithTheCompanyKey,
  type WindowChange, type WindowVersion,
} from './recovery-window-record.js';
import { companyRecordKey, mayFileTheRecord, type DirectorySeat } from './seat-directory.js';

const CO = 'acc_window';
const seatOf = (n: number, role: Role | null): { secret: Hex; seat: DirectorySeat } => {
  const secret = newSymmetricKey();
  return {
    secret,
    seat: {
      seat: n.toString(16).padStart(64, '0'), person: `p${n}`, signingKey: signingPublicKeyOf(secret).toLowerCase() as Hex,
      wrappingKey: 'ab'.repeat(32) as Hex, role, retired: null, committeeKey: { tag: 'schnorr', value: n.toString(16).padStart(64, '0') },
    },
  };
};
const ADMIN = seatOf(1, 'admin');
const FOUNDER = seatOf(2, null);
const APPROVER = seatOf(3, 'approver');
const SEATS = [ADMIN.seat, FOUNDER.seat, APPROVER.seat];
const QUORUM = { seats: SEATS, held: () => true, bar: 2 };
const DAY = 24 * 60 * 60;

const change = (sequence: number, seconds: number, by: readonly { secret: Hex }[]): WindowChange => {
  const message = windowMessage(CO, { sequence, seconds });
  return { sequence, seconds, signatures: by.map((s) => ({ publicKey: signingPublicKeyOf(s.secret).toLowerCase() as Hex, signature: sign(message, s.secret) })) };
};
const version = (v: number, filer: { secret: Hex }, c: WindowChange): WindowVersion => ({ version: v, filer: signingPublicKeyOf(filer.secret).toLowerCase() as Hex, change: c });

describe('THE RECOVERY WINDOW IN FORCE', () => {
  it('one signature short of the seat bar is not in force; it waits, and the bar brings it into force', () => {
    const one = version(1, ADMIN, change(1, 2 * DAY, [ADMIN]));
    expect(recoveryWindowInForceOf(CO, [one], QUORUM)).toMatchObject({ inForce: null, waiting: { version: 1 }, refused: new Map([[1, 'below-quorum']]) });
    const both = version(2, APPROVER, change(1, 2 * DAY, [ADMIN, APPROVER]));
    expect(recoveryWindowInForceOf(CO, [one, both], QUORUM)).toMatchObject({ inForce: { version: 2, change: { seconds: 2 * DAY } }, waiting: null });
  });

  it('a length past the top of the range, or below its bottom, is refused, signed at the bar or not', () => {
    const long = version(1, ADMIN, change(1, RECOVERY_WINDOW_RANGE.longest + 1, [ADMIN, FOUNDER]));
    expect(recoveryWindowInForceOf(CO, [long], QUORUM)).toMatchObject({ inForce: null, refused: new Map([[1, 'outside-the-range']]) });
    const short = version(1, ADMIN, change(1, RECOVERY_WINDOW_RANGE.shortest - 1, [ADMIN, FOUNDER]));
    expect(recoveryWindowInForceOf(CO, [short], QUORUM).refused.get(1)).toBe('outside-the-range');
    expect(recoveryWindowInForceOf(CO, [version(1, ADMIN, change(1, RECOVERY_WINDOW_RANGE.longest, [ADMIN, FOUNDER]))], QUORUM).inForce?.change.seconds)
      .toBe(RECOVERY_WINDOW_RANGE.longest);
    expect(() => sealRecoveryWindow({
      company: CO, version: 1, sealing: { key: newSymmetricKey(), epoch: 0 }, change: change(1, RECOVERY_WINDOW_RANGE.longest + 1, [ADMIN]),
      seats: [{ id: 's1', wrappingPublicKey: recordsKeypairFrom(new Uint8Array(32).fill(1)).publicKey }],
    })).toThrow(/outside/u);
  });

  it('only an admin or the founding seat starts a change; any seat files it again with its signature added', () => {
    const byApprover = version(1, APPROVER, change(1, DAY, [APPROVER, ADMIN]));
    expect(recoveryWindowInForceOf(CO, [byApprover], QUORUM)).toMatchObject({ inForce: null, refused: new Map([[1, 'started-by-a-seat-that-may-not']]) });
    const byFounder = version(1, FOUNDER, change(1, DAY, [FOUNDER]));
    const signed = version(2, APPROVER, change(1, DAY, [FOUNDER, APPROVER]));
    expect(recoveryWindowInForceOf(CO, [byFounder, signed], QUORUM).inForce?.version).toBe(2);
    const otherLength = version(2, APPROVER, change(1, 2 * DAY, [FOUNDER, APPROVER]));
    expect(recoveryWindowInForceOf(CO, [byFounder, otherLength], QUORUM).refused.get(2)).toBe('started-by-a-seat-that-may-not');
  });

  it('a change follows the one in force in order, and a signer who leaves after it is anchored does not drop it', () => {
    const first = version(1, ADMIN, change(1, DAY, [ADMIN, FOUNDER]));
    const skipped = version(2, ADMIN, change(3, 2 * DAY, [ADMIN, FOUNDER]));
    expect(recoveryWindowInForceOf(CO, [first, skipped], QUORUM)).toMatchObject({ inForce: { version: 1 }, refused: new Map([[2, 'not-the-next-change']]) });
    const gone = { ...QUORUM, held: (s: DirectorySeat) => s.seat !== FOUNDER.seat.seat };
    expect(recoveryWindowInForceOf(CO, [first], gone).inForce).toBeNull();
    expect(recoveryWindowInForceOf(CO, [first], { ...gone, asAnchored: (v) => (v === 1 ? QUORUM : undefined) }).inForce?.version).toBe(1);
  });

  it('a version opens with the seat\'s own copy and with the company\'s key, and not with another key', () => {
    const me = recordsKeypairFrom(new Uint8Array(32).fill(7));
    const companyKey = newSymmetricKey();
    const c = change(1, DAY, [ADMIN]);
    const rec = sealRecoveryWindow({ company: CO, version: 1, sealing: { key: companyKey, epoch: 0 }, change: c, seats: [{ id: 'me', wrappingPublicKey: me.publicKey }] });
    const nobody = () => { throw new Error('no copy'); };
    expect(openRecoveryWindow(rec, { signerId: 'me', keyOf: (w) => unwrapKey(w, me.secret) as Hex, companyCopy: nobody })).toEqual(c);
    expect(openRecoveryWindow(rec, { signerId: 'later', keyOf: nobody, companyCopy: windowOpenedWithTheCompanyKey(CO, () => companyKey) })).toEqual(c);
    expect(openRecoveryWindow(rec, { signerId: 'later', keyOf: nobody, companyCopy: windowOpenedWithTheCompanyKey(CO, () => newSymmetricKey()) })).toBeNull();
  });
});

describe('WHO FILES A VERSION OF THE RECOVERY WINDOW', () => {
  it('any seat files the window, and a seat whose role does not file policy files no other policy record', () => {
    expect(mayFileTheRecord(APPROVER.seat, 'policy', companyRecordKey('policy', 'recovery-window'))).toBe(true);
    expect(mayFileTheRecord(APPROVER.seat, 'policy', companyRecordKey('policy', 'company-service'))).toBe(false);
    expect(mayFileTheRecord(ADMIN.seat, 'policy', companyRecordKey('policy', 'company-service'))).toBe(true);
  });
});
