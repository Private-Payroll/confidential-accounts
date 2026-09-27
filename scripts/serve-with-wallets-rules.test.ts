/**
 * **WHAT THE STAGENET LAUNCHER REFUSES BEFORE IT BRINGS ANY WALLET UP, AND
 * THE ORDER IT DOES THINGS IN.**
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parametersBeforeServing, postureFrom, refuseToServe, seedsAreOneParty, POSTURE_REQUIRED } from './serve-with-wallets-rules.js';
import { refuseIncompleteSetup } from './create-company-rules.js';
import { servedCircuits } from '../src/server/proving-parameters.js';

const ROOT = join(import.meta.dirname, '..');
const ALL_PRESENT = {
  fundedSeed: true, maintenanceAuthority: true,
  compiledContract: true, proofServer: true,
};
const DEV = String(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts.dev);

describe('the posture is read off the development script', () => {
  /*
   * RED WHEN: `ALLOW_SIMULATED_COMPANY_ADDRESS` is carried - a server that can
   * spend would accept a company whose address this machine invented.
   */
  it('carries the origins and leaves the simulated-address allowance behind', () => {
    const p = postureFrom(DEV);
    for (const name of POSTURE_REQUIRED) expect(p[name], `${name} not read`).toBeTruthy();
    expect(p).not.toHaveProperty('ALLOW_SIMULATED_COMPANY_ADDRESS');
    expect(postureFrom('ALLOW_SIMULATED_COMPANY_ADDRESS=1 A=b sh -c x'))
      .toEqual({ A: 'b' });
  });

  /* RED WHEN: an empty assignment is carried as a value, or the command is read as posture. */
  it('reads only leading assignments with a value', () => {
    expect(postureFrom('A= B=2 tsx x.ts C=3')).toEqual({ B: '2' });
  });
});

describe('refusals before anything is brought up', () => {
  /* RED WHEN: the network check is removed. */
  it('refuses any network but stagenet', () => {
    const r = refuseToServe({ network: 'preview', present: ALL_PRESENT, posture: postureFrom(DEV) });
    expect(r).toMatch(/serves stagenet and nothing else/);
    expect(r).toMatch(/nothing has been spent/i);
  });

  /* RED WHEN: the posture check is removed. */
  it('refuses a development script that no longer declares the origins', () => {
    const r = refuseToServe({ network: 'stagenet', present: ALL_PRESENT, posture: { APP_ORIGIN: 'x' } });
    expect(r).toMatch(/WALLET_ORIGIN, VITE_WALLET_ORIGIN/);
  });

  /* RED WHEN: machine preconditions stop being asked, or only the first refusal is named. */
  it('names every missing piece at once, its own and the machine\'s', () => {
    const r = refuseToServe({
      network: 'preview', posture: {},
      present: { ...ALL_PRESENT, proofServer: false, fundedSeed: false },
    })!;
    expect(r).toMatch(/serves stagenet/);
    expect(r).toMatch(/no longer declares/);
    expect(r).toMatch(/no proof server is reachable/);
    expect(r).toMatch(/no funded wallet/);
  });

  /* RED WHEN: a complete machine is refused. */
  it('answers null when everything is in place', () => {
    expect(refuseToServe({ network: 'stagenet', present: ALL_PRESENT, posture: postureFrom(DEV) }))
      .toBeNull();
  });

  /*
   * RED WHEN: the launcher asks for a company wallet again. It brings none up,
   * and the company creator still needs one.
   */
  it('does not ask for a company wallet, while the company creator still does', () => {
    expect(refuseToServe({ network: 'stagenet', present: ALL_PRESENT, posture: postureFrom(DEV) })).toBeNull();
    expect(refuseIncompleteSetup({ ...ALL_PRESENT, companySeed: false })).toMatch(/no wallet for the company itself/);
  });

  /* RED WHEN: a copy that differs only in space, case or a leading 0x is taken for a second wallet. */
  it('counts two seeds as one wallet when only their spelling differs', () => {
    const one = 'not-a-secret: a test literal ab12';
    expect(seedsAreOneParty(one, `  ${one.toUpperCase()}\n`)).toBe(true);
    expect(seedsAreOneParty('0xab12', 'AB12')).toBe(true);
    expect(seedsAreOneParty('ab12', 'ab13')).toBe(false);
  });

  /*
   * RED WHEN: origins the product cannot be started on reach the slow part -
   * a wallet on the application's own origin would be refused only after the
   * paying wallet had synced.
   */
  it('refuses origins it cannot start before anything is brought up', () => {
    const onePort = { ...postureFrom(DEV), WALLET_ORIGIN: 'http://localhost:5173', VITE_WALLET_ORIGIN: 'http://localhost:5173' };
    const r = refuseToServe({ network: 'stagenet', present: ALL_PRESENT, posture: onePort });
    expect(r).toMatch(/origins cannot be started as they are: .*are on one port/);
  });
});

