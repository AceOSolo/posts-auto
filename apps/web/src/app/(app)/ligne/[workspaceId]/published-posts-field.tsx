'use client';

/**
 * Posts déjà publiés, ajoutés un par un (ONB-04) : le texte, que l'IA lit, et le lien du post,
 * facultatif. Un post saisi sans avoir cliqué sur « Ajouter » part quand même avec le formulaire,
 * qui reste ainsi utilisable sans JavaScript (pour un post).
 */
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import styles from './published-posts.module.css';

const MAX_POSTS = 5;
const MIN_CHARS = 20;
const MAX_CHARS = 3000;
const LINKEDIN_POST = /^https:\/\/([a-z]{2,3}\.)?linkedin\.com\/(feed\/update|posts)\/\S+$/;

interface PublishedPost {
  readonly id: number;
  readonly text: string;
  readonly url: string;
}

export function PublishedPostsField() {
  const nextId = useRef(1);
  const textArea = useRef<HTMLTextAreaElement>(null);
  const [active, setActive] = useState(false);
  const [posts, setPosts] = useState<readonly PublishedPost[]>([]);
  const [text, setText] = useState('');
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setActive(true), []);

  const add = () => {
    const body = text.trim();
    const link = url.trim();
    if (body.length < MIN_CHARS) {
      setError('Collez le texte complet du post : c’est lui que l’IA lit.');
      textArea.current?.focus();
      return;
    }
    if (link !== '' && !LINKEDIN_POST.test(link)) {
      setError('Ce lien n’est pas celui d’un post LinkedIn (linkedin.com/posts/… ou linkedin.com/feed/update/…).');
      return;
    }
    setPosts((current) => [...current, { id: nextId.current++, text: body, url: link }]);
    setText('');
    setUrl('');
    setError(null);
    textArea.current?.focus();
  };

  // Entrée dans le champ du lien ajoute le post au lieu d'envoyer tout le formulaire.
  const addOnEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || !active) return;
    event.preventDefault();
    add();
  };

  const full = posts.length >= MAX_POSTS;

  return (
    <div role="group" aria-labelledby="posts-publies-titre" className={styles.field}>
      <div>
        <p id="posts-publies-titre" className={styles.title}>
          Vos meilleurs posts <span className={styles.optional}>(facultatif, {MAX_POSTS} au plus)</span>
        </p>
        <p className="hint">Choisissez ceux qui vous ressemblent le plus : l’IA s’en sert pour saisir votre ton et vos sujets.</p>
      </div>

      {posts.length > 0 && (
        <ol className={styles.list}>
          {posts.map((post, index) => (
            <li key={post.id} className={styles.item}>
              <input type="hidden" name="post-texte" value={post.text} />
              <input type="hidden" name="post-lien" value={post.url} />
              <div className={styles.itemBody}>
                <strong>Post {index + 1}</strong>
                <p className={styles.excerpt}>{post.text}</p>
                <p className={styles.meta}>
                  {post.text.length} caractères
                  {post.url !== '' && (
                    <>
                      {' · '}
                      <a href={post.url} target="_blank" rel="noopener noreferrer">
                        Voir sur LinkedIn
                      </a>
                    </>
                  )}
                </p>
              </div>
              <button type="button" onClick={() => setPosts((current) => current.filter((p) => p.id !== post.id))} aria-label={`Retirer le post ${index + 1}`}>
                Retirer
              </button>
            </li>
          ))}
        </ol>
      )}

      {full ? (
        <p className="hint">Vous avez ajouté {MAX_POSTS} posts : c’est suffisant pour que l’IA saisisse votre style.</p>
      ) : (
        <div className={styles.composer}>
          <label htmlFor="post-texte">{posts.length === 0 ? 'Texte du post' : `Texte du post ${posts.length + 1}`}</label>
          <textarea
            ref={textArea}
            id="post-texte"
            name="post-texte"
            rows={5}
            minLength={MIN_CHARS}
            maxLength={MAX_CHARS}
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setError(null);
            }}
            placeholder="Collez ici le texte du post, tel que publié."
            aria-describedby={error === null ? undefined : 'post-erreur'}
          />
          <label htmlFor="post-lien">Lien du post (facultatif)</label>
          <input
            id="post-lien"
            name="post-lien"
            type="url"
            inputMode="url"
            maxLength={500}
            value={url}
            onChange={(event) => {
              setUrl(event.target.value);
              setError(null);
            }}
            onKeyDown={addOnEnter}
            placeholder="https://www.linkedin.com/posts/…"
            aria-describedby="post-lien-aide"
          />
          <p id="post-lien-aide" className="hint">
            Pour le retrouver. LinkedIn ne permet pas de lire un post depuis son lien : seul le texte collé compte pour l’IA.
          </p>
          {error !== null && (
            <p id="post-erreur" className="flash error" role="alert">
              {error}
            </p>
          )}
          {active && (
            <div>
              <button type="button" onClick={add}>
                Ajouter ce post
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
