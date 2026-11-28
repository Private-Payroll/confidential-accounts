/**
 * **THE PAGE'S ASKS THAT ARE NOT ONE COMPANY'S RECORDS READ THROUGH ITS VIEW**, bound to the page's one transport: a
 * company being created, an invitation taken before its taker is one of the company's members, a super admin's change
 * asked by a link, and the calls the wallet hands the page to send for it. Each ask and its path is named in
 * `records-source.ts`; this file only binds them to the page. The person's own asks are bound in `person-on-page.ts`.
 */
import {
  creationAsks,
  invitationSource,
  superAdminAsks,
  type CreationAsks,
  type InvitationSource,
  type SuperAdminAsks
} from './records-source.js';
import { indexerNamedByTheWallet } from './chain-before-a-view.js';
import { serviceAnswered, serviceCall, type PageSend } from './service-transport.js';

/** A company's creation, asked as the page's `api` answers. */
export const creationOnPage: CreationAsks<unknown> = creationAsks(serviceCall);

/** An invitation's own asks, each answered with its status, for the person `signedInAs`. */
export const invitationOnPage = (signedInAs: () => string | null): InvitationSource => {
  const send = serviceAnswered(signedInAs);
  return invitationSource((method, path, body) => send(path, { method, ...(body === undefined ? {} : { body }) }));
};

/**
 * The super admins' change of the company `company`, asked as the page's `api` answers, and the indexer the person's
 * wallet at `walletOrigin` names for it: a super admin holds no view of the company, so this is their one read of it.
 */
export const superAdminOnPage = (company: string, walletOrigin: string): SuperAdminAsks =>
  superAdminAsks(serviceCall, company, (where) => indexerNamedByTheWallet(walletOrigin, where));

/** A call the wallet hands the page to send, as it named it. */
interface WalletCall {
  readonly method: 'GET' | 'PUT' | 'POST';
  readonly path: string;
  readonly body?: string;
}

/**
 * The calls the wallet hands the page in an action, each sent as the wallet named it, for the person `signedInAs`; the
 * service holds each to the sign-in it carries.
 */
export const walletCallsOnPage = (signedInAs: () => string | null) => {
  const send = serviceAnswered(signedInAs);
  return (request: WalletCall): ReturnType<PageSend> =>
    send(request.path, { method: request.method, ...(request.body === undefined ? {} : { body: request.body }) });
};
