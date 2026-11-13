-- EDI-08 : rendez-vous récurrents à relayer (webinaires mensuels, salons annuels, journées
-- mondiales choisies). L'événement modèle porte la récurrence ; ses prochaines occurrences
-- sont créées comme des événements ordinaires (series_id), relayés selon PLA-04.

ALTER TABLE events
  ADD COLUMN recurrence text NOT NULL DEFAULT 'none' CHECK (recurrence IN ('none', 'weekly', 'monthly', 'yearly')),
  ADD COLUMN recurrence_until date,
  ADD COLUMN series_id uuid,
  ADD CONSTRAINT events_series_fk FOREIGN KEY (series_id, workspace_id) REFERENCES events (id, workspace_id) ON DELETE CASCADE,
  -- Une occurrence n'est jamais elle-même récurrente.
  ADD CONSTRAINT events_occurrence_check CHECK (series_id IS NULL OR recurrence = 'none'),
  ADD CONSTRAINT events_recurrence_until_check CHECK (recurrence_until IS NULL OR recurrence_until >= starts_on);
CREATE UNIQUE INDEX events_series_date_idx ON events (series_id, starts_on) WHERE series_id IS NOT NULL;
