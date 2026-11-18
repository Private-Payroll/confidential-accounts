/**
 * WHAT AN END-TO-END CHECK WAITS FOR, AND HOW IT STANDS DOWN WITHOUT IT.
 *
 * The checks that run the product itself against a live network (reading the chain, creating a company, a fee paid
 * by a sponsor) need two things this repository does not hold: the network to run against, named in
 * `MIDNIGHT_NETWORK_ID`, and, for a check that spends a fee, a funded wallet's seed on this machine. Without them a
 * check stands down: it prints what it waits for and exits 0, so a clone that has neither runs nothing and fails
 * nothing. With them it runs exactly as it always has.
 */
import { existsSync } from 'node:fs';
import { relative } from 'node:path';
import { aNetworkIsNamed, theNetwork } from '../src/midnight/network.js';

/** The network a run is asked to use, and whether it was named for the run rather than taken from the build. */
export interface TheRun {
  readonly named: boolean;
  readonly network: string;
}

/** What one check needs beyond the network: where its funded wallet's seed is kept, for the network it runs on. */
export interface Waits {
  readonly fundedSeedFor?: (network: string) => string;
}

/** This process's run, read through the one resolver of the network. */
export const thisRun = (): TheRun => ({ named: aNetworkIsNamed(), network: theNetwork() });

/**
 * Each thing the check waits for that is not there, in words a reader can act on; empty when it can run.
 * The seed is looked for only once a network is named, because where it is kept depends on the network.
 */
export const whatIsMissing = (
  run: TheRun,
  waits: Waits,
  root: string,
  exists: (path: string) => boolean = existsSync,
): string[] => {
  if (!run.named) return ['MIDNIGHT_NETWORK_ID naming the network to run against'];
  if (waits.fundedSeedFor === undefined) return [];
  const seed = waits.fundedSeedFor(run.network);
  return exists(seed) ? [] : [`a funded wallet's seed at ${relative(root, seed)}`];
};

/** The line a check prints when it stands down, naming what it waits for. */
export const standDownLine = (check: string, missing: readonly string[]): string =>
  `  ${check} stands down [needs ${missing.join('; ')}]`;

/** Stands the check down, exiting 0, when anything it waits for is missing; otherwise returns and the check runs. */
export const standDownWhenMissing = (
  check: string,
  missing: readonly string[],
  print: (line: string) => void = console.log,
  exit: (code: number) => never = process.exit,
): void => {
  if (missing.length === 0) return;
  print(standDownLine(check, missing));
  exit(0);
};
