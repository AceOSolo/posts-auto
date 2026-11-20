/**
 * CSV pour Excel en français : séparateur « ; », BOM, fins de ligne CRLF.
 * Chaque cellule est entre guillemets ; une valeur qui commencerait comme une formule
 * (=, +, -, @) est neutralisée, pour qu'un tableur ne l'exécute pas à l'ouverture.
 */
export function csvCell(value: string | number | boolean | null | undefined): string {
  const text = value === null || value === undefined ? '' : String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function toCsv(rows: readonly (readonly (string | number | boolean | null | undefined)[])[]): string {
  return `﻿${rows.map((row) => row.map(csvCell).join(';')).join('\r\n')}\r\n`;
}

export function csvResponse(csv: string, fileName: string): Response {
  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${fileName.replace(/[^\w.-]/g, '_')}"`,
      'cache-control': 'no-store',
    },
  });
}
