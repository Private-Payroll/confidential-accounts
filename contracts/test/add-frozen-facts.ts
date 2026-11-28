/**
 * Adds the newest released version's frozen facts to the record, worked out from the build on disk. Run it once a
 * new version joins the released list and that list's own test holds it equal to this build's keys:
 * `npx tsx contracts/test/add-frozen-facts.ts`. A version already in the record is never written again, since the
 * contracts deployed from it keep its facts for good; and a version the wallet would read differently from any earlier
 * version still in force is refused, naming each difference, since one wallet reads companies on every such version.
 * It prints the digest the record's test pins the new entry by.
 */
import { existsSync, writeFileSync } from 'node:fs';

import { RELEASED_VERSIONS } from '../../packages/identity/src/wallet/released-versions.js';
import {
  entryDigestOf,
  FROZEN_FACTS_FILE,
  readFrozenFacts,
  versionsInForce,
  walletReadDifferences,
  type FrozenFacts
} from './frozen-facts.js';
import { factsOfTheBuild } from './frozen-facts-of-the-build.js';

const newest = RELEASED_VERSIONS[0]?.version;
if (newest === undefined) throw new Error('the released list holds no version to record');
const record: FrozenFacts = existsSync(FROZEN_FACTS_FILE) ? readFrozenFacts() : {};
if (String(newest) in record) {
  throw new Error(`version ${newest} is already in the record, and a released version's facts are never written again`);
}
const facts = await factsOfTheBuild();
const differences = versionsInForce(record).flatMap(([v, earlier]) =>
  walletReadDifferences(earlier, facts).map((d) => `version ${v}: ${d}`)
);
if (differences.length > 0) {
  throw new Error(
    `version ${newest} would be read by the wallet differently from versions still in force, so it is not recorded:\n  ${differences.join('\n  ')}`
  );
}
writeFileSync(FROZEN_FACTS_FILE, `${JSON.stringify({ ...record, [newest]: facts }, null, 1)}\n`);
console.log(
  `recorded the frozen facts of version ${newest}; pin it in the-frozen-facts-hold.test.ts as '${newest}': '${entryDigestOf(facts)}'`
);
