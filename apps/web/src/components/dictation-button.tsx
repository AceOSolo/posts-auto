'use client';

/**
 * Dictée vocale (IDE-05), par la reconnaissance vocale du navigateur (Chrome, Edge, Safari,
 * sur ordinateur et téléphone). Le bouton n'apparaît que si le navigateur la propose ; le
 * texte dicté s'ajoute au champ, que la personne relit avant d'envoyer.
 */
import { useEffect, useRef, useState } from 'react';

interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  start(): void;
  stop(): void;
}

type RecognitionConstructor = new () => Recognition;

function recognitionConstructor(): RecognitionConstructor | null {
  const w = window as unknown as { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function DictationButton({ targetId }: { targetId: string }) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recognition = useRef<Recognition | null>(null);

  useEffect(() => setSupported(recognitionConstructor() !== null), []);

  const toggle = () => {
    if (listening) {
      recognition.current?.stop();
      return;
    }
    const Constructor = recognitionConstructor();
    const field = document.getElementById(targetId) as HTMLTextAreaElement | null;
    if (Constructor === null || field === null) return;
    const r = new Constructor();
    r.lang = 'fr-FR';
    r.continuous = true;
    r.interimResults = false;
    r.onresult = (event) => {
      let text = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (result?.isFinal) text += result[0].transcript;
      }
      if (text.trim() !== '') field.value = `${field.value}${field.value === '' || field.value.endsWith(' ') || field.value.endsWith('\n') ? '' : ' '}${text.trim()}`;
    };
    r.onerror = (event) => setError(event.error === 'not-allowed' ? 'Micro refusé : autorisez-le dans le navigateur.' : 'La dictée s’est interrompue.');
    r.onend = () => setListening(false);
    recognition.current = r;
    setError(null);
    setListening(true);
    r.start();
  };

  if (!supported) return null;
  return (
    <span className="dictation">
      <button type="button" onClick={toggle} aria-pressed={listening}>
        {listening ? '■ Arrêter la dictée' : '🎤 Dicter'}
      </button>
      <span aria-live="polite" className="hint">
        {listening ? 'Parlez : le texte s’ajoute au champ.' : (error ?? 'La dictée passe par le service de reconnaissance vocale de votre navigateur (chez Google pour Chrome).')}
      </span>
    </span>
  );
}
