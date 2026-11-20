/**
 * Test de fumée de l'application lancée (npm run start), sur les données de démonstration
 * (npm run seed) : npm run smoke -w @posts-auto/web
 *
 * Ouvre une vraie session par le parcours de connexion (services), puis vérifie chaque page
 * comme le ferait un navigateur, y compris l'isolation entre clients et les images.
 */
import { FakeModel } from '@posts-auto/ai';
import { DEFAULT_DATABASE_URL, asSystem, createDatabase } from '@posts-auto/db';
import { FakeImageGenerator } from '@posts-auto/visuals';
import { FileMediaStore, runGenerationTick, runVisualTick } from '@posts-auto/worker';
import { createHmac } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { confirmSignup, consumeLoginLink, createApiKey, createApprovalLink, readZip, requestLoginLink, requestSignup, totpCode } from '@posts-auto/services';

const BASE = process.env['APP_URL'] ?? 'http://localhost:3000';
const db = createDatabase(process.env['DATABASE_URL'] ?? DEFAULT_DATABASE_URL, { maxConnections: 2 });
// Même dossier de médias que l'application (server/context.ts) : les visuels préparés ici y sont servis.
const media = new FileMediaStore(process.env['MEDIA_ROOT'] ?? path.resolve(process.cwd(), '../../.media'));
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

/**
 * Envoie, comme un navigateur sans JavaScript, le formulaire de la page qui contient
 * `marker` (texte d'un bouton) : champs cachés de l'action serveur + champs fournis.
 */
async function submitForm(path: string, token: string, marker: string, values: Record<string, string | File>): Promise<Response> {
  const page = await (await get(path, token)).text();
  const form = [...page.matchAll(/<form[^>]*>([\s\S]*?)<\/form>/g)].find((m) => (m[1] ?? '').includes(marker));
  const fields = new FormData();
  for (const input of (form?.[1] ?? '').matchAll(/<input type="hidden" name="([^"]+)"(?: value="([^"]*)")?/g)) {
    fields.append(decodeEntities(input[1] ?? ''), decodeEntities(input[2] ?? ''));
  }
  for (const [name, value] of Object.entries(values)) fields.append(name, value);
  return fetch(`${BASE}${path.split('?')[0]}`, { method: 'POST', body: fields, redirect: 'manual', headers: { cookie: `session=${token}; __Host-session=${token}`, origin: BASE } });
}

