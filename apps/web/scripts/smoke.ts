/**
 * Test de fumée de l'application lancée (npm run start), sur les données de démonstration
 * (npm run seed) : npm run smoke -w @posts-auto/web
 *
 * Ouvre une vraie session par le parcours de connexion (services), puis vérifie chaque page
 * comme le ferait un navigateur, y compris l'isolation entre clients et les images.
 */
import { FakeModel } from '@posts-auto/ai';
import { DEFAULT_DATABASE_URL, asSystem, createDatabase } from '@posts-auto/db';
import { runGenerationTick } from '@posts-auto/worker';
import { writeFileSync } from 'node:fs';
import { consumeLoginLink, createApiKey, createApprovalLink, readZip, requestLoginLink } from '@posts-auto/services';

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
  // La tâche de fond, exécutée ici comme le ferait le processus des tâches.
  const tick = await runGenerationTick({ db, model: new FakeModel() });
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
  const howItWorks = await get('/comment-fonctionne-la-redaction');
  check('page « Comment fonctionne la rédaction » publique (GEN-12)', howItWorks.status === 200 && (await howItWorks.text()).includes('L’IA peut se tromper'));

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
