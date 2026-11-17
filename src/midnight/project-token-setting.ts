/*
 * A network reached through a project token takes the token from the process
 * that reaches it. The service's launcher reads `.env` itself, but a one-off
 * tool started on this machine has only its own environment, and would be
 * refused for a token sitting in `.env` beside it. This reads that one token,
 * by the name each network's record gives it, from `.env` when the process
 * does not already carry it, and reads nothing else from the file: no other
 * line of `.env` reaches the process this way.
 *
 * The file and path modules are taken from the running process when a value is
 * read, never imported at the top: this file is reached from the wallet's and
 * the web application's builds through the network module, and a browser has
 * no such modules to load.
 */
import { buildSetting } from 'midnight-identity/profile/origin';
import { NETWORK_IDS, networkRecord } from '../core/networks.js';

const nodeFs = (): typeof import('node:fs') => process.getBuiltinModule('node:fs');
const nodePath = (): typeof import('node:path') => process.getBuiltinModule('node:path');

/** The names network records give their project tokens. */
const TOKEN_SETTINGS: ReadonlySet<string> = new Set(NETWORK_IDS.flatMap((id) => {
  const token = networkRecord(id).endpoints?.projectToken;
  return token === null || token === undefined ? [] : [token.setting];
}));

/**
 * The value `.env` at `path` gives `name` (its last line for it, `export` allowed, quotes and a trailing ` # note`
 * taken off), or undefined when it gives none or an empty one, so the record refuses by the setting's name.
 */
const valueIn = (path: string, name: string): string | undefined => {
  const { existsSync, readFileSync } = nodeFs();
  if (!existsSync(path)) return undefined;
  let found: string | undefined;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim().replace(/^export\s+/u, '');
    if (!line.startsWith(`${name}=`)) continue;
    const value = line.slice(name.length + 1).trim();
    const quoted = value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0];
    found = quoted ? value.slice(1, -1) : value.replace(/\s+#.*$/u, '');
  }
  return found === '' ? undefined : found;
};

/**
 * A setting as this process has it; for a network's project token only, and only when the process has none, as `.env`
 * in the folder it runs from gives it. Pass it to `endpointsOf` wherever a tool on this machine reaches a network.
 */
export const settingOrProjectToken = (
  env?: Record<string, string | undefined>,
  path?: string,
): ((name: string) => unknown) => {
  /* A page has no process and no .env beside it: it reads its settings as every other page read does. */
  if (env === undefined && typeof process === 'undefined') return buildSetting;
  const settings = env ?? process.env;
  const file = path ?? nodePath().join(process.cwd(), '.env');
  return (name: string): unknown => settingFrom(settings, file, name);
};

const settingFrom = (env: Record<string, string | undefined>, path: string, name: string): unknown => {
  const set = env[name];
  if (set !== undefined) return set;
  return TOKEN_SETTINGS.has(name) ? valueIn(path, name) : undefined;
};
