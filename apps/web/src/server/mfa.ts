/** SEC-04 : codes de secours montrés une seule fois, dans un cookie chiffré de 10 minutes limité à /securite. */
import { cookies } from 'next/headers';
import { tokenCipher } from './context.ts';

export const RECOVERY_COOKIE = 'codes-secours';

export async function readRecoveryCodes(userId: string): Promise<string[] | null> {
  const value = (await cookies()).get(RECOVERY_COOKIE)?.value;
  const cipher = tokenCipher();
  if (value === undefined || cipher === null) return null;
  try {
    return cipher.decrypt(Buffer.from(value, 'base64url'), `recovery:${userId}`).split(' ');
  } catch {
    return null;
  }
}
