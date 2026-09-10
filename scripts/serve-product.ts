/**
 * STARTING THE PRODUCT: THE SERVER, THEN THE APPLICATION AND THE WALLET.
 *
 * Shared by both commands that start it - the read-only one and the one that
 * first brings up the wallets that pay - so the two cannot drift into starting
 * different products.
 *
 * **NOTHING HERE CAN GIVE THE SERVER A WALLET.** The server asks for a pair once,
 * while it is being loaded, and answers read-only when none was handed over.
 * Handing one over is a separate step only the wallet-holding command takes,
 * before it calls anything in this file; this file neither takes that step nor
 * reads anything that could.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';

import type { PageStart } from './serve-rules.js';

const children: ChildProcess[] = [];

/** Stop every page this process started. */
export const stopChildren = (): void => {
  for (const c of children) { try { c.kill('SIGTERM'); } catch { /* gone */ } }
};

let installed = false;
/**
 * **CLOSING THE COMMAND STOPS EVERYTHING IT STARTED.** A page left running after
 * its server has gone is a page that answers every press with an error.
 */
export function stopEverythingOnExit(): void {
  if (installed) return;
  installed = true;
  process.on('exit', stopChildren);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => { stopChildren(); process.exit(130); });
  }
}

/**
 * Load the server in this process, wait for it to answer, and return what it
 * says it is running - `''` if it never answered.
 *
 * **IMPORTED FOR WHAT EVALUATING IT DOES, AND NOTHING IS TAKEN FROM IT.** The
 * server builds its ledger and starts listening while it is being evaluated.
 * Named by file so the scripts' typecheck, which is looser than the server's
 * own, does not re-check the server under settings it was not written for.
 */
export async function startTheServer(root: string): Promise<{ said: string; port: number }> {
  await import(pathToFileURL(join(root, 'src', 'server', 'index.ts')).href);
  const port = Number(process.env.PORT ?? 8787);
  let said = '';
  for (let i = 0; i < 30 && !said; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
      said = String((await r.json())?.ledger ?? '');
    } catch { /* not listening yet */ }
  }
  return { said, port };
}

/**
 * Start each page on the origin it was planned for.
 *
 * **ON THIS MACHINE'S OWN LOOPBACK, ON THE NAMED PORT, AND ON NO OTHER.** A page
 * that took the next free port would be on an origin nothing else knows about.
 */
export function startThePages(
  root: string, starts: readonly PageStart[], env: NodeJS.ProcessEnv,
): void {
  for (const s of starts) {
    const [bin, ...args] = s.command;
    const exe = bin.includes('/') ? join(root, bin) : bin;
    children.push(spawn(exe, args, { cwd: root, env, stdio: 'inherit' }));
  }
}
