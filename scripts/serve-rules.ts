/**
 * THE RULES BOTH WAYS OF STARTING THE PRODUCT FOLLOW, IN A FILE THAT STARTS
 * NOTHING.
 *
 * The product is three things on one machine: the payroll application, the
 * service it talks to, and the wallet. Two commands start them - one read-only,
 * one that first brings up the wallet that pays - and both start them the same
 * way, from what is decided here.
 *
 * -- THE WALLET IS NEVER STARTED ON THE APPLICATION'S ORIGIN ---------------
 *
 * A wallet's keys are made for the origin it is served from. Serving it from
 * the application's origin would look like one server fewer and would bind every
 * wallet to wherever the application happens to be hosted, which is the
 * boundary the wallet exists to keep. So the two are started on two origins,
 * and settings that put both on one port are refused before anything starts.
 *
 * -- AN ORIGIN IS STARTED WHERE IT IS NAMED --------------------------------
 *
 * The origins are declared once, as the leading settings of the development
 * script. Each page is started on the port its origin names and refuses to take
 * another, so the origin the application opens the wallet at is the origin the
 * wallet is actually on - rather than whichever port happened to be free.
 *
 * -- ONE APPLICATION ORIGIN, AND WHICH APPLICATION IS ON IT ----------------
 *
 * Two applications can be served on the application's origin: the one in
 * `src/web`, and the new one being built in `apps/web`. One is served at a
 * time, on the same origin, so the server and the wallet see the same address
 * whichever it is and neither needs to know there are two. Which one is a
 * setting read here, never an argument, and when nothing sets it the
 * application in `src/web` is served exactly as before.
 */

/** The command the development script runs to start the product. */
export const LAUNCHER_COMMAND = 'tsx scripts/serve.ts';

/** The one address the pages listen on: this machine's own loopback. */
export const LOOPBACK_HOST = 'localhost';

/** One page the product serves, and how it is started. */
export interface PageStart {
  readonly label: string;
  /** The setting that names this page's origin. */
  readonly setting: string;
  /** The origin it is served on, normalised. */
  readonly origin: string;
  /** The executable and its arguments, relative to the repository root. */
  readonly command: readonly string[];
}

/** The setting that names which application is served on `APP_ORIGIN`. */
export const PAGE_SETTING = 'PAYROLL_PAGE';

/**
 * The applications that can be served on `APP_ORIGIN`, and the arguments that
 * point the page server at each one's own configuration. `src/web`'s is the
 * default configuration file, so it needs none.
 */
export const APPLICATION_PAGES = {
  legacy: { label: 'the payroll application', config: [] as readonly string[] },
  web: { label: 'the new payroll application', config: ['--config', 'apps/web/vite.config.ts'] as readonly string[] },
} as const;

export type ApplicationPage = keyof typeof APPLICATION_PAGES;

/**
 * Which application to serve, read from the setting, or why it cannot be.
 *
 * **UNSET MEANS `src/web`**, so every command that does not set it serves what
 * it always served. A value that names neither application is refused rather
 * than taken as the default, because a person who set it meant something.
 */
export function applicationPageFrom(settings: Record<string, string | undefined>):
  { page: ApplicationPage } | { refusal: string } {
  const value = settings[PAGE_SETTING];
  if (value === undefined || value === '') return { page: 'legacy' };
  if (Object.hasOwn(APPLICATION_PAGES, value)) return { page: value as ApplicationPage };
  return {
    refusal: `${PAGE_SETTING} is "${value}", which names no application. It is one of `
      + `${Object.keys(APPLICATION_PAGES).join(', ')}, or unset for the application in src/web`,
  };
}

/** Every leading `NAME=VALUE` of a script, including ones assigned nothing. */
export function leadingAssignments(script: string): Array<{ name: string; value: string }> {
  const lead = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*/.exec(script)?.[0] ?? '';
  return lead.split(/\s+/).filter(Boolean).map((a) => {
    const eq = a.indexOf('=');
    return { name: a.slice(0, eq), value: a.slice(eq + 1) };
  });
}

/** What a script runs once its leading settings are taken off. */
export function commandOf(script: string): string {
  const lead = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*/.exec(script)?.[0] ?? '';
  return script.slice(lead.length).trim();
}

/**
 * An origin this machine can serve on its loopback, normalised, or the reason
 * it cannot be.
 */
export function servableOrigin(setting: string, value: string | undefined):
  { origin: string; port: string } | { refusal: string } {
  if (!value) return { refusal: `${setting} is not set` };
  let u: URL;
  try { u = new URL(value); } catch { return { refusal: `${setting} is "${value}", which is not an origin` }; }
  if (u.protocol !== 'http:') {
    return { refusal: `${setting} is "${value}"; a page started on this machine is served over http` };
  }
  const host = u.hostname;
  if (host !== 'localhost' && !host.endsWith('.localhost')) {
    return {
      refusal: `${setting} is "${value}", and a page started here listens only on this machine, `
        + 'so it would be served somewhere that origin does not reach',
    };
  }
  if (!u.port) return { refusal: `${setting} is "${value}", which names no port to start it on` };
  if (u.pathname !== '/' || u.search || u.hash || u.username || u.password) {
    return { refusal: `${setting} is "${value}", which is more than an origin` };
  }
  return { origin: u.origin, port: u.port };
}

