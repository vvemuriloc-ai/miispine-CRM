#!/usr/bin/env node
// ============================================================
// miiCase AR — turn the legacy PI AR workbook into load-ready SQL.
//
//   node import_workbook.js "Master PI AR Sheet.xlsx" -o miicase_import.sql
//
// Then open Cloud SQL Studio (Google Cloud console → SQL → your instance),
// paste/run miicase_import.sql, then run:
//   select * from normalize_import();
//   select * from import_reconcile;
//
// PHI stays on covered surfaces: this runs on YOUR machine, and the SQL is
// pasted only into Cloud SQL (BAA-covered). Nothing touches third parties.
//
// Pure Node — no npm packages, no `unzip` binary — so it runs on a stock
// Windows/Mac/Linux Node install. (.xlsx is a zip of XML; the zip reader and
// inflate below use only Node's built-in zlib.)
//
//   --csv   emit the legacy staging CSV to stdout instead of SQL (debugging)
// ============================================================
"use strict";
const fs = require("fs");
const zlib = require("zlib");

const args = process.argv.slice(2);
const FILE = args.find((a) => !a.startsWith("-"));
const CSV_MODE = args.includes("--csv");
const oIdx = args.indexOf("-o");
const OUT = oIdx >= 0 ? args[oIdx + 1] : null;
if (!FILE) {
  console.error('usage: node import_workbook.js <workbook.xlsx> [-o out.sql] [--csv]');
  process.exit(1);
}

// ---- Minimal .zip reader (central directory + inflateRaw) ------------------
function zipEntries(buf) {
  // Find End Of Central Directory (sig 0x06054b50), scanning back over comment.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip/xlsx file (no end-of-central-directory)");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error("bad central directory");
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const cmtLen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    entries[name] = { method, csize, lho };
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return {
    read(name) {
      const e = entries[name];
      if (!e) throw new Error(`missing ${name} in workbook`);
      // Local header: sig(4) ver(2) flag(2) method(2) time(4) crc(4) csize(4)
      // usize(4) nameLen(2) extraLen(2) — data follows.
      const lh = e.lho;
      if (buf.readUInt32LE(lh) !== 0x04034b50) throw new Error("bad local header");
      const nameLen = buf.readUInt16LE(lh + 26);
      const extraLen = buf.readUInt16LE(lh + 28);
      const start = lh + 30 + nameLen + extraLen;
      const raw = buf.subarray(start, start + e.csize);
      if (e.method === 0) return raw.toString("utf8");
      if (e.method === 8) return zlib.inflateRawSync(raw).toString("utf8");
      throw new Error(`unsupported zip compression method ${e.method}`);
    },
  };
}

const zip = zipEntries(fs.readFileSync(FILE));
const rd = (p) => zip.read(p);

// ---- XLSX → rows (same mapping as the original extractor) ------------------
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

const rels = {};
for (const m of rd("xl/_rels/workbook.xml.rels").matchAll(/Id="(rId\d+)"[^>]*Target="([^"]+)"/g)) rels[m[1]] = m[2];
const sheets = [];
for (const m of rd("xl/workbook.xml").matchAll(/<sheet[^>]*name="([^"]+)"[^>]*r:id="(rId\d+)"/g))
  sheets.push({ name: decode(m[1]), path: "xl/" + rels[m[2]].replace(/^\/?xl\//, "") });

const g = (r, i) => (r[i] ?? "").toString().trim();

const records = [];
for (const s of sheets) {
  const rows = parseSheet(s.path);
  const hasHeader = g(rows[0] || [], 0).toLowerCase().startsWith("patient name");
  const data = hasHeader ? rows.slice(1) : rows;
  data.forEach((r, i) => {
    if (!g(r, 0)) return;
    records.push([
      s.name, i + 1 + (hasHeader ? 1 : 0),
      g(r, 0), g(r, 1), g(r, 2), g(r, 3), g(r, 4), g(r, 5), g(r, 6), g(r, 7),
      g(r, 8), g(r, 9), g(r, 10), g(r, 11), g(r, 12), g(r, 14) || g(r, 13),
    ]);
  });
}

// ---- Emit -------------------------------------------------------------------
const COLS = ["source_tab","source_row","patient_name","pip_claim","doi_raw","charges_raw",
  "medical_insurance","lien_on_file","pip_payer","attorney","status_raw","last_action_raw",
  "notes","voice_mail","assigned_to","faxed"];

let output;
if (CSV_MODE) {
  const csvCell = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  output = [COLS.join(",")]
    .concat(records.map((r) => r.map((v, i) => (i === 1 ? v : csvCell(v))).join(",")))
    .join("\n") + "\n";
} else {
  const q = (s) => `'${String(s ?? "").replace(/'/g, "''")}'`;
  const lines = [
    "-- miiCase legacy-workbook import (generated by tools/import_workbook.js)",
    `-- source: ${FILE.replace(/.*[\\/]/, "")} · ${records.length} rows from ${sheets.length} tabs`,
    "-- Run this in Cloud SQL Studio, then:",
    "--   select * from normalize_import();",
    "--   select * from import_reconcile;",
    "begin;",
    "delete from staging_import;",
  ];
  for (let i = 0; i < records.length; i += 50) {
    const batch = records.slice(i, i + 50)
      .map((r) => `(${r.map((v, j) => (j === 1 ? Number(v) : q(v))).join(",")})`)
      .join(",\n");
    lines.push(`insert into staging_import (${COLS.join(",")}) values\n${batch};`);
  }
  lines.push("commit;");
  lines.push(`-- ${records.length} rows staged. Now run: select * from normalize_import();`);
  output = lines.join("\n") + "\n";
}

if (OUT) {
  fs.writeFileSync(OUT, output);
  console.error(`wrote ${OUT} (${records.length} rows from ${sheets.length} tabs)`);
} else {
  process.stdout.write(output);
  console.error(`extracted ${records.length} rows from ${sheets.length} tabs`);
}
