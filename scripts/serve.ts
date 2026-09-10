/**
 * START THE PRODUCT, READ-ONLY: THE SERVICE, THE PAYROLL APPLICATION AND THE
 * WALLET, EACH ON ITS OWN ORIGIN.
 *
 * This is what the development script runs. It brings up no wallet and hands the
 * server nothing, so the server can read a chain and cannot write to one; it
 * checks that the server says so before it offers a page to anybody.
 *
 * The origins come from the settings the development script declares. Each page
 * is started on the port its origin names and on this machine only.
 */
import { join } from 'node:path';

import { pageStartsFor, refuseWhatTheServerSaid } from './serve-rules.js';
import { startTheServer, startThePages, stopChildren, stopEverythingOnExit } from './serve-product.js';

const ROOT = join(import.meta.dirname, '..');
const line = (s = '') => console.log(s);

async function main() {
  stopEverythingOnExit();

  const plan = pageStartsFor(process.env);
  if ('refusals' in plan) {
    throw new Error(
      'the product cannot be started:\n\n  ' + plan.refusals.join(';\n\n  ')
      + '.\n\nThese settings are declared by the development script; start the product with it.');
  }

  const { said, port } = await startTheServer(ROOT);
  const refusal = refuseWhatTheServerSaid('cannot write', said, port);
  if (refusal) throw new Error(refusal);

  startThePages(ROOT, plan.starts, process.env);
  line();
  for (const s of plan.starts) line(`  ${s.label.padEnd(24)} ${s.origin}`);
  line(`  ${'the service'.padEnd(24)} http://localhost:${port}`);
  line();
  line('  Read-only: nothing can be written to a chain from this server.');
  line('  Stopping this stops the service, the application and the wallet.');
  line();
}

main().catch((e: any) => {
  stopChildren();
  line();
  line('  THE PRODUCT WAS NOT STARTED.');
  line();
  line(`  ${String(e?.message ?? e)}`);
  line();
  process.exit(1);
});
