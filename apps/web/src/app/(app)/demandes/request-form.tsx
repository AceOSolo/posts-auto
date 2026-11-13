'use client';

/**
 * Formulaire de demande de post (IDE-03), avec pré-remplissage par l'IA (IDE-04).
 *
 * Le formulaire fonctionne sans JavaScript ; le bouton « Pré-remplir avec l'IA » n'apparaît
 * qu'une fois la page active. Les champs remplis par l'IA sont marqués « pré-rempli » : la
 * personne les vérifie avant d'envoyer, rien n'est envoyé à sa place.
 */
import { useEffect, useRef, useState, useTransition } from 'react';
import type { PrefillResult } from './actions.ts';

interface Props {
  readonly accounts: readonly { readonly id: string; readonly name: string }[];
  readonly action: (form: FormData) => Promise<void>;
  readonly interpret: (rawText: string) => Promise<PrefillResult>;
}

function Prefilled({ on }: { on: boolean }) {
  return on ? <span className="badge prefilled">pré-rempli</span> : null;
}

export function RequestForm({ accounts, action, interpret }: Props) {
  const form = useRef<HTMLFormElement>(null);
  const [active, setActive] = useState(false);
  const [pending, startTransition] = useTransition();
  const [filled, setFilled] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string; toSpecify: readonly string[] } | null>(null);
  useEffect(() => setActive(true), []);

  const prefill = () => {
    const element = form.current;
    if (element === null) return;
    const text = (element.elements.namedItem('demande') as HTMLTextAreaElement).value;
    startTransition(async () => {
      const result = await interpret(text);
      if (!result.ok) {
        setNotice({ tone: 'error', text: result.message, toSpecify: [] });
        return;
      }
      const done = new Set<string>();
      if (result.accountIds.length > 0) {
        element.querySelectorAll<HTMLInputElement>('input[name="comptes"]').forEach((box) => {
          box.checked = result.accountIds.includes(box.value);
        });
        done.add('comptes');
      }
      if (result.wishedDate !== null) {
        (element.elements.namedItem('date') as HTMLInputElement).value = result.wishedDate;
        done.add('date');
      }
      if (result.wishedTime !== null) {
        (element.elements.namedItem('heure') as HTMLInputElement).value = result.wishedTime;
        done.add('heure');
      }
      if (result.links.length > 0) {
        const field = element.elements.namedItem('liens') as HTMLTextAreaElement;
        const lines = new Set([...field.value.split('\n').map((l) => l.trim()).filter(Boolean), ...result.links]);
        field.value = [...lines].join('\n');
        done.add('liens');
      }
      setFilled(done);
      setNotice({
        tone: 'success',
        text:
          (done.size > 0 ? `Sujet compris : « ${result.title} ». Vérifiez les champs marqués « pré-rempli » avant d’envoyer.` : 'L’IA n’a trouvé ni compte, ni date, ni lien dans la demande.') +
          (result.suspicious ? ' La demande contenait une consigne adressée à l’IA : elle a été ignorée.' : ''),
        toSpecify: result.toSpecify,
      });
    });
  };

  return (
    <form ref={form} action={action} className="stack">
      <label htmlFor="demande">Ce que vous voulez dire</label>
      <textarea id="demande" name="demande" rows={5} required maxLength={5000} aria-describedby="demande-aide" />
      <p id="demande-aide" className="hint">
        Les faits, les chiffres, les noms : l’IA n’invente rien et marquera [À COMPLÉTER] ce qui manque.
      </p>
      {active && (
        <button type="button" onClick={prefill} disabled={pending}>
          {pending ? 'Lecture de la demande…' : 'Pré-remplir avec l’IA'}
        </button>
      )}
      <div aria-live="polite">
        {notice && (
          <div className={`flash ${notice.tone}`}>
            <p>{notice.text}</p>
            {notice.toSpecify.length > 0 && (
              <>
                <p>À préciser dans la demande :</p>
                <ul>
                  {notice.toSpecify.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </div>
      <fieldset>
        <legend>
          Comptes <Prefilled on={filled.has('comptes')} />
        </legend>
        {accounts.map((a) => (
          <label key={a.id} className="check">
            <input type="checkbox" name="comptes" value={a.id} /> {a.name}
          </label>
        ))}
      </fieldset>
      <div className="inline-fields">
        <div>
          <label htmlFor="date">
            Date souhaitée <Prefilled on={filled.has('date')} />
          </label>
          <input id="date" name="date" type="date" />
        </div>
        <div>
          <label htmlFor="heure">
            Heure <Prefilled on={filled.has('heure')} />
          </label>
          <input id="heure" name="heure" type="time" step={300} />
        </div>
      </div>
      <p className="hint">Sans date, le post prend le prochain créneau libre. Si le créneau souhaité est pris, il prend le plus proche après.</p>
      <label htmlFor="liens">
        Liens (un par ligne) <Prefilled on={filled.has('liens')} />
      </label>
      <textarea id="liens" name="liens" rows={2} />
      <label htmlFor="photos">Photos (9 au plus ; la première est le visuel principal)</label>
      <input id="photos" name="photos" type="file" accept="image/jpeg,image/png,image/gif" multiple />
      <button type="submit" className="primary">
        Envoyer la demande
      </button>
    </form>
  );
}