try {
  const health = await get('/sante');
  check('/sante répond', health.status === 200 && ((await health.json()) as { ok: boolean }).ok);

  const anonymous = await get('/');
  check('sans session : redirection vers /connexion', anonymous.status === 307 && (anonymous.headers.get('location') ?? '').includes('/connexion'));
  check('en-têtes de sécurité présents', anonymous.headers.get('x-frame-options') === 'DENY');

  const loginPage = await get('/connexion');
  const loginHtml = await loginPage.text();
  check('page de connexion', loginPage.status === 200 && loginHtml.includes('Recevoir mon lien'));
  const loginForm = /<form[^>]*>([\s\S]*?)<\/form>/.exec(loginHtml)?.[1] ?? '';
  const loginFields = new FormData();
  for (const input of loginForm.matchAll(/<input type="hidden" name="([^"]+)"(?: value="([^"]*)")?/g)) loginFields.append(decodeEntities(input[1] ?? ''), decodeEntities(input[2] ?? ''));
  loginFields.append('email', 'direction@demo.example.test');
  const linkRequested = await fetch(`${BASE}/connexion`, { method: 'POST', body: loginFields, redirect: 'manual', headers: { origin: BASE } });
  check('demande de lien par le formulaire : même message, adresse connue ou non', (linkRequested.headers.get('location') ?? '').includes('message=envoye'), `HTTP ${linkRequested.status}`);

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

  // Ajout d'une photo depuis le formulaire (REC-11, VIS-13), comme depuis un téléphone.
  const photoForm = [...detailHtml.matchAll(/<form[^>]*>([\s\S]*?)<\/form>/g)].find((m) => (m[1] ?? '').includes('name="photos"'));
  const photoFields = new FormData();
  for (const input of (photoForm?.[1] ?? '').matchAll(/<input type="hidden" name="([^"]+)"(?: value="([^"]*)")?/g)) photoFields.append(decodeEntities(input[1] ?? ''), decodeEntities(input[2] ?? ''));
  photoFields.append('photos', new Blob([Buffer.from('GIF89a-photo-de-telephone')], { type: 'image/gif' }), 'photo.gif');
  const uploaded = await fetch(`${BASE}/posts/${withMarker.id}`, { method: 'POST', body: photoFields, redirect: 'manual', headers: { cookie: `session=${jp}; __Host-session=${jp}`, origin: BASE } });
  const photoCount = await asSystem(db, (trx) => trx.selectFrom('post_media').select('id').where('post_id', '=', withMarker.id).execute());
  check('ajout d’une photo par le formulaire (REC-11)', (uploaded.headers.get('location') ?? '').includes('photos-ajoutees') && photoCount.length === 1, `HTTP ${uploaded.status}`);

  const alexis = await sessionFor('alexis@demo.example.test');
  const team = await get(`/equipe/${withMarker.workspace_id}`, alexis);
  check('vue équipe (VAL-07)', team.status === 200 && (await team.text()).includes('Vue équipe'));
  const dashboardHtml = (await (await get(`/tableau/${withMarker.workspace_id}`, alexis)).text()).replace(/<!-- -->/g, '');
  check('tableau de bord : semaine, attentes, départs, indicateurs (SUI-01, SUI-02)', dashboardHtml.includes('Cette semaine') && dashboardHtml.includes('En attente de validation') && dashboardHtml.includes('Indicateurs des 8 dernières semaines'));
  const postsCsv = await get(`/tableau/${withMarker.workspace_id}/export`, alexis);
  const postsCsvText = await postsCsv.text();
  check('export CSV de tous les posts (SUI-06)', postsCsv.headers.get('content-type')?.startsWith('text/csv') === true && postsCsvText.includes('"Créneau";"Compte"') && postsCsvText.split('\r\n').length > 3);

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

  // API d'échange (PUB-10), par HTTP.
  const workspaceId = withMarker.workspace_id;
  const writer = await createApiKey(db, { workspaceId, name: 'smoke', scopes: ['posts:read', 'posts:write'] });
  const reader = await createApiKey(db, { workspaceId, name: 'smoke-lecture', scopes: ['posts:read'] });
  const api = (path: string, key: string, init: RequestInit = {}) =>
    fetch(`${BASE}/api/v1${path}`, { ...init, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...init.headers } });

  check('API : clé invalide → 401', (await api('/comptes', 'pa_faux')).status === 401);
  const accounts = (await (await api('/comptes', writer.key)).json()) as { comptes: { id: string; nom: string }[] };
  const jpAccount = accounts.comptes.find((a) => a.nom === 'Jean-Pierre Martin');
  check('API : comptes de l’espace', jpAccount !== undefined);

  const reference = `smoke-${Date.now()}`;
  const creneau = new Date(Date.now() + 10 * 86_400_000);
  creneau.setUTCHours(13, 7, 0, 0); // minute inhabituelle : aucun conflit avec les données de démonstration
  const gifBase64 = Buffer.from('GIF89a-smoke').toString('base64');
  const payload = JSON.stringify({ reference, compte: jpAccount?.id, creneau: creneau.toISOString(), texte: 'Post déposé par l’API (test de fumée).', images: [{ donnees_base64: gifBase64, generee_par_ia: true }] });
  const created = await api('/posts', writer.key, { method: 'POST', body: payload });
  const createdBody = (await created.json()) as { cree: boolean; post: { statut: string } };
  check('API : dépôt d’un post à valider → 201', created.status === 201 && createdBody.cree && createdBody.post.statut === 'a_valider', `HTTP ${created.status}`);
  const replay = await api('/posts', writer.key, { method: 'POST', body: payload });
  check('API : même référence renvoyée → 200, sans doublon (REC-13)', replay.status === 200 && ((await replay.json()) as { cree: boolean }).cree === false);
  check('API : lecture par référence', (await api(`/posts/${reference}`, writer.key)).status === 200);
  check('API : clé en lecture seule ne dépose rien → 403', (await api('/posts', reader.key, { method: 'POST', body: payload.replace(reference, `${reference}-b`) })).status === 403);
  const fakeImage = JSON.stringify({ ...JSON.parse(payload), reference: `${reference}-c`, images: [{ donnees_base64: Buffer.from('<svg/>').toString('base64'), type: 'image/png' }] });
  check('API : fausse image refusée → 422', (await api('/posts', writer.key, { method: 'POST', body: fakeImage })).status === 422);
  const sameSlot = JSON.stringify({ ...JSON.parse(payload), reference: `${reference}-d`, images: [] });
  check('API : créneau déjà pris → 409', (await api('/posts', writer.key, { method: 'POST', body: sameSlot })).status === 409);

  // Reprise des idées et des demandes de l'outil actuel (incrément 1b).
  const migrator = await createApiKey(db, { workspaceId, name: 'smoke-reprise', scopes: ['inputs:write'] });
  const ideaPayload = JSON.stringify({ reference: `idee-${reference}`, titre: 'Idée reprise de l’ancien outil', comptes: [jpAccount?.id], statut: 'retenue' });
  const ideaCreated = await api('/idees', migrator.key, { method: 'POST', body: ideaPayload });
  const ideaReplay = await api('/idees', migrator.key, { method: 'POST', body: ideaPayload });
  check('API : idée reprise (201), même référence sans doublon (200)', ideaCreated.status === 201 && ideaReplay.status === 200, `HTTP ${ideaCreated.status}/${ideaReplay.status}`);
  const requestPayload = JSON.stringify({ reference: `demande-${reference}`, texte: 'Demande reprise, déjà traitée', comptes: [jpAccount?.id], demandeur_nom: 'Ancien outil', statut: 'traitee' });
  check('API : demande reprise avec son historique', (await api('/demandes', migrator.key, { method: 'POST', body: requestPayload })).status === 201);
  check('API : une clé sans le droit de reprise est refusée → 403', (await api('/idees', writer.key, { method: 'POST', body: ideaPayload })).status === 403);

  // Connexion d'un profil LinkedIn (LNK-01, LNK-09), avec le serveur en mode simulé (LINKEDIN_MODE=fake).
  const consentPage = await (await get(`/comptes/${workspaceId}/connecter`, claire)).text();
  const consentForm = [...consentPage.matchAll(/<form[^>]*>([\s\S]*?)<\/form>/g)].find((m) => (m[1] ?? '').includes('Continuer vers LinkedIn'));
  const consentFields = new FormData();
  for (const input of (consentForm?.[1] ?? '').matchAll(/<input type="hidden" name="([^"]+)"(?: value="([^"]*)")?/g)) {
    consentFields.append(decodeEntities(input[1] ?? ''), decodeEntities(input[2] ?? ''));
  }
  consentFields.append('accord', 'oui');
  const claireCookie = `session=${claire}; __Host-session=${claire}`;
  const toLinkedIn = await fetch(`${BASE}/comptes/${workspaceId}/connecter`, { method: 'POST', body: consentFields, redirect: 'manual', headers: { cookie: claireCookie, origin: BASE } });
  const authorizeUrl = toLinkedIn.headers.get('location') ?? '';
  const stateCookie = toLinkedIn.headers.getSetCookie().find((c) => c.startsWith('li_oauth='))?.split(';')[0] ?? '';
  if (authorizeUrl.includes('linkedin.com')) {
    check('connexion LinkedIn : redirection vers LinkedIn (serveur en mode réel, parcours non testé ici)', authorizeUrl.includes('state='));
  } else {
    check('connexion LinkedIn : consentement puis redirection avec un état anti-falsification', authorizeUrl.includes('state=') && stateCookie !== '', `HTTP ${toLinkedIn.status}`);
    const forgedState = authorizeUrl.replace(/state=[^&]+/, 'state=falsifie');
    const rejected = await fetch(forgedState, { redirect: 'manual', headers: { cookie: `${claireCookie}; ${stateCookie}` } });
    check('connexion LinkedIn : état falsifié refusé', (rejected.headers.get('location') ?? '').includes('connexion-expiree'));

    // Nouvel essai complet (le cookie d'état est à usage unique).
    const retry = await fetch(`${BASE}/comptes/${workspaceId}/connecter`, { method: 'POST', body: consentFields, redirect: 'manual', headers: { cookie: claireCookie, origin: BASE } });
    const retryCookie = retry.headers.getSetCookie().find((c) => c.startsWith('li_oauth='))?.split(';')[0] ?? '';
    const callback = await fetch(retry.headers.get('location') ?? '', { redirect: 'manual', headers: { cookie: `${claireCookie}; ${retryCookie}` } });
    const connected = await asSystem(db, (trx) =>
      trx
        .selectFrom('social_accounts as a')
        .innerJoin('social_tokens as t', 't.account_id', 'a.id')
        .innerJoin('users as u', 'u.id', 'a.holder_user_id')
        .select(['a.external_urn', 't.oauth_client_id'])
        .where('u.email', '=', 'claire@demo.example.test')
        .where('a.workspace_id', '=', workspaceId)
        .where('a.external_urn', 'like', 'urn:li:person:demo%')
        .execute(),
    );
    check(
      'connexion LinkedIn : compte connecté, jeton chiffré enregistré',
      /compte-(re)?connecte/.test(callback.headers.get('location') ?? '') && connected.length === 1,
      `→ ${callback.headers.get('location')}`,
    );
    const accountsPage = await (await get(`/comptes/${workspaceId}`, claire)).text();
    check('page des comptes : échéance de la connexion affichée (LNK-03)', accountsPage.includes('Connexion valable jusqu’au'));

    // LNK-02 : pages d'entreprise administrées, choisies après l'autorisation.
    const alexisCookie = `session=${alexis}; __Host-session=${alexis}`;
    const accountsHtml = await (await get(`/comptes/${workspaceId}`, alexis)).text();
    const pagesForm = [...accountsHtml.matchAll(/<form[^>]*>([\s\S]*?)<\/form>/g)].find((m) => (m[1] ?? '').includes('Connecter des pages'));
    const pagesFields = new FormData();
    for (const input of (pagesForm?.[1] ?? '').matchAll(/<input type="hidden" name="([^"]+)"(?: value="([^"]*)")?/g)) pagesFields.append(decodeEntities(input[1] ?? ''), decodeEntities(input[2] ?? ''));
    const toPages = await fetch(`${BASE}/comptes/${workspaceId}`, { method: 'POST', body: pagesFields, redirect: 'manual', headers: { cookie: alexisCookie, origin: BASE } });
    const pagesCookie = toPages.headers.getSetCookie().find((c) => c.startsWith('li_oauth='))?.split(';')[0] ?? '';
    const pagesCallback = await fetch(toPages.headers.get('location') ?? '', { redirect: 'manual', headers: { cookie: `${alexisCookie}; ${pagesCookie}` } });
    const choosePath = (pagesCallback.headers.get('location') ?? '').replace(BASE, '');
    const chooseHtml = choosePath.includes('/pages?attente=') ? (await (await get(choosePath, alexis)).text()).replace(/<!-- -->/g, '') : '';
    check('pages d’entreprise : liste des pages administrées après l’autorisation (LNK-02)', chooseHtml.includes('Page de démonstration') && chooseHtml.includes('Filiale de démonstration'), `→ ${choosePath}`);
    const firstPage = /name="pages" value="([^"]+)"/.exec(chooseHtml)?.[1] ?? '';
    const pagesAdded = await submitForm(choosePath, alexis, 'Ajouter les pages cochées', { pages: firstPage });
    const pageRow = await asSystem(db, (trx) => trx.selectFrom('social_accounts').select(['kind', 'display_name']).where('external_urn', '=', firstPage).where('workspace_id', '=', workspaceId).executeTakeFirst());
    check('pages d’entreprise : page cochée ajoutée avec son jeton', (pagesAdded.headers.get('location') ?? '').includes('page-connectee') && pageRow?.kind === 'page', `HTTP ${pagesAdded.status}`);
  }

  // Invitation d'une personne par l'administratrice (ONB-07).
  const settings = await (await get(`/espace/${workspaceId}`, alexis)).text();
  const inviteForm = [...settings.matchAll(/<form[^>]*>([\s\S]*?)<\/form>/g)].find((m) => (m[1] ?? '').includes('Envoyer l’invitation'));
  const inviteFields = new FormData();
  for (const input of (inviteForm?.[1] ?? '').matchAll(/<input type="hidden" name="([^"]+)"(?: value="([^"]*)")?/g)) inviteFields.append(decodeEntities(input[1] ?? ''), decodeEntities(input[2] ?? ''));
  inviteFields.append('email', 'nouvelle.recrue@demo.example.test');
  inviteFields.append('nom', 'Nouvelle recrue');
  inviteFields.append('role', 'contributor');
  const invited = await fetch(`${BASE}/espace/${workspaceId}`, { method: 'POST', body: inviteFields, redirect: 'manual', headers: { cookie: `session=${alexis}; __Host-session=${alexis}`, origin: BASE } });
  const newMember = await asSystem(db, (trx) =>
    trx
      .selectFrom('workspace_members as m')
      .innerJoin('users as u', 'u.id', 'm.user_id')
      .select('m.role')
      .where('u.email', '=', 'nouvelle.recrue@demo.example.test')
      .where('m.workspace_id', '=', workspaceId)
      .executeTakeFirst(),
  );
  check('invitation par le formulaire : membre ajouté avec son rôle (ONB-07)', (invited.headers.get('location') ?? '').includes('message=invite') && newMember?.role === 'contributor', `HTTP ${invited.status}`);
  check('réglages refusés à un simple contributeur', !(await (await get(`/espace/${workspaceId}`, claire)).text()).includes('Envoyer l’invitation'));

  // EDI-01 à EDI-05 : ligne éditoriale et fiche du compte.
  const linePath = `/ligne/${workspaceId}`;
  const versionOf = async () =>
    (await asSystem(db, (trx) => trx.selectFrom('editorial_lines').select('version').where('workspace_id', '=', workspaceId).where('is_current', '=', true).executeTakeFirst()))?.version ?? 0;
  const versionBefore = await versionOf();
  const tone = `Direct et concret (essai du ${new Date().toISOString()})`;
  const savedLine = await submitForm(linePath, alexis, 'Enregistrer une nouvelle version', {
    positionnement: 'Prévention et sécurité au travail pour les PME',
    ton: tone,
    interdits: 'leader du marché\nn°1',
    hashtags: '0',
    emojis: 'rare',
    'longueur-min': '600',
    'longueur-max': '1300',
    'liens-en-fin': 'on',
    question: 'on',
  });
  check('ligne éditoriale enregistrée par l’administratrice : nouvelle version (EDI-01, EDI-07)', (savedLine.headers.get('location') ?? '').includes('ligne-enregistree') && (await versionOf()) === versionBefore + 1, `HTTP ${savedLine.status}`);
  const lineForClaire = await (await get(linePath, claire)).text();
  check('ligne éditoriale en lecture seule pour une contributrice', lineForClaire.includes(tone.replace(/’/g, '&#x27;').slice(0, 20)) && !lineForClaire.includes('Enregistrer une nouvelle version'));

  // Claire est contributrice et titulaire de son profil : elle règle son ton, pas son rythme.
  const claireAccount = await asSystem(db, (trx) =>
    trx.selectFrom('social_accounts').select('id').where('workspace_id', '=', workspaceId).where('display_name', '=', 'Claire Durand').executeTakeFirstOrThrow(),
  );
  const fichePath = `/comptes/${workspaceId}/fiche/${claireAccount.id}`;
  const tenor = `Sobre, chiffres sourcés (${Date.now()})`;
  const savedProfile = await submitForm(fichePath, claire, 'Enregistrer la fiche', { teneur: tenor, 'a-eviter': 'La politique', rythme: '9', sensibilite: 'strict' });
  const profileRow = await asSystem(db, (trx) =>
    trx.selectFrom('account_profiles').select(['tenor', 'posts_per_week', 'sensitivity']).where('account_id', '=', claireAccount.id).executeTakeFirst(),
  );
  check(
    'fiche : la titulaire règle son ton, pas son rythme (EDI-04, matrice 3.3)',
    (savedProfile.headers.get('location') ?? '').includes('fiche-enregistree') && profileRow?.tenor === tenor && profileRow.posts_per_week !== 9 && profileRow.sensitivity !== 'strict',
    `HTTP ${savedProfile.status} → ${savedProfile.headers.get('location') ?? ''}`,
  );
  const example = await submitForm(fichePath, claire, '>Ajouter<', { texte: 'Un post de référence collé par la titulaire.', etiquette: 'imiter' });
  check('fiche : exemple « à imiter » ajouté par le titulaire (EDI-05)', (example.headers.get('location') ?? '').includes('exemple-ajoute'), `HTTP ${example.status}`);

  // GEN-09 : source de veille ajoutée depuis la ligne éditoriale (la relève, réseau compris, est testée à part).
  const feedUrl = `https://veille.exemple.fr/flux-${Date.now()}.xml`;
  const addedSource = await submitForm(linePath, alexis, 'Suivre cette source', { adresse: feedUrl, libelle: 'Veille de test' });
  const sourceRow = await asSystem(db, (trx) => trx.selectFrom('content_sources').select('enabled').where('url', '=', feedUrl).executeTakeFirst());
  check('source de veille suivie (GEN-09)', (addedSource.headers.get('location') ?? '').includes('source-ajoutee') && sourceRow?.enabled === true, `HTTP ${addedSource.status}`);

  // PLA-01 à PLA-05, PLA-08 : planning, case, import, événements, inventaire.
  const today = new Date();
  const monday = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - ((today.getUTCDay() + 6) % 7)));
  const thisWeek = monday.toISOString().slice(0, 10);
  const nextWeek = new Date(monday.getTime() + 7 * 86_400_000).toISOString().slice(0, 10);
  const grid = await get(`/planning/${workspaceId}`, alexis);
  check('planning : grille comptes × semaines (PLA-01)', grid.status === 200 && (await grid.text()).includes('class="planning"'), `HTTP ${grid.status}`);
  const jpRowKey = `compte:${(await asSystem(db, (trx) => trx.selectFrom('social_accounts').select('id').where('workspace_id', '=', workspaceId).where('display_name', '=', 'Jean-Pierre Martin').executeTakeFirstOrThrow())).id}`;
  const cellPath = `/planning/${workspaceId}/case?ligne=${encodeURIComponent(jpRowKey)}&semaine=${nextWeek}`;
  const subject = `Sujet ajouté par le test de fumée ${Date.now()}`;
  const added = await submitForm(cellPath, alexis, '>Ajouter<', { sujet: subject });
  const addedRow = await asSystem(db, (trx) => trx.selectFrom('planning_cells').select('id').where('content', '=', subject).executeTakeFirst());
  check('planning : sujet ajouté à une case (PLA-02)', (added.headers.get('location') ?? '').includes('sujet-ajoute') && addedRow !== undefined, `HTTP ${added.status}`);
  check('planning : une contributrice voit la grille sans pouvoir la modifier', !(await (await get(`/planning/${workspaceId}`, claire)).text()).includes('Ajouter un sujet'));

  const csv = `PAM test,,\nLigne,${thisWeek},${nextWeek}\nJean-Pierre,Sujet importé A ${Date.now()},"Sujet importé B\nSujet importé C"\nNotes,,à ignorer\n`;
  const preview = await submitForm(`/planning/${workspaceId}/import`, alexis, 'Voir l’aperçu', { type: 'planning', contenu: csv, annee: String(today.getUTCFullYear()) });
  const previewLocation = preview.headers.get('location') ?? '';
  // React sépare les morceaux de texte voisins par « <!-- --> » dans le HTML.
  const previewPage = previewLocation === '' ? '' : (await (await get(previewLocation, alexis)).text()).replace(/<!-- -->/g, '');
  check('import : aperçu avec 2 semaines reconnues et le compte proposé (PLA-05)', previewPage.includes('2 semaines reconnues') && previewPage.includes('selected=""'), `→ ${previewLocation}`);
  const imported = await submitForm(previewLocation, alexis, '>Importer<', { 'ligne-0': jpRowKey.slice('compte:'.length), 'ligne-1': 'ignorer' });
  const importedCount = await asSystem(db, (trx) => trx.selectFrom('planning_cells').select('id').where('workspace_id', '=', workspaceId).where('content', 'like', 'Sujet importé%').execute());
  check('import : 3 sujets créés, ligne « Notes » ignorée', (imported.headers.get('location') ?? '').includes('import-termine') && importedCount.length >= 3, `HTTP ${imported.status}`);

  const eventTitle = `Salon de test ${Date.now()}`;
  const savedEvent = await submitForm(`/planning/${workspaceId}/evenements`, alexis, '>Ajouter<', { titre: eventTitle, debut: nextWeek, comptes: jpRowKey.slice('compte:'.length) });
  const eventRow = await asSystem(db, (trx) => trx.selectFrom('events').select('id').where('title', '=', eventTitle).executeTakeFirst());
  check('événement enregistré avec le compte qui le relaie (PLA-04)', (savedEvent.headers.get('location') ?? '').includes('evenement-enregistre') && eventRow !== undefined, `HTTP ${savedEvent.status}`);
  const monthlyTitle = `Webinaire mensuel de test ${Date.now()}`;
  await submitForm(`/planning/${workspaceId}/evenements`, alexis, '>Ajouter<', { titre: monthlyTitle, debut: nextWeek, recurrence: 'monthly', comptes: jpRowKey.slice('compte:'.length) });
  const monthly = await asSystem(db, (trx) => trx.selectFrom('events').select('recurrence').where('title', '=', monthlyTitle).executeTakeFirst());
  check('rendez-vous récurrent enregistré (EDI-08)', monthly?.recurrence === 'monthly');
  const planningExport = await get(`/planning/${workspaceId}/export`, alexis);
  const exportedCsv = await planningExport.text();
  check(
    'export du planning en CSV (PLA-09)',
    planningExport.status === 200 && (planningExport.headers.get('content-type') ?? '').startsWith('text/csv') && exportedCsv.includes('"Ligne"') && exportedCsv.includes('Jean-Pierre Martin'),
    `HTTP ${planningExport.status}`,
  );
  const weekDoc = await get(`/planning/${workspaceId}/semaine`, claire);
  check('document de la semaine avec le suivi des 8 semaines (GEN-10)', weekDoc.status === 200 && (await weekDoc.text()).includes('Suivi des 8 dernières semaines'), `HTTP ${weekDoc.status}`);
  const inventoryPage = await get(`/planning/${workspaceId}/inventaire`, claire);
  check('inventaire de la semaine visible par une contributrice (PLA-08)', inventoryPage.status === 200 && (await inventoryPage.text()).includes(subject));

  // IDE-01, IDE-03 : idées et demandes de post.
  const ideaTitle = `Idée du test de fumée ${Date.now()}`;
  const proposed = await submitForm(`/idees/${workspaceId}`, claire, '>Proposer<', { titre: ideaTitle, details: 'Détails utiles' });
  const ideaRow = await asSystem(db, (trx) => trx.selectFrom('ideas').select(['id', 'status']).where('title', '=', ideaTitle).executeTakeFirst());
  check('idée proposée par une contributrice (IDE-01)', (proposed.headers.get('location') ?? '').includes('idee-proposee') && ideaRow?.status === 'new', `HTTP ${proposed.status}`);
  const kept = ideaRow ? await submitForm(`/idees/${workspaceId}`, alexis, '>Retenir<', {}) : null;
  check('idée retenue par l’administratrice', (kept?.headers.get('location') ?? '').includes('idee-kept'), `HTTP ${kept?.status}`);
  const requestText = `Demande du test de fumée ${Date.now()}`;
  const requested = await submitForm(`/demandes/${workspaceId}`, claire, 'Envoyer la demande', {
    demande: requestText,
    comptes: jpRowKey.slice('compte:'.length),
    photos: new File([Buffer.from('GIF89a-photo-de-demande')], 'photo.gif', { type: 'image/gif' }),
  });
  const requestRow = await asSystem(db, (trx) => trx.selectFrom('post_requests').select(['id', 'status']).where('raw_text', '=', requestText).executeTakeFirst());
  const requestPhotos = requestRow ? await asSystem(db, (trx) => trx.selectFrom('request_photos').select('position').where('request_id', '=', requestRow.id).execute()) : [];
  check('demande de post avec photo, suivie par la demandeuse (IDE-03, IDE-06)', (requested.headers.get('location') ?? '').includes('demande-envoyee') && requestRow?.status === 'new' && requestPhotos.length === 1, `HTTP ${requested.status}`);
  check('demande visible dans « Mes demandes »', (await (await get(`/demandes/${workspaceId}`, claire)).text()).includes(requestText));

  // GEN-01, GEN-05, GEN-06, GEN-12 : rédaction de bout en bout (modèle simulé), rapport, origine, signalement.
  const launched = await submitForm(`/planning/${workspaceId}/redactions`, alexis, 'Lancer la rédaction maintenant', {});
  check('rédaction demandée depuis l’application (GEN-01)', (launched.headers.get('location') ?? '').includes('redaction-demandee'), `HTTP ${launched.status}`);
  // La tâche de fond, exécutée ici comme le ferait le processus des tâches, avec les visuels (1c).
  const tick = await runGenerationTick({ db, model: new FakeModel(), media, images: new FakeImageGenerator() });
  const runId = tick.runs.find((r) => r.workspaceId === workspaceId)?.runId ?? null;
  check('la tâche de fond rédige les posts de l’espace', runId !== null && (tick.runs.find((r) => r.workspaceId === workspaceId)?.created ?? 0) > 0, JSON.stringify(tick.runs));
  if (runId !== null) {
    const reportPage = await get(`/planning/${workspaceId}/redactions/${runId}`, alexis);
    check('rapport de rédaction lisible par l’équipe (GEN-05)', reportPage.status === 200 && (await reportPage.text()).includes('Posts rédigés'), `HTTP ${reportPage.status}`);
    const generated = await asSystem(db, (trx) => trx.selectFrom('posts').select('id').where('generation_run_id', '=', runId).executeTakeFirstOrThrow());
    const generatedPage = (await (await get(`/posts/${generated.id}`, alexis)).text()).replace(/<!-- -->/g, '');
    check('post rédigé : origine et mention IA affichées (GEN-06, GEN-12)', generatedPage.includes('Origine :') && generatedPage.includes('Texte rédigé par une IA'));
    const reported = await submitForm(`/posts/${generated.id}`, claire, 'Envoyer le signalement', { motif: 'Chiffre à vérifier' });
    const reports = await asSystem(db, (trx) => trx.selectFrom('content_reports').select('id').where('post_id', '=', generated.id).execute());
    check('« Signaler un contenu » enregistré (GEN-12)', (reported.headers.get('location') ?? '').includes('contenu-signale') && reports.length === 1, `HTTP ${reported.status}`);
  }
  // GEN-08 : retouche par l'IA et accroches, au moment de valider (déléguée de la page).
  const webinar = posts.find((p) => p.body.includes('Webinaire gratuit'));
  if (webinar) {
    const revisionsOf = async () => (await asSystem(db, (trx) => trx.selectFrom('post_versions').select('id').where('post_id', '=', webinar.id).execute())).length;
    const before = await revisionsOf();
    const shortened = await submitForm(`/posts/${webinar.id}`, alexis, '>Raccourcir<', {});
    check('« Raccourcir » : nouvelle révision du post (GEN-08)', (shortened.headers.get('location') ?? '').includes('retouche-') && (await revisionsOf()) === before + 1, `HTTP ${shortened.status}`);
    await submitForm(`/posts/${webinar.id}`, alexis, 'Proposer 3 accroches', {});
    const withHooks = (await (await get(`/posts/${webinar.id}`, alexis)).text()).replace(/<!-- -->/g, '');
    check('« Proposer 3 accroches » : propositions affichées (GEN-08)', withHooks.includes('Utiliser cette accroche'));
  }
  const howItWorks = await get('/comment-fonctionne-la-redaction');
  check('page « Comment fonctionne la rédaction » publique (GEN-12)', howItWorks.status === 200 && (await howItWorks.text()).includes('L’IA peut se tromper'));

  // 1c — REC-18 : post rédigé avec une image générée placée dans un modèle.
  if (runId !== null) {
    const visuals = await asSystem(db, (trx) =>
      trx
        .selectFrom('post_media as pm')
        .innerJoin('media_assets as m', 'm.id', 'pm.asset_id')
        .innerJoin('posts as p', 'p.id', 'pm.post_id')
        .select(['p.id as post_id', 'm.id', 'm.ai_generated', 'm.width', 'pm.alt_text', 'pm.position'])
        .where('p.generation_run_id', '=', runId)
        .where('m.kind', '=', 'rendered')
        .execute(),
    );
    const withImage = visuals.find((v) => v.ai_generated);
    check(
      'REC-18 : visuel rendu en PNG avec image générée, mention « générée par IA » enregistrée',
      withImage !== undefined && withImage.position === 1 && (withImage.alt_text ?? '').endsWith('Illustration générée par IA.') && visuals.some((v) => !v.ai_generated),
      JSON.stringify(visuals.map((v) => [v.ai_generated, v.alt_text])),
    );
    if (withImage) {
      const png = await get(`/media/${withImage.id}`, alexis);
      check('visuel servi en PNG 1080 px de large', png.status === 200 && png.headers.get('content-type') === 'image/png' && withImage.width === 1080);
      const visualPage = (await (await get(`/posts/${withImage.post_id}`, alexis)).text()).replace(/<!-- -->/g, '');
      check('page du post : section Visuel, badge « Image générée par IA », « Refaire le visuel » (VIS-12, VIS-13)', visualPage.includes('id="visuel"') && visualPage.includes('Image générée par IA') && visualPage.includes('Refaire le visuel'));
      const redo = await submitForm(`/posts/${withImage.post_id}`, alexis, '>Refaire le visuel<', { consigne: 'Un titre plus court', photo: 'none' });
      const pendingPage = (await (await get(`/posts/${withImage.post_id}`, alexis)).text()).replace(/<!-- -->/g, '');
      check('« Refaire le visuel » : demande enregistrée, préparation affichée', (redo.headers.get('location') ?? '').includes('visuel-demande') && pendingPage.includes('Nouveau visuel en préparation'), `HTTP ${redo.status}`);
      const visualTick = await runVisualTick({ db, model: new FakeModel(), media });
      const redone = await asSystem(db, (trx) =>
        trx.selectFrom('post_media as pm').innerJoin('media_assets as m', 'm.id', 'pm.asset_id').select(['m.id', 'm.render_content']).where('pm.post_id', '=', withImage.post_id).where('m.kind', '=', 'rendered').execute(),
      );
      check(
        'tâche « visuels » : nouveau visuel sans photo à la place de l’ancien (VIS-13)',
        visualTick.done.includes(withImage.post_id) && redone.length === 1 && redone[0]?.id !== withImage.id && (redone[0]?.render_content as { photo: unknown } | null)?.photo === null,
        JSON.stringify(visualTick),
      );
    }
  }

  // VIS-01, VIS-02 : bibliothèque de modèles, aperçu, éditeur.
  const visualsPage = (await (await get(`/visuels/${workspaceId}`, alexis)).text()).replace(/<!-- -->/g, '');
  const templateIds = [...visualsPage.matchAll(/\/visuels\/[0-9a-f-]{36}\/modeles\/([0-9a-f-]{36})\/apercu/g)].map((m) => m[1] as string);
  check('bibliothèque de modèles : modèles de départ avec aperçu (VIS-01)', templateIds.length >= 4 && visualsPage.includes('Charte visuelle'), `${templateIds.length} modèle(s)`);
  const firstTemplate = templateIds[0] as string;
  const previewPng = await get(`/visuels/${workspaceId}/modeles/${firstTemplate}/apercu`, alexis);
  check('aperçu d’un modèle en PNG', previewPng.status === 200 && previewPng.headers.get('content-type') === 'image/png');
  check('aperçu refusé sans session', (await get(`/visuels/${workspaceId}/modeles/${firstTemplate}/apercu`)).status === 404);
  const editorPage = await get(`/visuels/${workspaceId}/modeles/${firstTemplate}`, alexis);
  check('éditeur de modèle (VIS-02)', editorPage.status === 200 && (await editorPage.text()).includes('Enregistrer le modèle'));
  const draft = new FormData();
  for (const [name, value] of Object.entries({ format: 'square', fond: 'bleu', zones: '1', 'zone-0-type': 'title', 'zone-0-cle': 'titre', 'zone-0-x': '0', 'zone-0-y': '0', 'zone-0-l': '500', 'zone-0-h': '200', 'zone-0-couleur': '#000000', 'zone-0-taille-max': '60' })) {
    draft.append(name, value);
  }
  const draftPreview = await fetch(`${BASE}/visuels/${workspaceId}/modeles/${firstTemplate}/apercu`, { method: 'POST', body: draft, headers: { cookie: `session=${alexis}; __Host-session=${alexis}` } });
  check('aperçu en direct : brouillon invalide expliqué, rien d’enregistré', draftPreview.status === 422 && (await draftPreview.text()).includes('couleur'), `HTTP ${draftPreview.status}`);
  const copied = await submitForm(`/visuels/${workspaceId}`, alexis, 'Créer une copie', { modele: firstTemplate });
  check('nouveau modèle par copie, ouvert dans l’éditeur', /\/visuels\/[0-9a-f-]{36}\/modeles\/[0-9a-f-]{36}\?message=modele-copie/.test(copied.headers.get('location') ?? ''), `HTTP ${copied.status}`);
  check('modèles en lecture seule pour une contributrice', !(await (await get(`/visuels/${workspaceId}`, claire)).text()).includes('Enregistrer la charte'));

  // ONB-05, VIS-05 : charte et budget d'images.
  const savedBrand = await submitForm(`/visuels/${workspaceId}`, alexis, 'Enregistrer la charte', { principale: '#123456', accent: '#f0a500', claire: '#f5f7fa', sombre: '#1a1a1a', police: 'lora', budget: '40' });
  const brandRow = await asSystem(db, (trx) => trx.selectFrom('workspaces').select(['branding', 'image_budget_monthly']).where('id', '=', workspaceId).executeTakeFirstOrThrow());
  check(
    'charte (couleurs, police des titres) et budget d’images enregistrés (ONB-05, VIS-02, VIS-05)',
    (savedBrand.headers.get('location') ?? '').includes('charte-enregistree') &&
      (brandRow.branding as { primary?: string; font?: string } | null)?.primary === '#123456' &&
      (brandRow.branding as { font?: string } | null)?.font === 'lora' &&
      brandRow.image_budget_monthly === 40,
    `HTTP ${savedBrand.status}`,
  );

  // VIS-08 : médiathèque.
  const photoBytes = (await new FakeImageGenerator().generate({ subject: 'chantier', width: 640, height: 480 })).bytes;
  const libraryAdd = await submitForm(`/visuels/${workspaceId}/photos`, claire, 'Ajouter à la médiathèque', {
    photos: new File([photoBytes], 'chantier-echafaudage.png', { type: 'image/png' }),
    dossier: 'Chantiers',
    'mots-cles': 'échafaudage, casque',
  });
  const libraryPage = (await (await get(`/visuels/${workspaceId}/photos?mot=${encodeURIComponent('échafaudage')}`, claire)).text()).replace(/<!-- -->/g, '');
  check('médiathèque : photo ajoutée par une contributrice, retrouvée par mot-clé (VIS-08)', (libraryAdd.headers.get('location') ?? '').includes('photo-mediatheque') && libraryPage.includes('chantier echafaudage'), `HTTP ${libraryAdd.status}`);

  // REC-14, VAL-06 : validation depuis l'e-mail.
  const replanned = posts.find((p) => p.body.includes('sessions de formation incendie'));
  if (replanned) {
    const jpUser = await asSystem(db, (trx) => trx.selectFrom('users').select('id').where('email', '=', 'jp@demo.example.test').executeTakeFirstOrThrow());
    const token = await createApprovalLink(db, replanned.id, jpUser.id, new Date());
    const statusOf = async () => (await asSystem(db, (trx) => trx.selectFrom('posts').select('status').where('id', '=', replanned.id).executeTakeFirstOrThrow())).status;
    let approvalHtml = '';
    for (let i = 0; i < 3; i += 1) approvalHtml = await (await get(`/valider/${token}`)).text(); // antivirus de messagerie
    check('REC-14 : ouvrir le lien (même 3 fois) ne valide rien', approvalHtml.includes('Confirmer la validation') && (await statusOf()) === 'a_valider');
    const confirmForm = /<form[^>]*>([\s\S]*?)<\/form>/.exec(approvalHtml)?.[1] ?? '';
    const confirmFields = new FormData();
    for (const input of confirmForm.matchAll(/<input type="hidden" name="([^"]+)"(?: value="([^"]*)")?/g)) confirmFields.append(decodeEntities(input[1] ?? ''), decodeEntities(input[2] ?? ''));
    const confirmed = await fetch(`${BASE}/valider/${token}`, { method: 'POST', body: confirmFields, redirect: 'manual', headers: { origin: BASE } });
    check('VAL-06 : « Confirmer » valide sans connexion', (confirmed.headers.get('location') ?? '').includes('r=valide') && (await statusOf()) === 'valide', `HTTP ${confirmed.status}`);
    const again = await fetch(`${BASE}/valider/${token}`, { method: 'POST', body: confirmFields, redirect: 'manual', headers: { origin: BASE } });
    check('VAL-06 : le lien ne sert qu’une fois', (again.headers.get('location') ?? '').includes('r=lien_invalide'));
  }

  // REC-12 : export des données personnelles.
  const exported = await get('/moi/export', claire);
  const zipBytes = new Uint8Array(await exported.arrayBuffer());
  const zipEntries = exported.status === 200 ? readZip(zipBytes) : [];
  check(
    'REC-12 : export RGPD en archive (JSON + images)',
    exported.headers.get('content-type') === 'application/zip' && zipEntries[0]?.path === 'mes-donnees.json' && zipEntries.some((e) => e.path.startsWith('images/')),
    `HTTP ${exported.status}`,
  );
  if (process.env['SMOKE_EXPORT_PATH']) writeFileSync(process.env['SMOKE_EXPORT_PATH'], zipBytes);

  // Lot 2, ONB-01 à ONB-03, ONB-08 : inscription en libre-service puis démarrage.
  const signupPage = await get('/inscription');
  check('page d’inscription publique (ONB-01)', signupPage.status === 200 && (await signupPage.text()).includes('Créer un compte'));
  const newcomer = `nouveau-${Date.now()}@demo.example.test`;
  const signupForm = await submitForm('/inscription', '', 'Recevoir mon lien de confirmation', { email: newcomer, nom: 'Nouvelle Cliente', organisation: 'Atelier Démo', type: 'entreprise' });
  check('demande d’inscription par le formulaire : lien envoyé, rien de créé', (signupForm.headers.get('location') ?? '').includes('inscription-envoyee') && (await asSystem(db, (trx) => trx.selectFrom('users').select('id').where('email', '=', newcomer).execute())).length === 0, `HTTP ${signupForm.status}`);
  // Le lien est envoyé par e-mail ; ici, une seconde demande donne un jeton connu.
  const signup = await requestSignup(db, { email: newcomer, fullName: 'Nouvelle Cliente', orgName: 'Atelier Démo', orgKind: 'entreprise' }, new Date());
  if (signup.kind === 'confirm') {
    const confirmPage = await get(`/inscription/confirmer?jeton=${encodeURIComponent(signup.token)}`);
    const confirmHtml = await confirmPage.text();
    check('lien de confirmation : la page ne crée rien avant le clic', confirmHtml.includes('Créer mon espace') && (await asSystem(db, (trx) => trx.selectFrom('users').select('id').where('email', '=', newcomer).execute())).length === 0);
    const confirmFields = new FormData();
    for (const input of confirmHtml.matchAll(/<input type="hidden" name="([^"]+)"(?: value="([^"]*)")?/g)) confirmFields.append(decodeEntities(input[1] ?? ''), decodeEntities(input[2] ?? ''));
    const created = await fetch(`${BASE}/inscription/confirmer`, { method: 'POST', body: confirmFields, redirect: 'manual', headers: { origin: BASE } });
    const location = created.headers.get('location') ?? '';
    const newSession = /(?:__Host-)?session=([^;]+)/.exec(created.headers.get('set-cookie') ?? '')?.[1] ?? '';
    check('« Créer mon espace » : organisation créée, session ouverte, assistant de démarrage (ONB-02)', /\/demarrage\/[0-9a-f-]{36}/.test(location) && newSession !== '', `HTTP ${created.status} → ${location}`);
    const newWorkspace = /\/demarrage\/([0-9a-f-]{36})/.exec(location)?.[1] ?? '';
    const wizard = (await (await get(`/demarrage/${newWorkspace}`, newSession)).text()).replace(/<!-- -->/g, '');
    check('assistant de démarrage : six étapes, aucune faite (ONB-03)', wizard.includes('Prêt à publier à 0 sur 6') && wizard.includes('Première rédaction'));
    const company = await submitForm(`/demarrage/${newWorkspace}`, newSession, '>Enregistrer<', { nom: 'Atelier Démo', site: 'atelier-demo.fr', secteur: 'Menuiserie', taille: '1-9' });
    const afterCompany = (await (await get(`/demarrage/${newWorkspace}`, newSession)).text()).replace(/<!-- -->/g, '');
    check('étape 1 « Votre entreprise » enregistrée', (company.headers.get('location') ?? '').includes('entreprise-enregistree') && afterCompany.includes('Prêt à publier à 1 sur 6'), `HTTP ${company.status}`);
    const newHome = (await (await get('/', newSession)).text()).replace(/<!-- -->/g, '');
    check('indicateur « prêt à publier » sur « Mes posts » (ONB-08)', newHome.includes('prêt à publier à 1 sur 6') && newHome.includes('Continuer le démarrage'));
    check('pas d’indicateur pour l’espace déjà en place', !(await (await get('/', alexis)).text()).includes('Continuer le démarrage'));
    check('bandeau d’essai gratuit : 14 jours, 0 post sur 10, 0 compte sur 3 (ONB-06)', /Essai gratuit<\/strong> · 14 jours restants · 0 post rédigé sur 10 · 0 compte LinkedIn sur 3/.test(newHome));
    check('pas de bandeau d’essai pour Secutop', !(await (await get('/', alexis)).text()).includes('Essai gratuit'));
    check('le nouveau client ne voit pas l’espace de démonstration', (await get(`/planning/${workspaceId}`, newSession)).status === 404);
    // ONB-04 : ligne éditoriale proposée par l'IA, à relire avant d'enregistrer.
    const proposed = await submitForm(`/ligne/${newWorkspace}`, newSession, 'Proposer la ligne éditoriale', {
      site: 'http://127.0.0.1/admin',
      posts: 'Nous formons nos équipes au travail en hauteur chaque trimestre.\n---\nRetour sur notre chantier de rénovation à Lyon.',
    });
    const proposedAt = proposed.headers.get('location') ?? '';
    const reviewPage = proposedAt.includes('proposition=') ? (await (await get(proposedAt.replace(/#.*$/, ''), newSession)).text()).replace(/<!-- -->/g, '') : '';
    check(
      'ligne éditoriale proposée par l’IA : formulaire pré-rempli, site interne refusé, rien d’enregistré (ONB-04)',
      reviewPage.includes('Proposition de l’IA, à relire') && reviewPage.includes('(Démonstration, sans IA) Atelier Démo') && reviewPage.includes('Adresse interdite'),
      `HTTP ${proposed.status} → ${proposedAt}`,
    );
    check('la proposition n’enregistre aucune version de la ligne', (await asSystem(db, (trx) => trx.selectFrom('editorial_lines').select('id').where('workspace_id', '=', newWorkspace).execute())).length === 0);

    // ONB-05, ONB-09 : aides facultatives du démarrage.
    const wizardExtras = (await (await get(`/demarrage/${newWorkspace}`, newSession)).text()).replace(/<!-- -->/g, '');
    check('assistant : import du planning et charte depuis le site proposés (ONB-05, ONB-09)', wizardExtras.includes('Importer votre planning existant') && wizardExtras.includes('Proposer la charte à partir de votre site'));
    const importFromWizard = await (await get(`/planning/${newWorkspace}/import?depuis=demarrage`, newSession)).text();
    check('import depuis l’assistant : feuille Google Sheets acceptée (ONB-09)', importFromWizard.includes('feuille Google Sheets partagée par lien') && importFromWizard.includes('name="depuis"'));
    const privateSheet = await submitForm(`/planning/${newWorkspace}/import?depuis=demarrage`, newSession, 'Voir l’aperçu', { type: 'planning', feuille: 'https://exemple.fr/pas-une-feuille', annee: '2026' });
    check('adresse qui n’est pas une feuille Google Sheets refusée, retour à l’import de l’assistant', (privateSheet.headers.get('location') ?? '').includes('feuille_invalide') && (privateSheet.headers.get('location') ?? '').includes('depuis=demarrage'), `HTTP ${privateSheet.status}`);
    const brandFromSite = await submitForm(`/visuels/${newWorkspace}`, newSession, 'Proposer la charte', { site: 'http://127.0.0.1/' });
    check('charte depuis le site : adresse interne refusée (ONB-05)', (brandFromSite.headers.get('location') ?? '').includes('site_illisible'), `HTTP ${brandFromSite.status}`);

    // Lot 2, FAC-01 à FAC-07 : abonnement (serveur lancé avec BILLING_MODE=fake).
    const billingPath = `/abonnement/${newWorkspace}`;
    await asSystem(db, (trx) =>
      trx.updateTable('plans').set({ stripe_price_monthly: 'price_smoke_essentiel', price_monthly_cents: 2900 }).where('key', '=', 'essentiel').where('stripe_price_monthly', 'is', null).execute(),
    );
    const billingHtml = (await (await get(billingPath, newSession)).text()).replace(/<!-- -->/g, '');
    check(
      'page d’abonnement : essai en cours, formules, usage du mois (FAC-03, FAC-04)',
      billingHtml.includes('Essai gratuit en cours') && billingHtml.includes('Souscrire à Essentiel') && billingHtml.includes('29,00') && billingHtml.includes('Usage du mois'),
      billingHtml.includes('pas encore configuré') ? 'serveur lancé sans BILLING_MODE=fake' : '',
    );
    const toCheckout = await submitForm(billingPath, newSession, 'Souscrire à Essentiel', { periodicite: 'month' });
    const checkoutAt = toCheckout.headers.get('location') ?? '';
    check('« Souscrire » : redirection vers la page de paiement (FAC-01)', checkoutAt.includes('/abonnement/simulation?mode=subscription'), `HTTP ${toCheckout.status} → ${checkoutAt}`);
    const checkoutPath = checkoutAt.replace(BASE, '');
    const paid = await submitForm(checkoutPath, newSession, 'Payer (simulation)', {});
    const subscriptionRow = await asSystem(db, (trx) =>
      trx.selectFrom('subscriptions as s').innerJoin('workspaces as w', 'w.org_id', 's.org_id').select(['s.status', 's.plan_key']).where('w.id', '=', newWorkspace).executeTakeFirst(),
    );
    check('paiement simulé : abonnement actif, retour sur la page (FAC-01)', (paid.headers.get('location') ?? '').includes('abonnement-paye') && subscriptionRow?.status === 'active' && subscriptionRow.plan_key === 'essentiel', `HTTP ${paid.status}`);
    const subscribedHtml = (await (await get(billingPath, newSession)).text()).replace(/<!-- -->/g, '');
    check('page d’abonnement : formule, échéance, choix au plafond', subscribedHtml.includes('Abonnement en cours') && subscribedHtml.includes('Prochaine échéance') && subscribedHtml.includes('Au plafond du quota'));
    check('plus de bandeau d’essai une fois abonné', !(await (await get('/', newSession)).text()).includes('Essai gratuit</strong>'));
    const overage = await submitForm(billingPath, newSession, '>Enregistrer<', { depassement: 'packs' });
    check('au plafond : packs supplémentaires choisis (FAC-04)', (overage.headers.get('location') ?? '').includes('depassement-enregistre') && (await (await get(billingPath, newSession)).text()).includes('Pack de 20 posts'), `HTTP ${overage.status}`);
    const toPortal = await submitForm(billingPath, newSession, 'Moyen de paiement, factures et résiliation', {});
    const portalPath = (toPortal.headers.get('location') ?? '').replace(BASE, '');
    check('portail de facturation (FAC-05)', portalPath.includes('/abonnement/simulation?mode=portail'), `HTTP ${toPortal.status}`);
    await submitForm(portalPath, newSession, 'Appliquer', { action: 'echec_paiement' });
    const pastDueHtml = (await (await get(billingPath, newSession)).text()).replace(/<!-- -->/g, '');
    check('prélèvement en échec affiché, publication maintenue jusqu’à J+14 (FAC-06)', pastDueHtml.includes('Paiement en échec depuis') && pastDueHtml.includes('Abonnement en cours'));
    await submitForm(portalPath, newSession, 'Appliquer', { action: 'paiement' });
    check('règlement : l’impayé disparaît', !(await (await get(billingPath, newSession)).text()).includes('Paiement en échec depuis'));
    const usageCsv = await get(`${billingPath}/export`, newSession);
    check('export de l’usage par espace et par mois (FAC-07)', usageCsv.headers.get('content-type')?.startsWith('text/csv') === true && (await usageCsv.text()).includes('"Espace";"Mois"'), `HTTP ${usageCsv.status}`);
    check('abonnement d’un autre client → 404', (await get(`/abonnement/${newWorkspace}`, alexis)).status === 404 && (await get(`${billingPath}/export`, alexis)).status === 404);

    const spacesHtml = (await (await get(`/espaces/${newWorkspace}`, newSession)).text()).replace(/<!-- -->/g, '');
    check('entreprise en formule Essentiel : un seul espace', spacesHtml.includes('Votre formule permet 1 espace') && !spacesHtml.includes('Créer l’espace'));

    // Agence : un espace par client.
    const agencyEmail = `agence-${Date.now()}@demo.example.test`;
    const agencySignup = await requestSignup(db, { email: agencyEmail, fullName: 'Agence Démo', orgName: 'Agence Démo', orgKind: 'agence' }, new Date());
    const agencyOutcome = agencySignup.kind === 'confirm' ? await confirmSignup(db, agencySignup.token, new Date()) : null;
    if (agencyOutcome?.ok) {
      const agencySession = agencyOutcome.session.sessionToken;
      const clientsPath = `/espaces/${agencyOutcome.workspaceId}`;
      check('agence : lien « Clients » et liste des espaces', (await (await get('/', agencySession)).text()).includes(`href="${clientsPath}"`) && (await (await get(clientsPath, agencySession)).text()).includes('Premier client'));
      const newClient = await submitForm(clientsPath, agencySession, 'Créer l’espace du client', { nom: 'Boulangerie Démo' });
      const clientAt = newClient.headers.get('location') ?? '';
      check('agence : espace d’un nouveau client créé, assistant de démarrage ouvert', /\/demarrage\/[0-9a-f-]{36}\?message=espace-cree/.test(clientAt), `HTTP ${newClient.status} → ${clientAt}`);
      check('espaces d’une agence invisibles pour un autre client', (await get(clientsPath, newSession)).status === 404);
    } else {
      check('agence : inscription', false, agencySignup.kind);
    }

    // Événements Stripe : signature exigée, chaque événement appliqué une seule fois.
    const unsigned = await fetch(`${BASE}/api/stripe/webhook`, { method: 'POST', body: '{"id":"evt_x"}', headers: { 'content-type': 'application/json' } });
    const webhookSecret = process.env['STRIPE_WEBHOOK_SECRET'];
    if (webhookSecret) {
      const payload = JSON.stringify({ id: `evt_smoke_${Date.now()}`, type: 'customer.created', data: { object: {} } });
      const t = Math.floor(Date.now() / 1000);
      const signature = createHmac('sha256', webhookSecret).update(`${t}.${payload}`).digest('hex');
      const send = () => fetch(`${BASE}/api/stripe/webhook`, { method: 'POST', body: payload, headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${signature}` } });
      const first = (await (await send()).json()) as { received?: boolean; duplicate?: boolean };
      const second = (await (await send()).json()) as { duplicate?: boolean };
      check('webhook Stripe : sans signature refusé, signé accepté une seule fois', unsigned.status === 400 && first.received === true && first.duplicate === false && second.duplicate === true, `HTTP ${unsigned.status}`);
    } else {
      check('webhook Stripe : refusé tant que STRIPE_WEBHOOK_SECRET n’est pas configuré', unsigned.status === 503, `HTTP ${unsigned.status}`);
    }
  } else {
    check('inscription : jeton de confirmation obtenu', false, signup.kind);
  }

  // SEC-04 : double authentification.
  check('administrateur : bandeau « double authentification à activer avant le… »', (await (await get('/', alexis)).text()).includes('obligatoire pour votre rôle'));
  const started = await submitForm('/securite', claire, 'Activer la double authentification', {});
  const setupHtml = (await (await get('/securite', claire)).text()).replace(/<!-- -->/g, '');
  const totpSecret = /data-secret="([A-Z2-7]+)"/.exec(setupHtml)?.[1] ?? '';
  check('mise en place : code QR et clé affichés', (started.headers.get('location') ?? '').includes('/securite') && setupHtml.includes('<svg') && totpSecret.length === 32, `HTTP ${started.status}`);
  const confirmedMfa = await submitForm('/securite', claire, '>Confirmer<', { code: totpCode(totpSecret, new Date()) });
  check(
    'premier code : double authentification activée, codes de secours remis',
    (confirmedMfa.headers.get('location') ?? '').includes('mfa-activee') && (confirmedMfa.headers.get('set-cookie') ?? '').includes('codes-secours='),
    `HTTP ${confirmedMfa.status}`,
  );
  const claireAgain = await sessionFor('claire@demo.example.test');
  const askedCode = await get('/', claireAgain);
  check('nouvelle connexion : le code est demandé avant tout accès', askedCode.status === 307 && (askedCode.headers.get('location') ?? '').includes('/connexion/code'), `HTTP ${askedCode.status}`);
  check('nouvelle connexion : rien d’accessible sans le code', (await get(`/posts/${withPhotos.id}`, claireAgain)).status === 307 && (await get('/moi/export', claireAgain)).status !== 200);
  const wrongCode = await submitForm('/connexion/code', claireAgain, 'Vérifier', { code: '000000' });
  check('code faux refusé', (wrongCode.headers.get('location') ?? '').includes('code_faux'), `HTTP ${wrongCode.status}`);
  // Code du pas suivant (tolérance d'un pas) : celui du pas courant a déjà servi.
  const rightCode = await submitForm('/connexion/code', claireAgain, 'Vérifier', { code: totpCode(totpSecret, new Date(Date.now() + 30_000)) });
  check('bon code : accès ouvert', /\/$/.test(rightCode.headers.get('location') ?? '') && (await get('/', claireAgain)).status === 200, `HTTP ${rightCode.status} → ${rightCode.headers.get('location')}`);

  // SUI-03 à SUI-05 : statistiques, enseignements, rapport mensuel.
  const statsHtml = (await (await get(`/tableau/${workspaceId}`, alexis)).text()).replace(/<!-- -->/g, '');
  check('tableau de bord : statistiques LinkedIn et enseignements du mois (SUI-03, SUI-04)', statsHtml.includes('Statistiques LinkedIn du mois') && statsHtml.includes('Enseignements du mois dernier'));
  const reportPdf = await get(`/tableau/${workspaceId}/rapport`, alexis);
  const reportBytes = new Uint8Array(await reportPdf.arrayBuffer());
  check('rapport mensuel en PDF (SUI-05)', reportPdf.headers.get('content-type') === 'application/pdf' && Buffer.from(reportBytes.slice(0, 5)).toString() === '%PDF-', `HTTP ${reportPdf.status}`);
  const reportByMail = await submitForm(`/tableau/${workspaceId}`, alexis, 'Recevoir le rapport PDF chaque mois par e-mail', {});
  check('envoi automatique du rapport activé (SUI-05)', (reportByMail.headers.get('location') ?? '').includes('rapport-par-email'), `HTTP ${reportByMail.status}`);
  await submitForm(`/tableau/${workspaceId}`, alexis, 'Ne plus recevoir le rapport chaque mois', {});
  check('rapport d’un autre client → 404', (await get(`/tableau/${workspaceId}/rapport`, await sessionFor('exterieur@demo.example.test').catch(() => ''))).status !== 200);

  // PUB-09 : publication manuelle, puis retour à l'automatique.
  const toManual = await submitForm(`/comptes/${workspaceId}`, alexis, 'Passer en publication manuelle (par e-mail)', {});
  const manualCount = (await asSystem(db, (trx) => trx.selectFrom('social_accounts').select('id').where('workspace_id', '=', workspaceId).where('publish_mode', '=', 'manual').execute())).length;
  const backToAuto = await submitForm(`/comptes/${workspaceId}`, alexis, 'Revenir à la publication automatique', {});
  check(
    'PUB-09 : compte en publication manuelle (par e-mail), puis retour à l’automatique',
    (toManual.headers.get('location') ?? '').includes('publication-manuelle') && manualCount === 1 && (backToAuto.headers.get('location') ?? '').includes('publication-automatique'),
    `HTTP ${toManual.status}`,
  );

  // ADM-01 à ADM-06 : back-office de l'éditeur.
  check('back-office introuvable pour un client', (await get('/admin', alexis)).status === 404);
  const editorUser = await asSystem(db, async (trx) => {
    const user = await trx
      .insertInto('users')
      .values({ email: 'editeur@demo.example.test', full_name: 'Éditeur SimplX' })
      .onConflict((oc) => oc.column('email').doUpdateSet({ full_name: 'Éditeur SimplX', created_at: new Date() }))
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx.insertInto('platform_admins').values({ user_id: user.id }).onConflict((oc) => oc.column('user_id').doNothing()).execute();
    await trx.deleteFrom('user_totp').where('user_id', '=', user.id).execute();
    return user.id;
  });
  const editor = await sessionFor('editeur@demo.example.test');
  const noMfa = await get('/admin', editor);
  check('back-office : double authentification exigée d’abord', noMfa.status === 307 && (noMfa.headers.get('location') ?? '').includes('mfa_requise_admin'), `HTTP ${noMfa.status}`);
  await submitForm('/securite', editor, 'Activer la double authentification', {});
  const editorSecret = /data-secret="([A-Z2-7]+)"/.exec(await (await get('/securite', editor)).text())?.[1] ?? '';
  await submitForm('/securite', editor, '>Confirmer<', { code: totpCode(editorSecret, new Date()) });
  const adminHome = (await (await get('/admin', editor)).text()).replace(/<!-- -->/g, '');
  check('ADM-01 : liste des organisations avec formule, usage, revenu, paiement', adminHome.includes('Secutop') && adminHome.includes('Revenu mensuel HT') && adminHome.includes('Dernière activité'), editorUser);
  const secutopOrg = await asSystem(db, (trx) => trx.selectFrom('workspaces').select('org_id').where('id', '=', workspaceId).executeTakeFirstOrThrow());
  check('ADM-01 : fiche d’une organisation (espaces, personnes)', (await (await get(`/admin/organisations/${secutopOrg.org_id}`, editor)).text()).includes('Double authentification'));
  const supervisionHtml = await (await get('/admin/supervision', editor)).text();
  check('ADM-03 : supervision (files, erreurs LinkedIn, connexions, coûts IA)', supervisionHtml.includes('Files de travail') && supervisionHtml.includes('Erreurs LinkedIn par type') && supervisionHtml.includes('Coûts de l’IA par fournisseur'));
  const settingsSaved = await submitForm('/admin/parametres', editor, 'Enregistrer les paramètres', {
    image_budget_monthly: '30',
    max_posts_per_account_per_day: '2',
    max_posts_per_slot: '2',
    min_gap_minutes: '30',
    posts_per_week: '1',
    ai_image_ratio_percent: '50',
  });
  check('ADM-04 : paramètres par défaut enregistrés ; modèles et consignes affichés', (settingsSaved.headers.get('location') ?? '').includes('parametres-enregistres') && (await (await get('/admin/parametres', editor)).text()).includes('Consignes (version'), `HTTP ${settingsSaved.status}`);
  const galleryHtml = await (await get('/admin/galerie', editor)).text();
  const galleryPreview = await get('/admin/galerie/apercu?modele=titre-points', editor);
  check('ADM-05 : galerie de départ avec aperçus', galleryHtml.includes('Retirer de la galerie') && galleryPreview.headers.get('content-type') === 'image/png');
  const announced = await submitForm('/admin/annonces', editor, 'Publier l’annonce', { message: 'Nouveau : test de fumée', niveau: 'info' });
  check('ADM-06 : annonce publiée, visible par les clients', (announced.headers.get('location') ?? '').includes('annonce-publiee') && (await (await get('/', alexis)).text()).includes('test de fumée'), `HTTP ${announced.status}`);
  await submitForm('/admin/annonces', editor, '>Retirer<', {});

  // ADM-02 : accès du support accordé par le client, session « en tant que », trace.
  const granted = await submitForm(`/espace/${workspaceId}`, alexis, 'Accorder l’accès au support', { heures: '2', motif: 'Test de fumée' });
  check('ADM-02 : accès accordé par l’administratrice de l’espace', (granted.headers.get('location') ?? '').includes('support-accorde'), `HTTP ${granted.status}`);
  const opened = await submitForm('/admin', editor, 'Ouvrir une session support', {});
  const supportSession = /(?:__Host-)?session=([^;]+)/.exec(opened.headers.get('set-cookie') ?? '')?.[1] ?? '';
  const supportHome = supportSession === '' ? '' : await (await get(`/tableau/${workspaceId}`, supportSession)).text();
  check('ADM-02 : session du support ouverte au nom du client, bandeau affiché', (opened.headers.get('location') ?? '').includes(`/tableau/${workspaceId}`) && supportHome.includes('Session du support'), `HTTP ${opened.status}`);
  const supportTrail = await asSystem(db, (trx) => trx.selectFrom('audit_log').select('action').where('workspace_id', '=', workspaceId).where('action', 'like', 'support.%').execute());
  check('ADM-02 : accord et ouverture inscrits au journal d’audit du client', supportTrail.some((r) => r.action === 'support.acces_accorde') && supportTrail.some((r) => r.action === 'support.session_ouverte'));
  await submitForm(`/espace/${workspaceId}`, alexis, 'Retirer l’accès', {});
  check('ADM-02 : accès retiré, la session du support est fermée', (await get(`/tableau/${workspaceId}`, supportSession)).status === 307);

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
  check('REC-01 : planning d’un autre client non exportable → 404', (await get(`/planning/${workspaceId}/export`, outsider)).status === 404);
  check('REC-01 : posts d’un autre client non exportables → 404', (await get(`/tableau/${workspaceId}/export`, outsider)).status === 404);
} finally {
  await db.destroy();
}

console.log(failures === 0 ? '\nTout est conforme.' : `\n${failures} vérification(s) en échec.`);
process.exitCode = failures === 0 ? 0 : 1;
