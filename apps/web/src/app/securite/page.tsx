import { MFA_GRACE_DAYS, mfaStatus, pendingTotpSetup, remainingRecoveryCodes } from '@posts-auto/services';
import type { Metadata } from 'next';
import Link from 'next/link';
import QRCode from 'qrcode';
import { Flash } from '../../components/flash.tsx';
import { database, tokenCipher } from '../../server/context.ts';
import { readRecoveryCodes } from '../../server/mfa.ts';
import { requireUserId } from '../../server/session.ts';
import { confirmSetupAction, disableAction, hideRecoveryCodesAction, startSetupAction } from './actions.ts';

export const metadata: Metadata = { title: 'Double authentification' };
export const dynamic = 'force-dynamic';

const day = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', day: 'numeric', month: 'long', year: 'numeric' });
const grouped = (secret: string) => secret.replace(/(.{4})/g, '$1 ').trim();

/** SEC-04 : mise en place et gestion de la double authentification. Accessible même quand elle est exigée. */
export default async function SecurityPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const userId = await requireUserId({ allowMfaSetup: true });
  const { message } = await searchParams;
  const now = new Date();
  const status = await mfaStatus(database(), userId, now);
  const cipher = tokenCipher();
  const pending = !status.enabled && cipher !== null ? await pendingTotpSetup(database(), cipher, userId) : null;
  const qr = pending === null ? null : await QRCode.toString(pending.uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  const recovery = status.enabled ? await readRecoveryCodes(userId) : null;
  const left = status.enabled ? await remainingRecoveryCodes(database(), userId) : 0;

  return (
    <main className="narrow">
      <p>
        <Link href="/">← Retour</Link>
      </p>
      <h1>Double authentification</h1>
      <Flash code={message} />
      <p>
        À chaque connexion, après le lien reçu par e-mail, un code à 6 chiffres affiché par une application d’authentification sur votre téléphone (Google Authenticator, Microsoft
        Authenticator, 1Password…) vous est demandé. Quelqu’un qui accède à votre messagerie ne peut donc pas entrer dans votre compte.
      </p>
      {status.required && !status.enabled && status.deadline !== null && (
        <p className={status.overdue ? 'flash error' : 'notice'} role="status">
          Obligatoire pour les propriétaires et les administrateurs
          {status.overdue ? ' : activez-la pour continuer.' : `, à activer avant le ${day.format(status.deadline)} (${MFA_GRACE_DAYS} jours pour la mettre en place).`}
        </p>
      )}

      {recovery !== null && (
        <section aria-labelledby="secours" className="card">
          <h2 id="secours">Vos codes de secours</h2>
          <p>Notez-les ou imprimez-les et rangez-les en lieu sûr : chacun permet une connexion si vous n’avez plus votre téléphone. Ils ne seront plus affichés.</p>
          <ul className="pre">
            {recovery.map((code) => (
              <li key={code}>
                <code>{code}</code>
              </li>
            ))}
          </ul>
          <form action={hideRecoveryCodesAction}>
            <button type="submit">J’ai noté mes codes</button>
          </form>
        </section>
      )}

      {status.enabled ? (
        <section aria-labelledby="active">
          <h2 id="active">Activée</h2>
          <p>
            {left} code{left > 1 ? 's' : ''} de secours restant{left > 1 ? 's' : ''}.
          </p>
          {!status.required && (
            <form action={disableAction} className="stack">
              <label htmlFor="code-desactivation">Pour la désactiver, saisissez un code de l’application</label>
              <input id="code-desactivation" name="code" inputMode="numeric" autoComplete="one-time-code" required />
              <button type="submit">Désactiver</button>
            </form>
          )}
        </section>
      ) : cipher === null ? (
        <p className="muted">La double authentification n’est pas disponible : le chiffrement n’est pas configuré sur ce serveur.</p>
      ) : pending === null ? (
        <form action={startSetupAction}>
          <button type="submit" className="primary">
            Activer la double authentification
          </button>
        </form>
      ) : (
        <section aria-labelledby="mise-en-place" id="mise-en-place">
          <h2>Mise en place</h2>
          <ol>
            <li>Ouvrez votre application d’authentification et ajoutez un compte.</li>
            <li>
              Scannez ce code :
              {/* SVG produit sur le serveur par la bibliothèque qrcode, à partir du seul lien otpauth. */}
              <div className="qr" role="img" aria-label="Code QR à scanner" dangerouslySetInnerHTML={{ __html: qr ?? '' }} />
              ou saisissez la clé : <code data-secret={pending.secret}>{grouped(pending.secret)}</code>
            </li>
            <li>Saisissez le code à 6 chiffres affiché :</li>
          </ol>
          <form action={confirmSetupAction} className="stack">
            <label htmlFor="code">Code</label>
            <input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" required />
            <button type="submit" className="primary">
              Confirmer
            </button>
          </form>
        </section>
      )}
    </main>
  );
}
