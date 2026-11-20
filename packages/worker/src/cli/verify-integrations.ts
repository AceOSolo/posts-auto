/**
 * Recette des services externes en production : npm run verifier-integrations -w @posts-auto/worker
 * (dans l'image : « verifier-integrations »). Lecture seule : rien n'est publié, envoyé ni
 * facturé. Chaque ligne : ✔ en ordre, ✘ à corriger, – non configuré (facultatif ou simulé).
 * Code de sortie 1 si une vérification échoue. Voir docs/recette-integrations.md.
 */
import { verifyAnthropicModel } from '@posts-auto/ai';
import { DEFAULT_DATABASE_URL, asSystem, createDatabase } from '@posts-auto/db';
import { sql } from 'kysely';
import { TokenCipher } from '../secrets/token-cipher.ts';

type Outcome = { readonly status: 'ok' | 'ko' | 'skip'; readonly label: string; readonly detail?: string };
const env = process.env;
const results: Outcome[] = [];
const ok = (label: string, detail?: string) => results.push({ status: 'ok', label, ...(detail && { detail }) });
const ko = (label: string, detail: string) => results.push({ status: 'ko', label, detail });
const skip = (label: string, detail: string) => results.push({ status: 'skip', label, detail });

async function check(label: string, run: () => Promise<string | undefined | void>): Promise<void> {
  try {
    const detail = await run();
    ok(label, detail ?? undefined);
  } catch (error) {
    ko(label, error instanceof Error ? error.message : String(error));
  }
}

async function getJson(url: string, headers: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, unknown> };
}

const appUrl = (env['APP_URL'] ?? '').replace(/\/$/, '');
const db = createDatabase(env['DATABASE_URL'] ?? DEFAULT_DATABASE_URL, { maxConnections: 1 });

