/**
 * **AN ACT THAT DOES NOT LIST EVERY READ OF THE COMPANY'S CHOICE OF SERVICE GETS OUR SERVICE WITHOUT READING THE
 * CHOICE (`companyServiceHere`), SO EACH ACT THAT MISSES A READ IS NAMED HERE WITH ITS REASON.** Every intent is
 * held to `SERVICE_READS` as `companyServiceHere` holds it; a miss not named below, or a name that no longer misses,
 * fails, so a new act cannot lose the company's choice without a line saying why.
 */
import { describe, it, expect } from 'vitest';
import { ACT_INTENTS, routeOf } from 'midnight-identity/profile/act-intents';
import { intentShapeOf } from 'midnight-identity/profile/act-shape';
import { SERVICE_READS } from './company-service-read.js';

const ACCOUNT = 'acc_reads';

const missesOf = (name: string): readonly string[] => {
  const shape = intentShapeOf(name);
  if (shape === undefined) return ['no shape'];
  return SERVICE_READS(ACCOUNT).filter(([method, path]) => routeOf(shape, method, path) === null).map(([method, path]) => `${method} ${path}`);
};

/** Acts that miss at least one read, each with why a call through our service is right for it. */
const NOT_READING: Readonly<Record<string, string>> = {
  'finish-company': 'it makes the company, so no choice of service has been filed to read',
  'claim-by-address': 'it runs before this device holds a seat, so there is no seat to open the record with',
  'join-by-code': 'it runs before this device holds a seat, so there is no seat to open the record with',
  'seat-invited': 'its hand-over is built with the default of handOverFor, our service, and reads no choice (the gap this test keeps in view, left as it is)',
  'recovery': 'it runs without the service on purpose and asks the page for no call to it',
  'drop-role-change': 'it only withdraws a role change that was not filed and sends nothing through any service',
  'reader-keys': 'it signs and sends nothing, so no hand-over is built that the choice could redirect; it lists no manifest entries read',
};

describe('an act that does not list the reads of the company\'s choice of service is named with its reason', () => {
  it('every act lists the reads or is named below', () => {
    const missing = Object.keys(ACT_INTENTS).filter((name) => missesOf(name).length > 0 && NOT_READING[name] === undefined);
    expect(missing.map((n) => `${n}: ${missesOf(n).length} of ${SERVICE_READS(ACCOUNT).length} reads missing`)).toEqual([]);
  });

  it('an act named below still misses a read, with a reason of some length', () => {
    for (const [name, why] of Object.entries(NOT_READING)) {
      expect(missesOf(name).length, `${name} now lists every read: drop its line`).toBeGreaterThan(0);
      expect(why.length, `${name} has no reason`).toBeGreaterThan(20);
    }
    expect(Object.keys(NOT_READING).filter((n) => !(n in ACT_INTENTS))).toEqual([]);
  });

  it('an act that files the company\'s choice lists every read', () => {
    expect(missesOf('choose-company-service')).toEqual([]);
  });
});
