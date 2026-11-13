import type { SealedProposal } from '../../../../src/core/types.js';
import { kindAsked, listedHere } from '../../../../packages/web-shared/src/vault-page-doors.js';
import { RecordWithheld } from '../../../../packages/web-shared/src/http-sealed-pool-store.js';
import { governanceRecordsFor, type CompanyReach } from './company-reach.js';
import { codeOfError, StepRefused, type Words } from './definition.js';
import { ActionStopped } from './run.js';

/*
 * The company's proposals and the seats the chain holds now, read together through this wallet's own reach of the
 * company for an act on a signer's invitation. Proposals the company's anchored records name and the service left out
 * refuse the read (`listedHere`), so an act never judges an invitation on a list the service cut short.
 */

/**
 * The proposals, set-aside ones included, and the seats the chain holds now. Refuses in the act's own words: `withheld`
 * when the service kept back a record the anchor names, `not-read` when the records or the chain could not be read.
 */
export async function proposalsAndSeatsOf(
  r: CompanyReach, why: (key: string, values?: Readonly<Record<string, string | number>>) => Words,
): Promise<{ readonly proposals: readonly SealedProposal[]; readonly onTheChain: readonly string[] }> {
  const records = governanceRecordsFor(r);
  try {
    const here = await records.directory(kindAsked('proposal'));
    const listed = listedHere(here, 'proposal', await records.proposals!(), 'proposal');
    return { proposals: [...listed, ...listed.setAside], onTheChain: here.holders.seats };
  } catch (e) {
    if (e instanceof StepRefused || e instanceof ActionStopped) throw e;
    const says = String((e as Error)?.message ?? e);
    if (e instanceof RecordWithheld) throw new StepRefused(why('withheld', { says }), codeOfError(e));
    throw new StepRefused(why('not-read', { says }), codeOfError(e));
  }
}
