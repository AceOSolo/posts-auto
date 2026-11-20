'use server';

import {
  changeMemberRole,
  ForbiddenError,
  grantSupportAccess,
  invitationMail,
  inviteMember,
  MEMBER_ROLES,
  type MemberRole,
  NotFoundError,
  RefusedError,
  removeMember,
  requestLoginLink,
  revokeSupportAccess,
  setAccountPaused,
  setDelegates,
} from '@posts-auto/services';
import { asUser } from '@posts-auto/db';
import { revalidatePath } from 'next/cache';
import { notFound, redirect } from 'next/navigation';
import { appUrl, database, mailer } from '../../../server/context.ts';
import { requireUserId } from '../../../server/session.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function run(workspaceId: string, action: (userId: string, now: Date) => Promise<string>): Promise<never> {
  if (!UUID.test(workspaceId)) notFound();
  const userId = await requireUserId();
  let message: string;
  try {
    message = await action(userId, new Date());
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    if (error instanceof ForbiddenError) message = 'interdit';
    else if (error instanceof RefusedError) message = error.code;
    else throw error;
  }
  revalidatePath(`/espace/${workspaceId}`);
  redirect(`/espace/${workspaceId}?message=${encodeURIComponent(message)}`);
}

function role(value: FormDataEntryValue | null): MemberRole {
  return MEMBER_ROLES.includes(value as MemberRole) ? (value as MemberRole) : 'contributor';
}

/** ONB-07 : invitation, puis envoi d'un lien de connexion à la personne invitée. */
export async function inviteAction(workspaceId: string, formData: FormData): Promise<void> {
  await run(workspaceId, async (userId, now) => {
    const invited = await inviteMember(
      database(),
      userId,
      workspaceId,
      { email: String(formData.get('email') ?? ''), fullName: String(formData.get('nom') ?? ''), role: role(formData.get('role')) },
      now,
    );
    const context = await asUser(database(), userId, async (trx) => ({
      workspace: await trx.selectFrom('workspaces').select('name').where('id', '=', workspaceId).executeTakeFirstOrThrow(),
      inviter: await trx.selectFrom('users').select('full_name').where('id', '=', userId).executeTakeFirst(),
    }));
    const link = await requestLoginLink(database(), invited.email, now);
    if (link.kind === 'send') {
      const url = `${appUrl()}/connexion/lien?jeton=${encodeURIComponent(link.token)}`;
      await mailer().send({
        to: { email: invited.email },
        ...invitationMail({ appUrl: appUrl(), recipientName: null }, url, context.workspace.name, context.inviter?.full_name ?? null),
        tag: 'invitation',
      });
    }
    return invited.alreadyMember ? 'deja-membre' : 'invite';
  });
}

export async function changeRoleAction(workspaceId: string, memberId: string, formData: FormData): Promise<void> {
  await run(workspaceId, async (userId, now) => {
    if (!UUID.test(memberId)) throw new NotFoundError('Membre');
    await changeMemberRole(database(), userId, workspaceId, memberId, role(formData.get('role')), now);
    return 'role-change';
  });
}

export async function removeMemberAction(workspaceId: string, memberId: string): Promise<void> {
  await run(workspaceId, async (userId, now) => {
    if (!UUID.test(memberId)) throw new NotFoundError('Membre');
    await removeMember(database(), userId, workspaceId, memberId, now);
    return 'membre-retire';
  });
}

/** ROL-01 : cases cochées = validateurs délégués du compte. */
export async function delegatesAction(workspaceId: string, accountId: string, formData: FormData): Promise<void> {
  await run(workspaceId, async (userId, now) => {
    if (!UUID.test(accountId)) throw new NotFoundError('Compte');
    const ids = formData.getAll('delegue').map(String).filter((id) => UUID.test(id));
    await setDelegates(database(), userId, accountId, ids, now);
    return 'delegues-enregistres';
  });
}

export async function pauseAction(workspaceId: string, accountId: string, formData: FormData): Promise<void> {
  await run(workspaceId, async (userId, now) => {
    if (!UUID.test(accountId)) throw new NotFoundError('Compte');
    const status = await setAccountPaused(database(), userId, accountId, formData.get('pause') === 'oui', now);
    return status === 'paused' ? 'compte-en-pause' : status === 'connected' ? 'compte-repris' : 'compte-repris-expire';
  });
}

/** ADM-02 : accord pour une intervention du support, limité dans le temps. */
export async function grantSupportAction(workspaceId: string, formData: FormData): Promise<void> {
  await run(workspaceId, async (userId, now) => {
    await grantSupportAccess(database(), userId, workspaceId, { hours: Number.parseInt(String(formData.get('heures') ?? ''), 10), reason: String(formData.get('motif') ?? '') }, now);
    return 'support-accorde';
  });
}

export async function revokeSupportAction(workspaceId: string, grantId: string): Promise<void> {
  await run(workspaceId, async (userId, now) => {
    if (!UUID.test(grantId)) throw new NotFoundError('Accès');
    await revokeSupportAccess(database(), userId, workspaceId, grantId, now);
    return 'support-retire';
  });
}
