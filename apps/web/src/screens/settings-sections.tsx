import { Section, useText } from 'vaults-ui';
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
  return (
    <Section title={t('page.settingsCompany.name')} description={<span data-company-created>{t('settingsCompany.created', { date: day(shown.createdAt) })}</span>} list={false} box={false}>
      {null}
    </Section>
  );
}

/**
 * SETTINGS > SIGNERS AND APPROVALS: what anyone can look up about a
 * company's signers, and the signers component (where each stands, the
 * invitations waiting for approvals, the approvals the company asks for and the
 * control that changes them, Finish adding, Add a signer, and who holds the
 * company, with the change of the super admins a vault may be owed), which the
 * wizard's signers step draws too.
 */
export function SignersBuilt() {
  const t = useText();
  return (
    <Section title={t('page.settingsSigners.name')} description={<span data-public-facts>{t('settingsSigners.publicFacts')}</span>} list={false} box={false}>
      <Signers />
    </Section>
  );
}