/**
 * The application and the wallet, each on the origin its setting names, or
 * every reason they cannot be started.
 *
 * `page` is which application goes on the application's origin; the origin
 * itself does not change with it.
 *
 * **THE PAGE OPENS THE WALLET AT `VITE_WALLET_ORIGIN`, AND THE WALLET IS
 * STARTED AT `WALLET_ORIGIN`.** The two are one decision declared twice - once
 * for the server, once for the page - so they must agree, or the page opens a
 * wallet where nothing is listening.
 */
export function pageStartsFor(settings: Record<string, string | undefined>, page: ApplicationPage = 'legacy'):
  { starts: PageStart[] } | { refusals: string[] } {
  const refusals: string[] = [];
  const app = servableOrigin('APP_ORIGIN', settings.APP_ORIGIN);
  const wallet = servableOrigin('WALLET_ORIGIN', settings.WALLET_ORIGIN);
  const opened = servableOrigin('VITE_WALLET_ORIGIN', settings.VITE_WALLET_ORIGIN);
  for (const r of [app, wallet, opened]) if ('refusal' in r) refusals.push(r.refusal);
  if ('origin' in wallet && 'origin' in opened && wallet.origin !== opened.origin) {
    refusals.push(
      `the page opens the wallet at ${opened.origin} (VITE_WALLET_ORIGIN) and the wallet would be `
      + `started at ${wallet.origin} (WALLET_ORIGIN), so the page would open a wallet where nothing is listening`);
  }
  if ('origin' in app && 'origin' in wallet && app.port === wallet.port) {
    refusals.push(
      `the application (${app.origin}) and the wallet (${wallet.origin}) are on one port. The wallet `
      + 'is served on an origin of its own, because its keys are made for the origin it is served from');
  }
  if (refusals.length > 0 || !('origin' in app) || !('origin' in wallet)) return { refusals };
  const pinned = (port: string) => ['--host', LOOPBACK_HOST, '--port', port, '--strictPort'];
  return {
    starts: [
      {
        label: APPLICATION_PAGES[page].label, setting: 'APP_ORIGIN', origin: app.origin,
        command: ['node_modules/.bin/vite', ...APPLICATION_PAGES[page].config, ...pinned(app.port)],
      },
      {
        label: 'the wallet', setting: 'WALLET_ORIGIN', origin: wallet.origin,
        command: ['npm', 'run', 'wallet', '--', ...pinned(wallet.port)],
      },
    ],
  };
}

/**
 * **EVERY ORIGIN A SCRIPT NAMES THAT THE DEVELOPMENT SCRIPT DOES NOT START.**
 *
 * The defect this exists for: the development script named the wallet's origin
 * and started only the application and its service, so a person following it
 * had a page that opened a wallet nothing was serving. The development script is
 * the one command that starts the product, so every origin any script names -
 * where a page is served, where the page opens the wallet, and which page the
 * wallet agrees to sit inside - must be an origin that command starts.
 */
export function originsNotStarted(scripts: Record<string, string>): string[] {
  const dev = scripts.dev ?? '';
  const devSettings = Object.fromEntries(leadingAssignments(dev).map(a => [a.name, a.value]));
  const started = new Set<string>();
  if (commandOf(dev) === LAUNCHER_COMMAND) {
    const plan = pageStartsFor(devSettings);
    if ('starts' in plan) for (const s of plan.starts) started.add(s.origin);
  }
  const out: string[] = [];
  for (const [name, script] of Object.entries(scripts)) {
    for (const a of leadingAssignments(script)) {
      /* A setting whose value is not a web address is a switch, not an origin. */
      if (!a.name.endsWith('_ORIGIN') || !/^https?:\/\//.test(a.value)) continue;
      let origin: string;
      try { origin = new URL(a.value).origin; } catch { origin = a.value; }
      if (!started.has(origin)) {
        out.push(`"${name}" names ${a.name}=${a.value}, and "dev" starts nothing there`);
      }
    }
  }
  return out;
}

/**
 * What the server said about itself, held to what the command that started it
 * promised.
 *
 * **THE READ-ONLY COMMAND STOPS IF THE SERVER SAYS IT CAN WRITE.** Nothing it
 * runs hands the server a wallet, and this is not the thing that prevents one;
 * it is the thing that notices if that ever stops being true, before a page is
 * offered to anybody.
 */
export function refuseWhatTheServerSaid(
  promised: 'can write' | 'cannot write', said: string, port: number,
): string | null {
  if (promised === 'can write') {
    return said.includes('reading and writing')
      ? null
      : `the server did not say it can write. It said: "${said || 'nothing, on port ' + port}". `
        + 'No company can be created from the screen in this state. Nothing has been spent.';
  }
  if (said === '') {
    return `the server did not answer on port ${port}, so the page and the wallet were not started.`;
  }
  return said.includes('reading and writing')
    ? `the server says it can write: "${said}". This command starts the product read-only, `
      + 'so nothing was started beside it and it has been stopped. Nothing has been spent.'
    : null;
}
