/** Client-side CSV export for reports. */
export type CsvCell = string | number | null | undefined;

/** Cents as a plain decimal ("1234.50") so spreadsheets treat it as a number. */
export const csvMoney = (cents: number) => (cents / 100).toFixed(2);

function cell(value: CsvCell): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return String(value);
  // Text that starts like a formula is neutralized so a spreadsheet won't execute it
  // (e.g. a customer named "=HYPERLINK(...)"). Plain numbers such as "-12.50" are left alone.
  const numeric = /^-?\d+(\.\d+)?$/.test(value);
  let text = !numeric && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function toCsv(rows: CsvCell[][]): string {
  return rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

export function downloadCsv(filename: string, rows: CsvCell[][]) {
  // Byte-order mark so Excel opens UTF-8 names (accents etc.) correctly.
  const blob = new Blob(["﻿", toCsv(rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
