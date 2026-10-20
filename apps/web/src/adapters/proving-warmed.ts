import { theVaultBuilder } from './vault-builder.js';

let warming: Promise<void> | null = null;

/**
 * Starts the vault builder in the background and has it fetch and check the
 * public parameters the circuits need, so a first deposit does not wait on them.
 * Shows nothing and asks the person nothing; a failure is silent, because the
 * proof that needs the files fetches them again and refuses by name. It runs
 * once while the files are held or on the way, and again at the next call after
 * a failure. It is its own file so the page loads it only when somebody has
 * signed in, and the first download does not carry the builder.
 */
export const warmTheProving = (): void => {
  if (warming !== null) return;
  const going = theVaultBuilder().then(async (w) => { await w.provingWarmed?.(); });
  warming = going;
  going.catch(() => { if (warming === going) warming = null; });
};
