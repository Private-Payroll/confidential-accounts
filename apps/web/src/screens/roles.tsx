import { Section, useText } from 'vaults-ui';
import { ReadAccess } from '../records/read-access.js';
import { RolesList } from '../records/roles-list.js';

/** The Roles and permissions tab of Settings: what each role may do and who holds it, changing a signer's role, and who reads the company's records. */
export function Roles() {
  const t = useText();
  return (
    <Section title={t('page.settingsRoles.name')} list={false} box={false} data-screen="roles">
      <RolesList />
      <ReadAccess />
    </Section>
  );
}