describe('the launcher hands the pair over before the server exists', () => {
  const launcher = readFileSync(join(ROOT, 'scripts', 'serve-with-wallets.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  /*
   * RED WHEN: the server is imported before the hand-in. The server reads the
   * pair once while it is evaluated, so a late hand-in serves read-only and the
   * button fails in front of whoever pressed it.
   */
  it('hands in, then starts the server', () => {
    const handIn = launcher.indexOf('handInFundedParties(');
    const serve = launcher.indexOf('await startTheServer(ROOT)');
    expect(handIn).toBeGreaterThan(-1);
    expect(serve).toBeGreaterThan(-1);
    expect(handIn, 'the server is started before the pair is handed in').toBeLessThan(serve);
  });

  /*
   * RED WHEN: the launcher builds its fee payer by hand instead of through the
   * one construction that requires a fee record and uses the dust-only payer.
   */
  it('builds the fee payer through the one construction and nothing else', () => {
    expect(launcher).toMatch(/sponsor: feePayerOver\(/);
    expect(launcher).not.toMatch(/new WalletFeeSponsor|customerWalletOver|sponsorWalletOver/);
  });

  /*
   * RED WHEN: either script that pays a fee (this launcher and the company
   * creator) brings a wallet up before it has
   * read its ceiling, or builds its pair without passing the ceiling on.
   */
  it('both doors read the fee ceiling before any wallet, and hand it to the pair', () => {
    const creator = readFileSync(join(ROOT, 'scripts', 'create-company.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    for (const [name, text] of [['launcher', launcher], ['creator', creator]] as const) {
      const ceiling = text.indexOf('feeCeilingFrom(process.env)');
      const bringUp = text.indexOf('bringUpWallet(');
      expect(ceiling, `${name} does not read the ceiling`).toBeGreaterThan(-1);
      expect(ceiling, `${name} brings a wallet up before reading the ceiling`).toBeLessThan(bringUp);
      expect(text, `${name} does not pass the ceiling to the fee payer`)
        .toMatch(/(fundedPartiesOver|feePayerOver)\([\s\S]*?\bceiling,\s*\)/);
    }
  });

  /*
   * RED WHEN: the script that creates a company from this machine goes back to
   * building its own fee payer and company half - two constructions of one
   * pair, one of which can lose the fee record the other requires.
   */
  it('the script that creates a company builds its pair the same way', () => {
    const creator = readFileSync(join(ROOT, 'scripts', 'create-company.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    expect(creator).toMatch(/const \{ sponsor, customer \} = fundedPartiesOver\(/);
    expect(creator).not.toMatch(/new WalletFeeSponsor|customerWalletOver|sponsorWalletOver/);
  });

  /*
   * RED WHEN: an allowance the launcher leaves behind is still in the
   * environment when the server is imported - inherited from the shell rather
   * than declared by the script.
   */
  it('removes the settings it does not carry before the server is imported', () => {
    const removed = launcher.indexOf('for (const n of POSTURE_NOT_CARRIED) delete process.env[n];');
    const serve = launcher.indexOf('await startTheServer(ROOT)');
    expect(removed, 'the launcher does not remove them').toBeGreaterThan(-1);
    expect(removed).toBeLessThan(serve);
  });

  /* RED WHEN: the launcher stops checking the server's own account of what it can do. */
  it('refuses to report ready unless the server says it can write', () => {
    const check = launcher.indexOf("refuseWhatTheServerSaid('can write', said, port)");
    expect(check).toBeGreaterThan(-1);
    expect(check, 'the pages are started before the server is checked').toBeLessThan(launcher.indexOf('startThePages('));
  });

  /*
   * RED WHEN: the launcher brings up a company wallet again, or hands the
   * product a company side that holds keys.
   */
  it('brings up one wallet, the one that pays, and hands in a company side that holds nothing', () => {
    expect(launcher.match(/bringUpWallet\(/g) ?? []).toHaveLength(1);
    expect(launcher).not.toContain('company.seed');
    expect(launcher).not.toContain('fundedPartiesOver');
    expect(launcher).toMatch(/customer: await coinlessCustomer\(\)/);
    expect(launcher.indexOf('handInFundedParties(')).toBeLessThan(launcher.indexOf('await startTheServer(ROOT)'));
  });
});

describe('the new application\'s proving files, before it is served', () => {
  const none = { present: [], fetched: [], setAside: [], missing: [], unread: [] };
  const launcher = readFileSync(join(ROOT, 'scripts', 'serve-with-wallets.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  /* RED WHEN: a complete outcome is reported as incomplete, or a fetch is not said. */
  it('says they are in place when they are, and what it fetched', () => {
    const r = parametersBeforeServing({ ...none, present: ['bls_midnight_2p10'], fetched: [{ name: 'bls_midnight_2p9', from: 'https://srs.midnight.network', bytes: 98692 }], setAside: [{ from: '/p/bls_midnight_2p9', to: '/p/bls_midnight_2p9.not-genuine-1' }] }, '/p');
    expect(r.inPlace).toBe(true);
    expect(r.lines).toEqual([
      'fetched bls_midnight_2p9 (98692 bytes) from https://srs.midnight.network, checked against its published digest',
      '/p/bls_midnight_2p9 was not the published file; it was renamed to /p/bls_midnight_2p9.not-genuine-1 and replaced',
      'every circuit the page proves has its proving parameters here, checked',
    ]);
  });

  /* RED WHEN: a file that could not be fetched is not said, or not said with what it breaks and what fixes it. */
  it('says plainly what could not be fetched, what fails, and what fixes it', () => {
    const r = parametersBeforeServing({ ...none, missing: [{ name: 'bls_midnight_2p9', circuits: ['depositUnshielded (vault)'], why: 'https://srs.midnight.network answered 404' }] }, '/p');
    expect(r.inPlace).toBe(false);
    const said = r.lines.join('\n');
    expect(said).toMatch(/THE PAGE WILL BE SERVED, BUT NOT EVERYTHING IT PROVES WITH IS IN PLACE/);
    expect(said).toMatch(/bls_midnight_2p9 is not here and could not be fetched: https:\/\/srs.midnight.network answered 404/);
    expect(said).toMatch(/These will fail when the page proves them: depositUnshielded \(vault\)/);
    expect(said).toMatch(/MIDNIGHT_PARAM_SOURCE/);
  });

  /*
   * RED WHEN: the network's own circuits being absent is reported as a damaged
   * build, or not reported - every private deposit would fail with nothing said.
   */
  it('names the network\'s own circuits apart, because nothing fetches them', () => {
    /* The network's label as the server's own list writes it, so a renamed label is caught here and not only there. */
    const network = servedCircuits({ compiled: '/c', account: '/a', params: '/p' }).filter((c) => c.label.endsWith('(network)'));
    expect(network.length).toBeGreaterThan(0);
    const r = parametersBeforeServing({ ...none, unread: [`${network[0]!.label}: its compiled circuit is not here`, 'deposit (vault): its compiled circuit is not here'] }, '/elsewhere/params');
    expect(r.inPlace).toBe(false);
    const said = r.lines.join('\n');
    expect(said).toMatch(/network's own shielded circuits could not be read from \/elsewhere\/params\/zswap\/9, so every private deposit/);
    expect(said).toMatch(/deposit \(vault\): its compiled circuit is not here, so the page cannot prove this circuit/);
    expect(said).not.toContain(`${network[0]!.label}: its compiled circuit is not here, so the page`);
  });

  /*
   * RED WHEN: the new application is served without its proving files being put
   * in place first, the check runs after a wallet is brought up (a problem would
   * then be said minutes late), or it runs for the application in src/web, whose
   * command must keep doing exactly what it did.
   */
  it('puts them in place for the new application only, before any wallet and before any page', () => {
    const ensure = launcher.indexOf('await ensureProvingParameters(');
    expect(ensure).toBeGreaterThan(-1);
    expect(launcher.slice(launcher.lastIndexOf('if (', ensure), ensure)).toMatch(/if \(chosen\.page === 'web'\) \{/);
    expect(ensure).toBeLessThan(launcher.indexOf('bringUpWallet('));
    expect(ensure).toBeLessThan(launcher.indexOf('startThePages('));
    expect(launcher).toMatch(/if \(!parametersInPlace\) line\(/);
    /* RED WHEN: the warning's trigger is never set from what was found, so it can never print. */
    const block = launcher.slice(launcher.indexOf("if (chosen.page === 'web') {"), launcher.indexOf('bringUpWallet('));
    expect(block).toMatch(/parametersInPlace = said\.inPlace;/);
  });
});