try {
  // --- Application ---
  if (!appUrl.startsWith('https://')) ko('APP_URL en https', appUrl || 'APP_URL absente');
  else
    await check('Application joignable (APP_URL/sante)', async () => {
      const response = await fetch(`${appUrl}/sante`, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    });

  await check('Base de données et migrations', async () => {
    const row = await sql<{ n: number; last: string }>`select count(*)::int as n, max(name) as last from migrations.kysely_migration`.execute(db);
    return `${row.rows[0]?.n} migrations, dernière : ${row.rows[0]?.last}`;
  });

  await check('Clé de chiffrement des jetons (SEC-02)', async () => {
    const cipher = TokenCipher.fromEnv(env);
    if (cipher.decrypt(cipher.encrypt('essai', 'recette'), 'recette') !== 'essai') throw new Error('chiffrement incohérent');
    const sample = await asSystem(db, (trx) => trx.selectFrom('social_tokens').select(['account_id', 'access_token_enc']).limit(1).executeTakeFirst());
    if (sample !== undefined) cipher.decrypt(sample.access_token_enc, sample.account_id);
    return sample === undefined ? 'aucun jeton encore enregistré' : 'jetons enregistrés lisibles';
  });

  // --- IA ---
  if (env['AI_MODE'] !== 'anthropic') skip('Anthropic', 'AI_MODE n’est pas « anthropic » : IA simulée');
  else if (!env['ANTHROPIC_API_KEY']) ko('Anthropic', 'ANTHROPIC_API_KEY absente');
  else
    await check('Anthropic : clé et modèle', async () => {
      const model = await verifyAnthropicModel(env['ANTHROPIC_API_KEY'] as string, env['AI_MODEL'] || 'claude-opus-5-5');
      return `${model.name} (${model.id})`;
    });

  if (env['IMAGE_MODE'] === 'higgsfield') {
    if (env['HIGGSFIELD_API_KEY_ID'] && env['HIGGSFIELD_API_KEY_SECRET']) ok('Higgsfield : clés présentes', 'vérifiées à la première image générée');
    else ko('Higgsfield', 'HIGGSFIELD_API_KEY_ID et HIGGSFIELD_API_KEY_SECRET obligatoires');
  } else skip('Images générées', env['IMAGE_MODE'] === 'fake' ? 'simulées' : 'désactivées');

  // --- E-mails ---
  if (!env['BREVO_API_KEY'] || !env['MAIL_FROM']) ko('Brevo', 'BREVO_API_KEY et MAIL_FROM obligatoires : sans eux, aucun e-mail ne part');
  else
    await check('Brevo : clé et expéditeur validé', async () => {
      const headers = { 'api-key': env['BREVO_API_KEY'] as string, accept: 'application/json' };
      const account = await getJson('https://api.brevo.com/v3/account', headers);
      if (account.status !== 200) throw new Error(`clé refusée (HTTP ${account.status})`);
      const senders = await getJson('https://api.brevo.com/v3/senders', headers);
      const list = (senders.body['senders'] as { email?: string; active?: boolean }[] | undefined) ?? [];
      const sender = list.find((s) => s.email?.toLowerCase() === (env['MAIL_FROM'] as string).toLowerCase());
      if (sender === undefined) throw new Error(`${env['MAIL_FROM']} n’est pas un expéditeur déclaré chez Brevo`);
      if (sender.active === false) throw new Error(`${env['MAIL_FROM']} n’est pas encore validé chez Brevo`);
      return String(account.body['companyName'] ?? 'compte Brevo');
    });

  // --- Paiement ---
  if (env['BILLING_MODE'] === 'fake') skip('Stripe', 'BILLING_MODE=fake : paiement simulé');
  else if (!env['STRIPE_SECRET_KEY']) ko('Stripe', 'STRIPE_SECRET_KEY absente : la souscription est impossible');
  else {
    const headers = { authorization: `Bearer ${env['STRIPE_SECRET_KEY']}` };
    await check('Stripe : clé', async () => {
      const balance = await getJson('https://api.stripe.com/v1/balance', headers);
      if (balance.status !== 200) throw new Error(`clé refusée (HTTP ${balance.status})`);
      return env['STRIPE_SECRET_KEY']?.startsWith('sk_live_') ? 'clé live' : 'clé de test';
    });
    await check('Stripe : prix des formules et des packs', async () => {
      const plans = await asSystem(db, (trx) => trx.selectFrom('plans').select(['key', 'stripe_price_monthly', 'stripe_price_yearly']).where('active', '=', true).execute());
      const packs = await asSystem(db, (trx) => trx.selectFrom('quota_pack_offers').select(['key', 'stripe_price']).where('active', '=', true).execute());
      const ids = [...plans.flatMap((p) => [p.stripe_price_monthly, p.stripe_price_yearly]), ...packs.map((p) => p.stripe_price)].filter((id): id is string => id !== null);
      if (ids.length === 0) throw new Error('aucun prix Stripe renseigné dans les formules (décision 0007)');
      for (const id of ids) {
        const price = await getJson(`https://api.stripe.com/v1/prices/${encodeURIComponent(id)}`, headers);
        if (price.status !== 200) throw new Error(`prix ${id} introuvable chez Stripe`);
        if (price.body['active'] !== true) throw new Error(`prix ${id} inactif chez Stripe`);
      }
      return `${ids.length} prix vérifiés`;
    });
    if (!env['STRIPE_WEBHOOK_SECRET']?.startsWith('whsec_')) ko('Stripe : secret du webhook', 'STRIPE_WEBHOOK_SECRET absent ou mal formé');
    else
      await check('Stripe : webhook déclaré', async () => {
        const hooks = await getJson('https://api.stripe.com/v1/webhook_endpoints?limit=100', headers);
        const endpoint = ((hooks.body['data'] as { url?: string; status?: string; enabled_events?: string[] }[] | undefined) ?? []).find((h) => h.url === `${appUrl}/api/stripe/webhook`);
        if (endpoint === undefined) throw new Error(`aucun webhook vers ${appUrl}/api/stripe/webhook`);
        if (endpoint.status !== 'enabled') throw new Error('webhook désactivé');
        const needed = ['checkout.session.completed', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'invoice.paid', 'invoice.payment_failed'];
        const events = endpoint.enabled_events ?? [];
        const missing = events.includes('*') ? [] : needed.filter((e) => !events.includes(e));
        if (missing.length > 0) throw new Error(`événements manquants : ${missing.join(', ')}`);
      });
  }

  // --- LinkedIn ---
  if (env['LINKEDIN_MODE'] === 'fake') skip('LinkedIn', 'LINKEDIN_MODE=fake : rien ne part chez LinkedIn');
  else if (!env['LINKEDIN_CLIENT_ID'] || !env['LINKEDIN_CLIENT_SECRET']) ko('LinkedIn', 'LINKEDIN_CLIENT_ID et LINKEDIN_CLIENT_SECRET obligatoires');
  else {
    ok('LinkedIn : application configurée', `adresse de retour à déclarer : ${appUrl}/comptes/connecter/retour`);
    await check('LinkedIn : connexions des comptes', async () => {
      const rows = await asSystem(db, (trx) => trx.selectFrom('social_accounts').select(['status', sql<number>`count(*)::int`.as('n')]).groupBy('status').execute());
      const by = Object.fromEntries(rows.map((r) => [r.status, r.n]));
      if ((by['expired'] ?? 0) > 0) throw new Error(`${by['expired']} compte(s) à reconnecter`);
      return rows.length === 0 ? 'aucun compte connecté' : rows.map((r) => `${r.n} ${r.status}`).join(', ');
    });
  }

  // --- Connexions facultatives ---
  for (const [name, id, secret, discovery] of [
    ['Google', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'https://accounts.google.com/.well-known/openid-configuration'],
    ['Microsoft', 'MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET', 'https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration'],
  ] as const) {
    if (env['SSO_MODE'] === 'fake') skip(`Connexion ${name}`, 'simulée');
    else if (!env[id]) skip(`Connexion ${name}`, 'non configurée (facultative)');
    else if (!env[secret]) ko(`Connexion ${name}`, `${secret} absent`);
    else
      await check(`Connexion ${name}`, async () => {
        const doc = await getJson(discovery, {});
        if (doc.status !== 200) throw new Error(`fournisseur injoignable (HTTP ${doc.status})`);
        return `adresse de retour à déclarer : ${appUrl}/connexion/sso/${name.toLowerCase()}/retour`;
      });
  }
  if (env['CANVA_MODE'] === 'fake') skip('Canva', 'simulé');
  else if (!env['CANVA_CLIENT_ID']) skip('Canva', 'non configuré (facultatif)');
  else if (!env['CANVA_CLIENT_SECRET']) ko('Canva', 'CANVA_CLIENT_SECRET absent');
  else ok('Canva : intégration configurée', `adresse de retour à déclarer : ${appUrl}/visuels/canva/retour`);

  if (!env['SUPPORT_EMAIL']) ko('Adresse du support (SUPPORT_EMAIL)', 'absente : les signalements de contenu ne sont pas reçus');
  else ok('Adresse du support', env['SUPPORT_EMAIL']);
} finally {
  await db.destroy();
}

const mark = { ok: '✔', ko: '✘', skip: '–' } as const;
for (const r of results) console.log(`${mark[r.status]} ${r.label}${r.detail ? ` : ${r.detail}` : ''}`);
const failures = results.filter((r) => r.status === 'ko').length;
console.log(failures === 0 ? '\nTout ce qui est configuré est en ordre.' : `\n${failures} point(s) à corriger.`);
process.exitCode = failures === 0 ? 0 : 1;
