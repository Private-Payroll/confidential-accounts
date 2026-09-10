/**
 * THE RECORDED MAINTENANCE AUTHORITY, READ FROM DISK, IN ONE PLACE.
 *
 * Who may change which proofs a deployed contract accepts is a governance
 * decision. It is written down deliberately, by a person, before anything is
 * deployed, and it is NEVER sampled: the SDK's own deploy call falls through to
 * a fresh random signing key when it is given none, and that default is how
 * every account this project deployed before the refusal existed acquired a
 * single unrecorded key with the power to change its rules.
 *
 * -- WHY IT IS A FILE OF ITS OWN --------------------------------------------
 *
 * Two deploy scripts each wrote their own copy of *read the file, refuse if it
 * is missing, validate what is in it*, and a third caller was about to. This
 * project has a name for one rule written twice, and a list of the times it
 * cost a run: the copies do not fail together, they drift, and the one that
 * drifts is the one nobody is looking at.
 *
 * **AND THE VALIDATION IS NOT DUPLICATED HERE EITHER.** The rules about what a
 * committee, a single key or an unmaintainable choice must look like belong to
 * the deploy layer that acts on them, and this file calls into them rather than
 * restating them. What is here is the READING and the refusal for an absent
 * one, which is the part that touches a filesystem.
 *
 * -- WHAT IS NOT HERE, AND IT IS THE MORE IMPORTANT HALF --------------------
 *
 * **THIS FILE CHOOSES NOTHING.** It has no default, no fallback and no branch
 * that invents a value. An absent record is a refusal that lays the options
 * out, because the alternative - a deployment that quietly picked one - is the
 * exact failure the whole refusal exists to prevent.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  requireMaintenanceAuthority, type MaintenanceAuthorityChoice,
} from './partial-contract.js';

/** Where a deployment's own state is kept, relative to the repository root. */
export const authorityFileIn = (root: string): string =>
  join(root, '.midnight', 'maintenance-authority.json');

/**
 * What to say when no authority has been recorded.
 *
 * **PURE, AND EXPORTED, SO THE REFUSING BRANCH CAN BE READ WITHOUT ARRANGING A
 * MISSING FILE.** A refusal that can only be reached by deleting something is
 * a refusal nobody has ever seen.
 *
 * **IT NAMES THE STATE THAT RESOLVES IT, NOT A COMMAND TO TYPE.** Whoever meets
 * this may be looking at a deploy, a server log or a check, and what they need
 * is that a choice has to be recorded and what the three choices cost - not the
 * name of a file that only exists on one machine.
 */
export function noAuthorityRecorded(where: string): string {
  return 'no maintenance authority has been recorded for this deployment, and one is never '
    + `sampled: ${where} does not exist.\n\n`
    + 'Whoever holds this authority can change which proofs the deployed contract accepts, '
    + 'alone and outside the company\'s own approval threshold, and if the key is lost the '
    + 'contract can never be maintained again. It is a decision rather than a setting, so it '
    + 'is recorded before a deploy rather than defaulted during one. The three states are a '
    + 'committee of verifying keys at a threshold, one key held deliberately as a recorded '
    + 'temporary state naming what replaces it, or an authority nobody can ever exercise.';
}

/**
 * The recorded choice, validated, or a refusal.
 *
 * **IT REFUSES IN TWO DIFFERENT VOICES ON PURPOSE.** An absent record is a
 * decision nobody has taken; a malformed one is a decision somebody took badly.
 * Those send a reader to different places, so they are not collapsed into one
 * sentence.
 */
export function loadMaintenanceAuthority(root: string): MaintenanceAuthorityChoice {
  const path = authorityFileIn(root);
  if (!existsSync(path)) throw new Error(noAuthorityRecorded(path));
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e: any) {
    throw new Error(
      `the recorded maintenance authority at ${path} is not readable as JSON: ${e?.message ?? e}. `
      + 'It is not repaired or replaced here: a deployment that mended its own governance '
      + 'record would be choosing the authority it was refusing to choose.');
  }
  return requireMaintenanceAuthority(parsed as MaintenanceAuthorityChoice);
}
