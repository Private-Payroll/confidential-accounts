import { useText } from 'vaults-ui';
import { Signers } from '../actions/signers.js';
import { useDay } from '../records/parts.js';
import { useSession } from '../session.js';

/**
 * SETTINGS > COMPANY, THE PART BUILT SO FAR: the day the company shown was
 * created, as the service lists it. The rest of the section is not built yet
 * and says so below.
 */
export function CompanyCreated() {
  const t = useText();
  const day = useDay();
  const { companies, company } = useSession();
  const shown = companies.find((c) => c.id === company);
  if (shown === undefined) return null;
  return <p className="text-sm" data-company-created>{t('settingsCompany.created', { date: day(shown.createdAt) })}</p>;
}

/**
 * SETTINGS > SIGNERS AND APPROVALS, THE PART BUILT SO FAR: what anyone can
 * look up about a company's signers, and the signers component (where each
 * stands, the invitations waiting for approvals, Finish adding, Add a signer,
 * and who holds the company, with the change of the super admins a vault may
 * be owed), which the wizard's signers step draws too. Choosing how many must
 * approve is not built yet and says so below.
 */
export function SignersBuilt() {
  const t = useText();
  return (
    <>
      <p className="text-sm text-muted-foreground" data-public-facts>{t('settingsSigners.publicFacts')}</p>
      <Signers />
    </>
  );
}
