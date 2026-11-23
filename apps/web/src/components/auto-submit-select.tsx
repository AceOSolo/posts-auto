'use client';

import type { ComponentProps } from 'react';

/** Une liste qui applique son choix aussitôt. Sans JavaScript, le formulaire garde son bouton. */
export function AutoSubmitSelect(props: ComponentProps<'select'>) {
  return <select {...props} onChange={(event) => event.currentTarget.form?.requestSubmit()} />;
}
