'use server';

import {
  RefusedError,
  createAnnouncement,
  endAnnouncement,
  extendTrial,
  openSupportSession,
  reactivateOrganization,
  relaunchGeneration,
  retryDemoForward,
  retryPublicationAsSupport,
  saveGalleryEntry,
  saveSiteTestimonial,
  setGalleryEntryActive,
  suspendOrganization,
  updateDemoRequest,
  updatePlatformSettings,
} from '@posts-auto/services';
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { requireAdmin } from '../../../server/admin.ts';
import { database } from '../../../server/context.ts';
import { demoNotifier } from '../../../server/demo.ts';
import { setSessionCookie } from '../../../server/session.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function run(back: string, action: (adminId: string, now: Date) => Promise<string>): Promise<never> {
  const adminId = await requireAdmin();
  let message: string;
  try {
    message = await action(adminId, new Date());
  } catch (error) {
    if (error instanceof RefusedError) message = error.code;
    else throw error;
  }
  revalidatePath(back.split('?')[0] as string);
  redirect(`${back}${back.includes('?') ? '&' : '?'}message=${encodeURIComponent(message)}`);
}

/** ADM-04 */
export async function saveSettingsAction(form: FormData): Promise<void> {
  await run('/admin/parametres', async (adminId, now) => {
    const input = Object.fromEntries([...form.entries()].filter(([k]) => !k.startsWith('$')).map(([k, v]) => [k, String(v)]));
    await updatePlatformSettings(database(), adminId, input, now);
    return 'parametres-enregistres';
  });
}

/** ADM-05 */
export async function toggleGalleryAction(key: string, active: boolean): Promise<void> {
  await run('/admin/galerie', async (adminId, now) => {
    await setGalleryEntryActive(database(), adminId, key, active, now);
    return active ? 'modele-propose' : 'modele-retire';
  });
}

export async function saveGalleryAction(form: FormData): Promise<void> {
  const text = (name: string) => String(form.get(name) ?? '');
  await run('/admin/galerie', async (adminId, now) => {
    await saveGalleryEntry(database(), adminId, { key: text('cle'), name: text('nom'), definitionJson: text('definition'), withPhoto: form.get('photo') === 'on' }, now);
    return 'modele-galerie-enregistre';
  });
}

/** ADM-06 */
export async function createAnnouncementAction(form: FormData): Promise<void> {
  const date = (name: string) => {
    const value = String(form.get(name) ?? '').trim();
    // Saisie en heure de Paris (datetime-local, sans fuseau).
    return value === '' ? null : new Date(`${value}:00${parisOffset(new Date(`${value}:00Z`))}`);
  };
  await run('/admin/annonces', async (adminId, now) => {
    await createAnnouncement(database(), adminId, { message: String(form.get('message') ?? ''), level: String(form.get('niveau') ?? 'info'), startsAt: date('debut'), endsAt: date('fin') }, now);
    return 'annonce-publiee';
  });
}

function parisOffset(at: Date): string {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Paris', timeZoneName: 'longOffset' }).formatToParts(at).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+01:00';
  const offset = name.replace('GMT', '');
  return offset === '' ? 'Z' : offset;
}

export async function endAnnouncementAction(id: string): Promise<void> {
  await run('/admin/annonces', async (adminId, now) => {
    if (!UUID.test(id)) throw new RefusedError('annonce_invalide', 'Annonce inconnue.');
    await endAnnouncement(database(), adminId, id, now);
    return 'annonce-retiree';
  });
}

/** ADM-02 : ouvre une session au nom du client qui a donné son accord. */
export async function openSupportSessionAction(grantId: string): Promise<void> {
  const adminId = await requireAdmin();
  if (!UUID.test(grantId)) redirect('/admin?message=acces_support_expire');
  const h = await headers();
  let target: string;
  try {
    const session = await openSupportSession(database(), adminId, grantId, new Date(), { userAgent: h.get('user-agent') ?? 'support' });
    await setSessionCookie(session.sessionToken, session.expiresAt);
    target = `/tableau/${session.workspaceId}`;
  } catch (error) {
    if (error instanceof RefusedError) target = `/admin?message=${encodeURIComponent(error.code)}`;
    else throw error;
  }
  redirect(target);
}

/** Adresse de la fiche d'une organisation ; identifiant vérifié avant de s'en servir. */
function organizationPage(orgId: string): string {
  if (!UUID.test(orgId)) redirect('/admin');
  return `/admin/organisations/${orgId}`;
}

export async function extendTrialAction(orgId: string, form: FormData): Promise<void> {
  await run(organizationPage(orgId), async (adminId, now) => {
    await extendTrial(database(), adminId, orgId, Number(form.get('jours')), now);
    return 'essai-prolonge';
  });
}

export async function suspendOrganizationAction(orgId: string, form: FormData): Promise<void> {
  await run(organizationPage(orgId), async (adminId, now) => {
    await suspendOrganization(database(), adminId, orgId, String(form.get('motif') ?? ''), now);
    return 'organisation-suspendue';
  });
}

export async function reactivateOrganizationAction(orgId: string): Promise<void> {
  await run(organizationPage(orgId), async (adminId, now) => {
    await reactivateOrganization(database(), adminId, orgId, now);
    return 'organisation-reactivee';
  });
}

export async function retryPublicationAction(postId: string): Promise<void> {
  await run('/admin/supervision', async (adminId, now) => {
    if (!UUID.test(postId)) throw new RefusedError('publication_plus_en_erreur', 'Post inconnu.');
    await retryPublicationAsSupport(database(), adminId, postId, now);
    return 'publication-relancee';
  });
}

export async function relaunchGenerationAction(workspaceId: string): Promise<void> {
  await run('/admin/supervision', async (adminId, now) => {
    if (!UUID.test(workspaceId)) throw new RefusedError('rien_a_relancer', 'Espace inconnu.');
    await relaunchGeneration(database(), adminId, workspaceId, now);
    return 'redaction-relancee';
  });
}

/** SIT-02 : suivi des demandes de démonstration. */
export async function updateDemoAction(id: string, form: FormData): Promise<void> {
  await run('/admin/site', async (adminId, now) => {
    if (!UUID.test(id)) throw new RefusedError('demande_demo_inconnue', 'Demande introuvable.');
    await updateDemoRequest(database(), adminId, id, { status: String(form.get('statut') ?? ''), note: String(form.get('note') ?? '') }, now);
    return 'demo-suivie';
  });
}

export async function retryDemoForwardAction(id: string): Promise<void> {
  await run('/admin/site', async (adminId) => {
    if (!UUID.test(id)) throw new RefusedError('demande_demo_inconnue', 'Demande introuvable.');
    await retryDemoForward(database(), adminId, demoNotifier(), id);
    return 'demo-transmise';
  });
}

/** SIT-08 : témoignage client du site vitrine. */
export async function saveTestimonialAction(form: FormData): Promise<void> {
  const text = (name: string) => String(form.get(name) ?? '');
  await run('/admin/site', async (adminId, now) => {
    await saveSiteTestimonial(database(), adminId, { quote: text('citation'), author: text('auteur'), role: text('fonction'), company: text('entreprise'), consentOn: text('accord') }, now);
    return 'temoignage-enregistre';
  });
}
