import { messageFor } from '../server/messages.ts';

/** Message après une action ; annoncé aux lecteurs d'écran (NF-08). */
export function Flash({ code }: { code: string | string[] | undefined }) {
  const message = messageFor(code);
  if (message === null) return null;
  return (
    <p className={`flash ${message.tone}`} role={message.tone === 'error' ? 'alert' : 'status'}>
      {message.text}
    </p>
  );
}
