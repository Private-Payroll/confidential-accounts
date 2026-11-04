import { Amount, AMOUNT_KIND, Section, SectionRow, useText } from 'vaults-ui';
import type { RunLeg } from '../adapters/company-records.js';

/**
 * WHAT PAYING A LEG OR A SINGLE PAYMENT MAKES PUBLIC ON THE NETWORK, shown before the payment is made. Whatever the form, the network
 * shows that the company's account called the vault to make the payment, how many payments left it (for a run, one for each person, so
 * anyone can count the people paid), and the vault's count of payments going up. A private payment hides the addresses paid and the
 * amounts, but not what a watcher who has seen the vault's earlier payments can work out, nor, on a vault with a spending policy, which
 * band of the policy the total falls in. A public payment puts every address and amount on a record anyone can read: each is listed,
 * with the Public mark. Names are the company's own record and are never on the network, so they are only here. `payment` is set for
 * a single one-off payment, whose sentences speak of one payment and not of a run.
 */
export function PublicFacts({ leg, vaultName, payment = false }: { leg: RunLeg; vaultName: string; payment?: boolean }) {
  const t = useText();
  const open = leg.form === 'unshielded';
  return (
    <Section title={t('publicFacts.title')} empty={null} data-part="public-facts" data-public-facts={open ? 'public' : 'private'}>
      <SectionRow data-fact="vault">{payment ? t('publicFacts.payment.vault', { vault: vaultName }) : t('publicFacts.vault', { vault: vaultName })}</SectionRow>
      <SectionRow data-fact="count">{payment ? t('publicFacts.payment.count') : t('publicFacts.count', { count: leg.people })}</SectionRow>
      <SectionRow data-fact="counter">{t('publicFacts.counter')}</SectionRow>
      {open ? null : <SectionRow data-fact="hidden">{t('publicFacts.private.hidden')}</SectionRow>}
      {open ? null : <SectionRow data-fact="inference">{t('publicFacts.private.inference')}</SectionRow>}
      {open ? null : <SectionRow data-fact="band">{payment ? t('publicFacts.payment.band') : t('publicFacts.private.band')}</SectionRow>}
      {open ? <SectionRow data-fact="public-says">{payment ? t('publicFacts.payment.public.says') : t('publicFacts.public.says')}</SectionRow> : null}
      {open ? leg.pays.map((p, i) => (
        <SectionRow key={i} data-public-pay>
          <span className="text-muted-foreground" data-name>{p.name}</span>
          <span className="break-all" data-address>{p.address ?? t('publicFacts.public.noAddress')}</span>
          {p.amount === null ? <span>{t('records.unrecognisedOne')}</span> : <Amount value={p.amount} kind={AMOUNT_KIND.toBePaid} />}
        </SectionRow>
      )) : null}
      {open ? <SectionRow data-fact="names">{t('publicFacts.public.names')}</SectionRow> : null}
    </Section>
  );
}
