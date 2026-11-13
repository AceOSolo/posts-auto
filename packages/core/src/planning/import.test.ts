import { describe, expect, it } from 'vitest';
import { detectDelimiter, isoWeekNumber, mondayOfIsoWeek, parseCsv, subjectsOfCell, weekFromHeader } from './csv.ts';
import { type RowTarget, pamEntries, readPamLayout, readSubjectSheet } from './pam-import.ts';

describe('lecture CSV', () => {
  it('guillemets, guillemets doublés, retours à la ligne dans une cellule, BOM', () => {
    const csv = '﻿Compte,S47,S48\r\n"JP","Sujet 1\nSujet 2","Il a dit ""bonjour"""\r\nSecutop,,Salon\r\n';
    expect(parseCsv(csv)).toEqual([
      ['Compte', 'S47', 'S48'],
      ['JP', 'Sujet 1\nSujet 2', 'Il a dit "bonjour"'],
      ['Secutop', '', 'Salon'],
    ]);
  });

  it('reconnaît le séparateur « ; » d’Excel en français et la tabulation', () => {
    expect(detectDelimiter('Compte;S47;S48\nJP;a;b')).toBe(';');
    expect(detectDelimiter('Compte\tS47\tS48')).toBe('\t');
    expect(detectDelimiter('"a;b",c,d')).toBe(',');
    expect(parseCsv('a;b\n1;2\n\n;;\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('complète les lignes courtes', () => {
    expect(parseCsv('a,b,c\n1')).toEqual([
      ['a', 'b', 'c'],
      ['1', '', ''],
    ]);
  });
});

describe('en-têtes de semaine', () => {
  it.each([
    ['S47', '2026-11-16'],
    ['Semaine 1', '2025-12-29'],
    ['sem. 12', '2026-03-16'],
    ['2026-11-18', '2026-11-16'],
    ['18/11/2026', '2026-11-16'],
    ['18/11', '2026-11-16'],
    ['18.11.26', '2026-11-16'],
    ['18 nov.', '2026-11-16'],
    ['3 février 2027', '2027-02-01'],
    ['1 juillet', '2026-06-29'],
  ])('« %s » → semaine du %s', (header, monday) => {
    expect(weekFromHeader(header, 2026)).toBe(monday);
  });

  it.each(['Compte', 'Notes', 'S54', '32/13', '12 machin', ''])('« %s » n’est pas une semaine', (header) => {
    expect(weekFromHeader(header, 2026)).toBeNull();
  });

  it('numéros de semaine ISO', () => {
    expect(mondayOfIsoWeek(2026, 53)).toBe('2026-12-28');
    expect(mondayOfIsoWeek(2027, 53)).toBeNull();
    expect(isoWeekNumber('2026-11-16')).toBe(47);
  });

  it('une cellule peut contenir plusieurs sujets, un par ligne', () => {
    expect(subjectsOfCell('- Webinaire DUERP\n\n• Témoignage client  \n')).toEqual(['Webinaire DUERP', 'Témoignage client']);
  });
});

describe('import du planning (PLA-05)', () => {
  const table = parseCsv(
    [
      'PAM 2026,,,',
      'Ligne,S47,S48,Notes',
      'Jean-Pierre,Webinaire DUERP,"Rentrée\nRecrutement",',
      'Salons,,Preventica,',
      'Page Secutop,Offre SST,,à revoir',
      'Vide,,,',
    ].join('\n'),
  );

  it('repère l’en-tête, les semaines et les lignes utiles', () => {
    const layout = readPamLayout(table, 2026);
    expect(layout?.weekColumns.map((w) => [w.header, w.weekStart])).toEqual([
      ['S47', '2026-11-16'],
      ['S48', '2026-11-23'],
    ]);
    expect(layout?.rows.map((r) => r.label)).toEqual(['Jean-Pierre', 'Salons', 'Page Secutop']);
  });

  it('crée un sujet par ligne de cellule, selon le choix fait pour chaque ligne', () => {
    const layout = readPamLayout(table, 2026);
    if (layout === null) throw new Error('mise en page non reconnue');
    const targets = new Map<string, RowTarget>([
      ['Jean-Pierre', { kind: 'account', accountId: 'jp' }],
      ['Salons', { kind: 'event', label: 'Salons' }],
      ['Page Secutop', { kind: 'ignore' }],
    ]);
    expect(pamEntries(layout, targets).map((e) => [e.rowKind, e.accountId ?? e.rowLabel, e.weekStart, e.content, e.sourceRef])).toEqual([
      ['account', 'jp', '2026-11-16', 'Webinaire DUERP', 'Jean-Pierre | S47'],
      ['account', 'jp', '2026-11-23', 'Rentrée', 'Jean-Pierre | S48'],
      ['account', 'jp', '2026-11-23', 'Recrutement', 'Jean-Pierre | S48'],
      ['event', 'Salons', '2026-11-23', 'Preventica', 'Salons | S48'],
    ]);
  });

  it('un fichier sans colonnes de semaine n’est pas un planning', () => {
    expect(readPamLayout(parseCsv('Nom,Prénom\nDupont,Jean'), 2026)).toBeNull();
  });
});

describe('import d’une banque de sujets (PLA-03)', () => {
  it('reconnaît les colonnes par leur nom et lit l’état « publié »', () => {
    const rows = readSubjectSheet(parseCsv('Edito LK\nThème;Sujet;Angle;Publié\nSST;Former ses salariés;Coût;oui\nDUERP;;;\nRPS;Prévenir le burn-out;;')) ?? [];
    expect(rows).toEqual([
      { subject: 'Former ses salariés', theme: 'SST', angle: 'Coût', format: null, offer: null, audience: null, published: true, sourceRef: 'ligne 3' },
      { subject: 'Prévenir le burn-out', theme: 'RPS', angle: null, format: null, offer: null, audience: null, published: false, sourceRef: 'ligne 5' },
    ]);
    expect(readSubjectSheet(parseCsv('a,b\n1,2'))).toBeNull();
  });
});
