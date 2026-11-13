/**
 * Test de fumée de l'application lancée (npm run start), sur les données de démonstration
 * (npm run seed) : npm run smoke -w @posts-auto/web
 *
 * Ouvre une vraie session par le parcours de connexion (services), puis vérifie chaque page
 * comme le ferait un navigateur, y compris l'isolation entre clients et les images.
 */
import { DEFAULT_DATABASE_URL, asSystem, createDatabase } from '@posts-auto/db';
import { consumeLoginLink, requestLoginLink } from '@posts-auto/services';

const BASE = process.env['APP_URL'] ?? 'http://localhost:3000';
const db = createDatabase(process.env['DATABASE_URL'] ?? DEFAULT_DATABASE_URL, { maxConnections: 2 });
let failures = 0;

function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '✔' : '✘'} ${label}${ok || detail === '' ? '' : ` — ${detail}`}`);
  if (!ok) failures += 1;
}

async function sessionFor(email: string): Promise<string> {
  const now = new Date();
  const link = await requestLoginLink(db, email, now);
  if (link.kind !== 'send') throw new Error(`Pas de lien pour ${email} (${link.kind}) : lancez d'abord npm run seed`);
  const outcome = await consumeLoginLink(db, link.token, now, { userAgent: 'smoke-test' });
  if (!outcome.ok) throw new Error('Connexion refusée');
  return outcome.session.sessionToken;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

async function get(path: string, token?: string): Promise<Response> {
  // Nom du cookie : « session » en développement, « __Host-session » en production.
  const cookie = token ? `session=${token}; __Host-session=${token}` : undefined;
  return fetch(`${BASE}${path}`, { redirect: 'manual', headers: cookie ? { cookie } : {} });
}

try {
  const health = await get('/sante');
  check('/sante répond', health.status === 200 && ((await health.json()) as { ok: boolean }).ok);

  const anonymous = await get('/');
  check('sans session : redirection vers /connexion', anonymous.status === 307 && (anonymous.headers.get('location') ?? '').includes('/connexion'));
  check('en-têtes de sécurité présents', anonymous.headers.get('x-frame-options') === 'DENY');

  const loginPage = await get('/connexion');
  check('page de connexion', loginPage.status === 200 && (await loginPage.text()).includes('Recevoir mon lien'));

  const jp = await sessionFor('jp@demo.example.test');
  const home = await get('/', jp);
  const homeHtml = await home.text();
  check('« Mes posts » de JP', home.status === 200 && homeHtml.includes('Mes posts') && homeHtml.includes('document unique'));
  check('phrase de départ affichée (VAL-04)', /Partira .* si validé/.test(homeHtml));
  check('marqueur à compléter signalé', homeHtml.includes('passage à compléter'));

  const posts = await asSystem(db, (trx) =>
    trx
      .selectFrom('posts as p')
      .innerJoin('workspaces as w', 'w.id', 'p.workspace_id')
      .innerJoin('organizations as o', 'o.id', 'w.org_id')
      .innerJoin('post_versions as v', 'v.id', 'p.current_version_id')
      .select(['p.id', 'p.workspace_id', 'v.body'])
      .where('o.name', '=', 'Démo Secutop')
      .execute(),
  );
  const withMarker = posts.find((p) => p.body.includes('[À COMPLÉTER'));
  const withPhotos = posts.find((p) => p.body.includes('formation SST'));
  if (!withMarker || !withPhotos) throw new Error('Données de démonstration incomplètes');

  const detail = await get(`/posts/${withMarker.id}`, jp);
  const detailHtml = await detail.text();
  check('détail : marqueur surligné (VAL-03)', detail.status === 200 && detailHtml.includes('class="marker"'));
  check('détail : validation bloquée tant que le marqueur reste', /<button[^>]*disabled[^>]*>Valider/.test(detailHtml));

  const alexis = await sessionFor('alexis@demo.example.test');
  const team = await get(`/equipe/${withMarker.workspace_id}`, alexis);
  check('vue équipe (VAL-07)', team.status === 200 && (await team.text()).includes('Vue équipe'));

  const claire = await sessionFor('claire@demo.example.test');
  const claireHome = await (await get('/', claire)).text();
  check('photos dans « Mes posts » de Claire', claireHome.includes('/media/'));
  const assetId = /\/media\/([0-9a-f-]{36})/.exec(claireHome)?.[1];
  const image = await get(`/media/${assetId}`, claire);
  check('image servie à une personne de l’espace', image.status === 200 && image.headers.get('content-type') === 'image/png');
  check('image refusée sans session', (await get(`/media/${assetId}`)).status === 404);

  // Validation par le formulaire, comme un navigateur sans JavaScript (action serveur + contrôle d'origine).
  const toValidate = posts.find((p) => p.body.includes('document unique'));
  if (toValidate) {
    const page = await (await get(`/posts/${toValidate.id}`, jp)).text();
    const form = [...page.matchAll(/<form[^>]*>([\s\S]*?)<\/form>/g)].find((m) => /<button[^>]*>Valider<\/button>/.test(m[1] ?? ''));
    const fields = new FormData();
    for (const input of (form?.[1] ?? '').matchAll(/<input type="hidden" name="([^"]+)"(?: value="([^"]*)")?/g)) {
      fields.append(decodeEntities(input[1] ?? ''), decodeEntities(input[2] ?? ''));
    }
    const cookie = `session=${jp}; __Host-session=${jp}`;
    const forged = await fetch(`${BASE}/posts/${toValidate.id}`, {
      method: 'POST',
      body: fields,
      redirect: 'manual',
      headers: { cookie, origin: 'https://site-malveillant.example' },
    });
    const stillPending = await asSystem(db, (trx) => trx.selectFrom('posts').select('status').where('id', '=', toValidate.id).executeTakeFirstOrThrow());
    check('CSRF : formulaire envoyé depuis un autre site refusé', forged.status >= 400 && stillPending.status === 'a_valider');

    const submitted = await fetch(`${BASE}/posts/${toValidate.id}`, { method: 'POST', body: fields, redirect: 'manual', headers: { cookie, origin: BASE } });
    const after = await asSystem(db, (trx) => trx.selectFrom('posts').select(['status', 'decided_as_delegate']).where('id', '=', toValidate.id).executeTakeFirstOrThrow());
    check(
      'validation par le formulaire : post validé, retour avec message',
      after.status === 'valide' && (submitted.headers.get('location') ?? '').includes('message=valide'),
      `HTTP ${submitted.status}, statut ${after.status}`,
    );
  }

  // REC-01 : une personne d'un autre client ne voit ni le post ni l'image.
  await asSystem(db, (trx) =>
    trx
      .insertInto('users')
      .values({ email: 'exterieur@demo.example.test', full_name: 'Autre client' })
      .onConflict((oc) => oc.column('email').doUpdateSet({ full_name: 'Autre client' }))
      .execute(),
  );
  const outsider = await sessionFor('exterieur@demo.example.test');
  check('REC-01 : post d’un autre client → 404', (await get(`/posts/${withPhotos.id}`, outsider)).status === 404);
  check('REC-01 : image d’un autre client → 404', (await get(`/media/${assetId}`, outsider)).status === 404);
} finally {
  await db.destroy();
}

console.log(failures === 0 ? '\nTout est conforme.' : `\n${failures} vérification(s) en échec.`);
process.exitCode = failures === 0 ? 0 : 1;
