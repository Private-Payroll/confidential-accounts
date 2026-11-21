/**
 * **WHAT THE COMPANY'S VAULT ROUTES ANSWER, AS A DEVICE TAKES IT**: a refusal keeps the service's mark of whether
 * anything was sent, and a service that gives no answer is passed on as it is, so a hand-over can read the chain and go
 * around it; every records key the service reports is checked against the roster this device opened before the vault's
 * secret is wrapped to it. A committee is never checked against the roster: it is the super admins' keys, the
 * company's own choice, and a key no signer holds is as good as any.
 */
import { CompanyChangedMeanwhile } from './company-view-probe.js';
import { whyNotTheReaders, type Roster } from './handover-check.js';
import type { VaultService } from './vault-service.js';
import { serviceNotReached } from './hand-over.js';

/**
 * Whether a refusal says this send was never handed over: the service's own words, a mark the refusal already carries
 * (a check that stopped the send before it left marks it so), or a view's check that found the company changed, which
 * refuses at the head of a write, before any of it is sent.
 */
const thisSendNotSent = (e: unknown, message: string): boolean => {
  const marks = e as { nothingWasSent?: unknown; thisSendNotSent?: unknown } | null;
  return marks?.nothingWasSent === true || marks?.thisSendNotSent === true || e instanceof CompanyChangedMeanwhile || /Nothing was sent/u.test(message);
};

/**
 * A refusal keeps whether anything was sent, the service's status and code, and the refusal itself as its cause, so a
 * hand-over sees a service that took nothing and goes to the chain. A service that gave no answer at all is passed on
 * as it is, so a hand-over can read the chain and go around it too.
 */
export const marked = async <T>(call: () => Promise<T>): Promise<T> => {
  try {
    return await call();
  } catch (e) {
    if (serviceNotReached(e)) throw e;
    const message = (e as Error)?.message ?? String(e);
    const x = e as { readonly status?: unknown; readonly code?: unknown } | null;
    throw Object.assign(new Error(message, { cause: e }), {
      nothingWasSent: thisSendNotSent(e, message),
      ...(typeof x?.status === 'number' ? { status: x.status } : {}),
      ...(typeof x?.code === 'string' ? { code: x.code } : {}),
    });
  }
};

type VaultKeys = Awaited<ReturnType<VaultService['keys']>>;

/**
 * The vault keys `served` reads, refused before anything is built when a records key among their readers is one the
 * roster `roster` opens on this device does not name.
 */
export const keysCheckedAgainst = async (served: () => Promise<VaultKeys>, roster: () => Promise<Roster>): Promise<VaultKeys> => {
  const [keys, named] = await Promise.all([served(), roster()]);
  const refused = whyNotTheReaders(keys.readers ?? [], named);
  if (refused !== null) throw new Error(`${refused} Nothing was built or sent.`);
  return keys;
};
