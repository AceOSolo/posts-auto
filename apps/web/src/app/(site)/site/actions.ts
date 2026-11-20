'use server';

import { RefusedError, createDemoRequest } from '@posts-auto/services';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { database } from '../../../server/context.ts';
import { demoNotifier } from '../../../server/demo.ts';

/** SIT-02 : demande de démonstration, transmise à l'éditeur. */
export async function requestDemoAction(form: FormData): Promise<void> {
  const text = (name: string) => String(form.get(name) ?? '');
  const forwarded = (await headers()).get('x-forwarded-for')?.split(',')[0]?.trim();
  const ip = forwarded && /^[\d.:a-f]+$/i.test(forwarded) ? forwarded : undefined;
  let message = 'demo-envoyee';
  try {
    await createDemoRequest(
      database(),
      demoNotifier(),
      { fullName: text('nom'), company: text('entreprise'), email: text('email'), phone: text('telephone'), accounts: text('comptes'), message: text('message'), website: text('site') },
      new Date(),
      ip,
    );
  } catch (error) {
    if (error instanceof RefusedError) message = error.code;
    else throw error;
  }
  redirect(`/?message=${encodeURIComponent(message)}#demo`);
}
