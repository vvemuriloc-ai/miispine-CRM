#!/usr/bin/env node
// ============================================================
// miiCase AR — extract the legacy PI AR workbook to a staging CSV.
//
//   node tools/import_from_xlsx.js <workbook.xlsx> > staging.csv
//
// Then load + normalize (see README "Importing the legacy sheet"):
//   \copy staging_import(source_tab,source_row,patient_name,pip_claim,doi_raw,
//     charges_raw,medical_insurance,lien_on_file,pip_payer,attorney,status_raw,
//     last_action_raw,notes,voice_mail,assigned_to,faxed)
//     from 'staging.csv' with (format csv, header true)
//   select * from normalize_import();
//   select * from import_reconcile;
//
// No PHI leaves your machine — this is a local file → local DB conversion.
// Parses .xlsx (a zip of XML) with only Node + `unzip`; no npm deps.
// ============================================================
const { execSync } = require("child_process");

const FILE = process.argv[2];
if (!FILE) { console.error("usage: node import_from_xlsx.js <workbook.xlsx> > staging.csv"); process.exit(1); }
const rd = (p) => execSync(`unzip -p "${FILE}" "${p}"`, { maxBuffer: 1 << 28 }).toString("utf8");
const decode = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, "&");

const shared = [];
for (const m of rd("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g))
  shared.push(decode([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join("")));

const colIdx = (c) => { let n = 0; for (const ch of c) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };
function parseSheet(path) {
  const rows = [];
  for (const rm of rd(path).matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = {};
    for (const cm of rm[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*)>([\s\S]*?)<\/c>/g)) {
      const col = colIdx(cm[1]), a = cm[2], inner = cm[3];
      const vm = inner.match(/<v>([\s\S]*?)<\/v>/);
      let v = "";
      if (/t="s"/.test(a) && vm) v = shared[+vm[1]] ?? "";
      else if (/t="inlineStr"/.test(a)) { const t = inner.match(/<t[^>]*>([\s\S]*?)<\/t>/); v = t ? decode(t[1]) : ""; }
      else if (vm) v = vm[1];
      cells[col] = v;
    }
    const max = Math.max(-1, ...Object.keys(cells).map(Number));
    rows.push(Array.from({ length: max + 1 }, (_, i) => cells[i] ?? ""));
  }
  return rows;
}

// Resolve sheet name → worksheet path.
const rels = {};
for (const m of rd("xl/_rels/workbook.xml.rels").matchAll(/Id="(rId\d+)"[^>]*Target="([^"]+)"/g)) rels[m[1]] = m[2];
const sheets = [];
for (const m of rd("xl/workbook.xml").matchAll(/<sheet[^>]*name="([^"]+)"[^>]*r:id="(rId\d+)"/g))
  sheets.push({ name: decode(m[1]), path: "xl/" + rels[m[2]].replace(/^\/?xl\//, "") });

// The workbook's tabs are worklists with the same columns. Only the header
// presence differs (the PAID tab has none).
const g = (r, i) => (r[i] ?? "").toString().trim();
const csvCell = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;

const HEADER = ["source_tab","source_row","patient_name","pip_claim","doi_raw","charges_raw",
  "medical_insurance","lien_on_file","pip_payer","attorney","status_raw","last_action_raw",
  "notes","voice_mail","assigned_to","faxed"];
const out = [HEADER.join(",")];

for (const s of sheets) {
  const rows = parseSheet(s.path);
  // A tab has a header if its first cell reads "Patient Name".
  const hasHeader = g(rows[0] || [], 0).toLowerCase().startsWith("patient name");
  const data = hasHeader ? rows.slice(1) : rows;
  data.forEach((r, i) => {
    if (!g(r, 0)) return; // skip blank spacer rows
    out.push([
      csvCell(s.name), i + 1 + (hasHeader ? 1 : 0),
      csvCell(g(r, 0)), csvCell(g(r, 1)), csvCell(g(r, 2)), csvCell(g(r, 3)),
      csvCell(g(r, 4)), csvCell(g(r, 5)), csvCell(g(r, 6)), csvCell(g(r, 7)),
      csvCell(g(r, 8)), csvCell(g(r, 9)), csvCell(g(r, 10)), csvCell(g(r, 11)),
      csvCell(g(r, 12)), csvCell(g(r, 14) || g(r, 13)),
    ].join(","));
  });
}
process.stdout.write(out.join("\n") + "\n");
process.stderr.write(`extracted ${out.length - 1} data rows from ${sheets.length} tabs\n`);
