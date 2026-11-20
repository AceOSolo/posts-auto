import { publicPlans, simulatePrice } from '@posts-auto/services';
import type { Metadata } from 'next';
import Link from 'next/link';
import { appUrl, database } from '../../../server/context.ts';
import { requestDemoAction } from '../site/actions.ts';

export const dynamic = 'force-dynamic';

const TITLE = 'LinkedIn posts written by AI, approved by you, published on time';
const DESCRIPTION =
  'Editorial planning, LinkedIn posts written by AI in each person’s voice, one-click approval by every account holder, automatic publishing. For SMEs, mid-size companies and agencies.';

/** SIT-09 : version anglaise du site vitrine (le service lui-même reste en français). */
export const metadata: Metadata = {
  title: { absolute: `Rostra · ${TITLE}` },
  description: DESCRIPTION,
  robots: { index: true, follow: true },
  alternates: { canonical: '/en', languages: { fr: '/', en: '/en' } },
  openGraph: { title: TITLE, description: DESCRIPTION, type: 'website', locale: 'en_GB', siteName: 'Rostra' },
};

const FAQ: readonly { q: string; a: string }[] = [
  { q: 'Can a post go out without my approval?', a: 'No. Every post is sent to the account holder, who approves, edits or rejects it. Without approval, nothing is published.' },
  {
    q: 'Can the AI make up figures or references?',
    a: 'It is instructed never to invent anything: when information is missing, it leaves a [TO COMPLETE] marker that blocks publishing until it is handled. A second automatic review checks the text before you see it.',
  },
  { q: 'Do I have to share my LinkedIn password?', a: 'No. Each holder connects their profile, or the pages they manage, through LinkedIn’s official authorisation, and can revoke it at any time.' },
  { q: 'Can I manage several clients?', a: 'Yes: the Agency plan gives one workspace per client, each with its own editorial line, accounts, planning and team, plus a usage export for rebilling.' },
  { q: 'How is pricing calculated?', a: 'Per active LinkedIn account (profile or page), with a number of AI-written posts per account and per month, shared across the workspace. Monthly or yearly billing.' },
  { q: 'Is the service available in English?', a: 'The application and the AI writing are in French for now; English is planned according to client demand.' },
];

const STEPS: readonly [string, string][] = [
  ['Planning', 'You set your highlights, events and topics; the AI fills in with ideas and your news watch.'],
  ['AI writing', 'Posts for the next two weeks are written in each account’s voice, with their visual.'],
  ['Approval', 'Each holder approves, edits or rejects; nothing goes out without their consent.'],
  ['Publishing', 'At the scheduled time, on LinkedIn; you follow statistics and monthly insights.'],
];

const euros = (cents: number) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'EUR', maximumFractionDigits: cents % 100 === 0 ? 0 : 2 }).format(cents / 100);
const int = (value: string | string[] | undefined, fallback: number) => {
  const n = Number.parseInt(typeof value === 'string' ? value : '', 10);
  return Number.isInteger(n) && n >= 0 && n <= 500 ? n : fallback;
};

