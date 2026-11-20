import type { Metadata } from 'next';
import { LegalPage, Todo } from '../legal.tsx';

export const metadata: Metadata = { title: 'Mentions légales', robots: { index: true, follow: true } };

/** SIT-04 : mentions légales (LCEN, article 6). */
export default function LegalNoticePage() {
  return (
    <LegalPage title="Mentions légales" updated="20 novembre 2026">
      <h2>Éditeur</h2>
      <p>
        Le service Posts LinkedIn est édité par SimplX, <Todo>forme juridique, capital social</Todo>, immatriculée au RCS de <Todo>ville</Todo> sous le numéro <Todo>SIREN</Todo>, dont
        le siège est situé <Todo>adresse</Todo>. Numéro de TVA intracommunautaire : <Todo>numéro</Todo>.
      </p>
      <p>
        Directeur de la publication : <Todo>nom</Todo>. Contact : <Todo>adresse e-mail de contact</Todo>.
      </p>
      <h2>Hébergement</h2>
      <p>
        Le service est hébergé dans l’Union européenne par <Todo>nom, adresse et téléphone de l’hébergeur</Todo>.
      </p>
      <h2>Propriété intellectuelle</h2>
      <p>
        Les textes, visuels et logiciels du site et du service sont la propriété de SimplX ou de ses concédants. Les contenus créés par les clients dans le service leur appartiennent
        (voir les conditions d’utilisation).
      </p>
    </LegalPage>
  );
}
