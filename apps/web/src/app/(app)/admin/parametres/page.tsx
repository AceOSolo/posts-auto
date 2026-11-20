import { EDITORIAL_PROPOSAL_SYSTEM, INSPECTOR_SYSTEM, INTERPRETER_SYSTEM, PROMPT_VERSION, VERIFIER_SYSTEM, VISUAL_SYSTEM, WRITER_SYSTEM } from '@posts-auto/ai';
import { PLATFORM_SETTINGS, PLATFORM_SETTING_KEYS, aiModelsInUse, loadPlatformSettings } from '@posts-auto/services';
import { asSystem } from '@posts-auto/db';
import type { Metadata } from 'next';
import { Flash } from '../../../../components/flash.tsx';
import { requireAdmin } from '../../../../server/admin.ts';
import { database, model } from '../../../../server/context.ts';
import { saveSettingsAction } from '../actions.ts';

export const metadata: Metadata = { title: 'Paramètres et IA' };
export const dynamic = 'force-dynamic';

const date = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const PROMPTS = [
  { name: 'Rédaction', text: WRITER_SYSTEM },
  { name: 'Relecture (vérification)', text: VERIFIER_SYSTEM },
  { name: 'Interprétation des demandes', text: INTERPRETER_SYSTEM },
  { name: 'Visuels', text: VISUAL_SYSTEM },
  { name: 'Contrôle des images', text: INSPECTOR_SYSTEM },
  { name: 'Ligne éditoriale proposée', text: EDITORIAL_PROPOSAL_SYSTEM },
];

/**
 * ADM-04 : valeurs par défaut des nouveaux espaces et comptes ; modèles d'IA et consignes
 * versionnées. Le modèle est un réglage du serveur (AI_MODEL) et les consignes sont dans le
 * code : les changer est une mise en production, tracée par PROMPT_VERSION sur chaque rédaction.
 */
export default async function SettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const adminId = await requireAdmin();
  const { message } = await searchParams;
  const settings = await asSystem(database(), (trx) => loadPlatformSettings(trx));
  const usage = await aiModelsInUse(database(), adminId, new Date());
  const current = model();
  return (
    <>
      <h1>Paramètres et IA</h1>
      <Flash code={message} />
      <section aria-labelledby="defauts">
        <h2 id="defauts">Valeurs par défaut</h2>
        <p className="hint">Appliquées aux espaces et aux comptes créés à partir de maintenant ; chaque client les modifie ensuite dans ses réglages.</p>
        <form action={saveSettingsAction} className="stack">
          {PLATFORM_SETTING_KEYS.map((key) => (
            <label key={key}>
              {PLATFORM_SETTINGS[key].label}
              <input name={key} type="number" min={PLATFORM_SETTINGS[key].min} max={PLATFORM_SETTINGS[key].max} defaultValue={settings[key]} required />
            </label>
          ))}
          <button type="submit">Enregistrer les paramètres</button>
        </form>
      </section>

      <section aria-labelledby="ia">
        <h2 id="ia">Modèles d’IA</h2>
        <p>
          Application web : <strong>{current.provider === 'simulation' ? 'IA simulée (développement)' : `${current.provider} · ${current.model}`}</strong>. Consignes en vigueur : version{' '}
          <strong>{PROMPT_VERSION}</strong>.
        </p>
        <h3>Utilisés ces 30 derniers jours</h3>
        <table>
          <thead>
            <tr>
              <th scope="col">Fournisseur</th>
              <th scope="col">Modèle</th>
              <th scope="col">Usage</th>
              <th scope="col">Appels</th>
              <th scope="col">Coût</th>
            </tr>
          </thead>
          <tbody>
            {usage.models.map((m) => (
              <tr key={`${m.provider}-${m.model}-${m.purpose}`}>
                <th scope="row">{m.provider}</th>
                <td>{m.model}</td>
                <td>{m.purpose}</td>
                <td>{m.calls}</td>
                <td>{m.costEur.toFixed(2).replace('.', ',')} €</td>
              </tr>
            ))}
          </tbody>
        </table>
        <h3>Rédactions par version des consignes</h3>
        <ul>
          {usage.prompts.map((p) => (
            <li key={`${p.version}-${p.model}`}>
              {p.version} · {p.model} : {p.runs} rédaction{p.runs > 1 ? 's' : ''}, la dernière le {date.format(p.lastAt)}
            </li>
          ))}
        </ul>
        <h3>Consignes (version {PROMPT_VERSION})</h3>
        {PROMPTS.map((p) => (
          <details key={p.name}>
            <summary>{p.name}</summary>
            <pre className="pre">{p.text}</pre>
          </details>
        ))}
      </section>
    </>
  );
}
