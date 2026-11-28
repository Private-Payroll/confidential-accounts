/*
 * THE COMPANY'S CHOICE OF SERVICE, AS AN ACT IN THE WALLET READS IT: whether an act may ask the page for the record, and
 * the one reader (`vaults-web-shared/company-service-here`) the page reads it with too.
 */
import { OUR_SERVICE, serviceInForce, type ServiceOpener } from '../../../../src/midnight/company-service-record.js';
import { companyServiceFiledHere, type ServiceRead } from '../../../../packages/web-shared/src/company-service-here.js';
import { intentShapeOf } from 'midnight-identity/profile/act-shape';
import { listsRoute, SERVICE_CHOICE_READS } from 'midnight-identity/profile/act-intents';
import type { CompanyReach } from './company-reach.js';
import type { StepContext } from './definition.js';

export {
  companyServiceFiledHere,
  serviceFromVersions,
  serviceOpenerFor,
  serviceVersionsFrom,
  versionsNamedIn,
  type ServiceFiled,
  type ServiceRead,
  type ServiceUnread
} from '../../../../packages/web-shared/src/company-service-here.js';

/**
 * **THE COMPANY'S CHOICE OF SERVICE, AS THIS WALLET READS IT** from the company's own record of it, beside the
 * company's anchored records, which say every version that exists (`serviceFromVersions`). Our service is the
 * answer only when those records show none was ever filed. A version they name that was not served, or any read
 * that fails, leaves the choice unread, which refuses the service path and leaves the chain path open. An act
 * that may not ask the page for the record asks nothing and is our service: that is the act's own list, which
 * no answer of the service can change.
 */
export async function companyServiceHere(
  r: Pick<CompanyReach, 'accountId' | 'records' | 'judges' | 'label' | 'account' | 'companyKeys' | 'roster'> & {
    readonly opener: ServiceOpener;
  },
  ctx: Pick<StepContext, 'intent'>
): Promise<ServiceRead> {
  const shape = intentShapeOf(ctx.intent.name);
  if (shape === undefined || SERVICE_CHOICE_READS.some((route) => !listsRoute(shape, route))) {
    return {
      choice: OUR_SERVICE,
      unchosen: "this act does not read the company's choice of service, so its calls go through ours"
    };
  }
  const filed = await companyServiceFiledHere(r);
  return 'unread' in filed ? { unread: filed.unread } : serviceInForce(filed.versions, filed.needed);
}
