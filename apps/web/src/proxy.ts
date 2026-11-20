/**
 * SIT-01 : à la racine, le site vitrine pour les visiteurs, « Mes posts » pour les personnes
 * connectées. Sans cookie de session, « / » affiche /site (même adresse, pour le
 * référencement) ; avec un cookie, l'application vérifie la session comme d'habitude.
 */
import { type NextRequest, NextResponse } from 'next/server';

export function proxy(request: NextRequest) {
  const hasSession = Boolean(request.cookies.get('session')?.value || request.cookies.get('__Host-session')?.value);
  if (!hasSession) {
    // L'adresse de la page (paramètres du simulateur, message du formulaire) est conservée.
    const target = request.nextUrl.clone();
    target.pathname = '/site';
    return NextResponse.rewrite(target);
  }
  return NextResponse.next();
}

export const config = { matcher: '/' };