export default async function EnglishLandingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const plans = await publicPlans(database());
  const profiles = int(query['profiles'], 3);
  const pages = int(query['pages'], 1);
  const simulation = simulatePrice(plans, profiles, pages);
  const sent = query['message'] === 'demo-envoyee';
  const failed = typeof query['message'] === 'string' && !sent;
  const jsonLd = [
    { '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: 'Rostra', applicationCategory: 'BusinessApplication', operatingSystem: 'Web', description: DESCRIPTION, url: `${appUrl()}/en`, inLanguage: 'en' },
    { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: FAQ.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) },
  ];

  return (
    <main className="site-main" lang="en">
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: données structurées produites ici, sans contenu saisi. */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c') }} />
      <p>
        <Link href="/" hrefLang="fr" lang="fr">
          Version française
        </Link>
      </p>
      <div className="hero">
        <h1>Your LinkedIn posts written by AI, approved by you, published on time.</h1>
        <p className="lead">
          Every week, the AI writes the posts of your executives, experts and company pages, in each person’s voice. Every holder approves in seconds on their phone; publishing is
          automatic.
        </p>
        <div className="actions">
          <Link href="/inscription" className="button primary">
            14-day free trial
          </Link>
          <a href="#demo" className="button">
            Book a demo
          </a>
        </div>
        <p className="hint">No credit card. 3 LinkedIn accounts and 10 posts during the trial. The application is in French.</p>
      </div>

      <section aria-labelledby="how">
        <h2 id="how">How it works</h2>
        <ol className="steps-list">
          {STEPS.map(([title, text]) => (
            <li key={title}>
              <h3>{title}</h3>
              <p>{text}</p>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="pricing">
        <h2 id="pricing">Pricing</h2>
        <p className="hint">Prices excluding VAT, per active LinkedIn account (profile or page). Monthly or yearly billing, by card or SEPA direct debit.</p>
        <ul className="plan-grid">
          {plans.map((p) => (
            <li key={p.key}>
              <h3>{p.name}</h3>
              <p className="price">{p.priceMonthlyCents === null ? 'On request' : `${euros(p.priceMonthlyCents)} / account / month`}</p>
              <ul>
                <li>{p.postsPerAccount} AI-written posts per account per month</li>
                <li>{p.maxWorkspaces === null ? 'Unlimited client workspaces' : 'One workspace'}</li>
              </ul>
            </li>
          ))}
        </ul>
        <h3 id="calculator">Price calculator</h3>
        <form method="get" action="/en#calculator" className="inline-fields">
          <label>
            LinkedIn profiles
            <input name="profiles" type="number" min={0} max={500} defaultValue={profiles} />
          </label>
          <label>
            Company pages
            <input name="pages" type="number" min={0} max={500} defaultValue={pages} />
          </label>
          <button type="submit">Calculate</button>
        </form>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Plan</th>
                <th scope="col">Monthly price (excl. VAT)</th>
                <th scope="col">Yearly (per month)</th>
                <th scope="col">Posts written per month</th>
              </tr>
            </thead>
            <tbody>
              {simulation.map((s) => (
                <tr key={s.plan.key}>
                  <th scope="row">{s.plan.name}</th>
                  <td>{s.monthlyCents === null ? 'on request' : euros(s.monthlyCents)}</td>
                  <td>{s.yearlyMonthlyCents === null ? '—' : euros(s.yearlyMonthlyCents)}</td>
                  <td>{s.postsPerMonth}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="hint">{`For ${simulation[0]?.accounts ?? 1} account${(simulation[0]?.accounts ?? 1) > 1 ? 's' : ''}.`}</p>
      </section>

      <section aria-labelledby="faq-en">
        <h2 id="faq-en">Frequently asked questions</h2>
        <dl className="faq">
          {FAQ.map((f) => (
            <div key={f.q}>
              <dt>{f.q}</dt>
              <dd>{f.a}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section id="demo" aria-labelledby="demo-en">
        <h2 id="demo-en">Book a demo</h2>
        {sent && (
          <p className="flash success" role="status">
            Thank you: your request has been sent, we will get back to you shortly.
          </p>
        )}
        {failed && (
          <p className="flash error" role="alert">
            Your request could not be sent: please check your name, company and e-mail address.
          </p>
        )}
        <form action={requestDemoAction} className="stack">
          <input type="hidden" name="langue" value="en" />
          <label>
            Name
            <input name="nom" required maxLength={120} autoComplete="name" />
          </label>
          <label>
            Company
            <input name="entreprise" required maxLength={160} autoComplete="organization" />
          </label>
          <label>
            Business e-mail
            <input name="email" type="email" required autoComplete="email" />
          </label>
          <label>
            Phone
            <input name="telephone" type="tel" maxLength={40} autoComplete="tel" />
          </label>
          <label>
            Number of LinkedIn accounts
            <input name="comptes" type="number" min={1} max={10000} />
          </label>
          <label>
            Message (optional)
            <textarea name="message" rows={3} maxLength={2000} />
          </label>
          <label className="visually-hidden-field" aria-hidden="true">
            Website
            <input name="site" tabIndex={-1} autoComplete="off" />
          </label>
          <p className="hint">
            Your details are only used to contact you about this demo (<Link href="/confidentialite">privacy policy, in French</Link>).
          </p>
          <button type="submit" className="primary">
            Send my request
          </button>
        </form>
      </section>
    </main>
  );
}
