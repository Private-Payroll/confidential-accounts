/**
 * What does the wallet in THIS browser actually do?
 *
 * Read-only on purpose. It connects, asks four questions and stops — no
 * transaction is built, balanced or submitted, and nothing is spent. The
 * questions it answers are the ones no amount of reading the API can settle,
 * because they are about a specific extension on a specific machine:
 *
 *   1. is a Midnight wallet injected at all, and which one
 *   2. what network does it think it is on — the one this build is on is not
 *      a given
 *   3. does it implement `getProvingProvider`, i.e. can it prove for us
 *   4. does it advertise a proof server, which we will refuse either way
 *
 * The answers are POSTed back to the dev server so they land in a report file
 * rather than needing to be copied out of a console by hand.
 */
import { NETWORK } from 'midnight-identity/network';

const out = document.getElementById('out')!;
const lines: string[] = [];
const say = (s: string) => { lines.push(s); out.textContent = lines.join('\n'); };
const result: Record<string, unknown> = {};

const send = async () => {
  try {
    await fetch('/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: lines.join('\n'), result }),
    });
  } catch { /* the page still shows it; the file is a convenience */ }
};

const button = (label: string, onClick: () => void) => {
  const b = document.createElement('button');
  b.textContent = label;
  b.style.cssText = 'display:block;margin:14px 0;padding:10px 18px;font:inherit;cursor:pointer';
  b.onclick = onClick;
  document.body.appendChild(b);
  return b;
};

async function main() {
  const injected = (window as any).midnight;
  result.injected = !!injected;

  if (!injected) {
    say('No Midnight wallet is injected into this page.');
    say('');
    say('If Lace is installed, it may not have permission for localhost, or the');
    say('extension may need enabling for this site. Brave Shields can also block');
    say('extension injection on some sites — try lowering Shields for localhost.');
    result.ok = false;
    return;
  }

  const wallets = Object.values(injected).filter((w: any) => w && typeof w.connect === 'function');
  result.wallets = wallets.map((w: any) => ({ rdns: w.rdns, name: w.name, apiVersion: w.apiVersion }));
  say(`Wallets injected: ${wallets.length}`);
  for (const w of wallets as any[]) say(`  ${w.name}  (${w.rdns}, connector API ${w.apiVersion})`);
  say('');

  if (!wallets.length) { result.ok = false; return; }

  say('Click Connect below. Lace will ask for permission — this is read-only,');
  say('nothing is built, signed, submitted or spent.');

  await new Promise<void>((resolve) => {
    button('Connect wallet', () => resolve());
  });

  const w: any = wallets[0];
  let api: any;
  try {
    /*
     * The network id is passed to `connect`, and a wallet may simply not have
     * this network. That is a real possible outcome rather than an error in our
     * code, so it is caught and reported as an answer.
     *
     * The name comes from the one reader rather than being typed here. A probe
     * that asked a wallet for a different network from the one this build is on
     * would report on a connection nothing else in this pair could use.
     */
    api = await w.connect(NETWORK);
    result.connected = true;
    say('');
    say('Connected.');
  } catch (e: any) {
    result.connected = false;
    result.connectError = String(e?.message ?? e);
    say('');
    say('Connect failed: ' + result.connectError);
    say('If this mentions the network, the wallet may not support Stagenet —');
    say('which is an answer, not a bug.');
    result.ok = false;
    return;
  }

  try {
    const config = await api.getConfiguration();
    result.networkId = config?.networkId;
    result.indexerUri = config?.indexerUri;
    result.substrateNodeUri = config?.substrateNodeUri;
    result.proverServerUri = config?.proverServerUri ?? null;
    say('');
    say(`network       ${config?.networkId}`);
    say(`indexer       ${config?.indexerUri}`);
    say(`node          ${config?.substrateNodeUri}`);
    say(`proof server  ${config?.proverServerUri ?? '(none advertised)'}`);
  } catch (e: any) {
    result.configError = String(e?.message ?? e);
    say('getConfiguration failed: ' + result.configError);
  }

  /*
   * The question that decides who proves. Lace is expected to say no here —
   * confirmed by Midnight staff — and that is precisely the case our design
   * handles by proving in the page ourselves.
   */
  result.hasGetProvingProvider = typeof api.getProvingProvider === 'function';
  say('');
  say(`getProvingProvider present: ${result.hasGetProvingProvider}`);
  say(result.hasGetProvingProvider
    ? '  → this wallet can prove for us. Worth measuring against our own prover.'
    : '  → this wallet cannot prove. We prove in the page ourselves, which is'
      + '\n    exactly what M-77 and M-87 established works.');

  try {
    const addr = await api.getShieldedAddresses();
    // Truncated on purpose: an address is not secret, but a full one in a
    // report file that gets pasted around is needless.
    result.hasAddresses = !!addr?.shieldedCoinPublicKey;
    say('');
    say(`shielded address available: ${result.hasAddresses}`);
    if (addr?.shieldedAddress) say(`  ${String(addr.shieldedAddress).slice(0, 24)}…`);
  } catch (e: any) {
    result.addressError = String(e?.message ?? e);
    say('getShieldedAddresses failed: ' + result.addressError);
  }

  result.canBalance = typeof api.balanceUnsealedTransaction === 'function';
  result.canSubmit = typeof api.submitTransaction === 'function';
  say('');
  say(`balanceUnsealedTransaction present: ${result.canBalance}`);
  say(`submitTransaction present:          ${result.canSubmit}`);

  result.ok = result.connected === true && result.canBalance === true && result.canSubmit === true;
}

main()
  .catch((e) => { result.ok = false; result.error = String(e?.stack ?? e?.message ?? e); say('\nFAILED: ' + result.error); })
  .then(async () => {
    say('');
    say(result.ok ? 'DONE — the browser can balance and submit.' : 'DONE — see above.');
    (window as any).__RESULT__ = result;
    await send();
  });
