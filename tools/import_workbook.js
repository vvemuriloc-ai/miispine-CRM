#!/usr/bin/env node
// ============================================================
// miiCase AR — turn the legacy PI AR workbook into load-ready SQL.
//
//   node import_workbook.js "PIP Status List.xlsx" -o miicase_import.sql
//
// Then open Cloud SQL Studio (Google Cloud console → SQL → your instance),
// paste/run miicase_import.sql, then run:
//   select * from normalize_import();
//   select * from import_reconcile;
//
// PHI stays on covered surfaces: this runs on YOUR machine, and the SQL is
// pasted only into Cloud SQL (BAA-covered). Nothing touches third parties.
//
// Pure Node — no npm packages, no `unzip` binary — runs on a stock Windows/
// Mac/Linux Node install (.xlsx is a zip of XML; zlib does the inflation).
//
// v2: columns are mapped by HEADER NAME per tab (typo-tolerant), not by
// position, because the live workbook drifted from the reference layout
// (adds First DOS / Category / Sub-Category / "Additinal information",
// drops Voice Mail). A tab with no header row (the PAID tab) reuses the
// previous tab's mapping. The generated SQL first applies the matching
// schema upgrade (also in gcp/db/migrations/0012_workbook_v2.sql), so the
// paste is self-contained and idempotent.
//
//   --csv   emit the legacy 16-column staging CSV to stdout (debug/verify)
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

// ---- XLSX → rows ------------------------------------------------------------
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

// ---- Header-name column mapping (typo-tolerant) -----------------------------
const g = (r, i) => (r[i] ?? "").toString().trim();
const normHdr = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");

// field -> matcher over the normalized header text
const FIELD_RULES = [
  ["patient_name",    (h) => h.startsWith("patientname")],
  ["pip_claim",       (h) => h.includes("pipclaim") || h === "claim" || h === "claimno"],
  ["doi_raw",         (h) => h === "doi" || h === "dateofinjury"],
  ["charges_raw",     (h) => h.startsWith("charge")],
  ["first_dos_raw",   (h) => h.includes("firstdos") || h === "dos"],
  ["medical_insurance",(h) => h.includes("medicalinsurance") || h === "healthinsurance"],
  ["lien_on_file",    (h) => h.includes("lienonfile") || h === "lien"],
  ["pip_payer",       (h) => h.includes("pippayer")],
  ["attorney",        (h) => h.includes("attorney")],
  ["status_raw",      (h) => h.includes("exhausted") || h === "status" || h.startsWith("openexhausted")],
  ["last_action_raw", (h) => h.startsWith("lastaction")],
  ["notes",           (h) => h === "notes" || h === "note"],
  ["category",        (h) => h === "category"],
  ["sub_category",    (h) => h.includes("subcategory")],
  ["voice_mail",      (h) => h.includes("voicemail")],
  ["assigned_to",     (h) => h.includes("assignedto") || h.includes("assigedto") || (h.startsWith("assi") && h.endsWith("to"))],
  ["additional_info", (h) => h.includes("additionalinfo") || h.includes("additinal")],
  // "Worked By" is the reference book's companion stamp column; the validated
  // import treated it as the fax-date fallback (col14 || col13), so keep it.
  ["faxed",           (h) => h.startsWith("fax") || h.includes("faxed") || h === "workedby"],
];

// The pre-v2 reference layout, used only when a headerless tab appears before
// any headered one.
const LEGACY_POSITIONS = {
  patient_name: [0], pip_claim: [1], doi_raw: [2], charges_raw: [3],
  medical_insurance: [4], lien_on_file: [5], pip_payer: [6], attorney: [7],
  status_raw: [8], last_action_raw: [9], notes: [10], voice_mail: [11],
  assigned_to: [12], faxed: [14, 13],
};

function mapHeader(row) {
  const map = {}; // field -> [col indexes, in preference order]
  row.forEach((cell, idx) => {
    const h = normHdr(cell);
    if (!h) return;
    for (const [field, test] of FIELD_RULES) {
      if (test(h)) { (map[field] ??= []).push(idx); break; }
    }
  });
  // faxed: prefer the rightmost column (matches the legacy "col14 else col13").
  if (map.faxed) map.faxed = map.faxed.slice().reverse();
  return map;
}

const pick = (map, r, field) => {
  for (const idx of map[field] ?? []) { const v = g(r, idx); if (v) return v; }
  return "";
};

const ALL_FIELDS = ["patient_name","pip_claim","doi_raw","charges_raw","first_dos_raw",
  "medical_insurance","lien_on_file","pip_payer","attorney","status_raw","last_action_raw",
  "notes","category","sub_category","voice_mail","assigned_to","additional_info","faxed"];

// The header row is not always row 1 (title rows above it are common) — scan
// the first few rows for one that maps patient_name plus several other fields.
function findHeader(rows) {
  for (let r = 0; r < Math.min(rows.length, 8); r++) {
    const map = mapHeader(rows[r]);
    if (map.patient_name && Object.keys(map).length >= 4) return { map, dataStart: r + 1 };
  }
  return null;
}

// --tabs "Name1,Name2" imports only the named tabs (case-insensitive).
const tIdx = args.indexOf("--tabs");
const ONLY_TABS = tIdx >= 0
  ? new Set(args[tIdx + 1].split(",").map((t) => t.trim().toLowerCase()).filter(Boolean))
  : null;
// --headers-from "Tab Name": tabs with no header row of their own borrow the
// named tab's column layout (for worklists whose header row was never typed).
const hIdx = args.indexOf("--headers-from");
const HEADERS_FROM = hIdx >= 0 ? args[hIdx + 1].trim().toLowerCase() : null;

// Pass 1: parse every sheet and detect headers, so a headerless tab can
// borrow a mapping regardless of tab order.
const parsed = sheets.map((s) => ({ ...s, rows: parseSheet(s.path), found: null }));
for (const p of parsed) p.found = findHeader(p.rows);

let borrowMap = null;
if (HEADERS_FROM) {
  const src = parsed.find((p) => p.name.trim().toLowerCase() === HEADERS_FROM);
  if (!src) { console.error(`ERROR: --headers-from tab "${args[hIdx + 1]}" not found in workbook`); process.exit(1); }
  if (!src.found) { console.error(`ERROR: --headers-from tab "${src.name}" has no detectable header row`); process.exit(1); }
  borrowMap = src.found.map;
}

const records = [];
let lastMap = null;
const layoutNotes = [];
for (const p of parsed) {
  if (ONLY_TABS && !ONLY_TABS.has(p.name.trim().toLowerCase())) {
    layoutNotes.push(`${p.name}: SKIPPED (not in --tabs)`);
    continue;
  }
  let map, dataStart, how;
  if (p.found) {
    map = p.found.map; dataStart = p.found.dataStart;
    lastMap = map;
    how = `header on row ${dataStart}, ${Object.keys(map).length} columns mapped`;
    const missing = ["patient_name", "charges_raw", "attorney"].filter((f) => !map[f]);
    if (missing.length) console.error(`WARNING tab "${p.name}": could not find column(s): ${missing.join(", ")}`);
  } else if (borrowMap) {
    map = borrowMap; dataStart = 0;
    how = `no header — using "${args[hIdx + 1]}" layout (--headers-from)`;
  } else {
    map = lastMap ?? LEGACY_POSITIONS;
    dataStart = 0;
    how = `NO HEADER FOUND — reusing ${lastMap ? "previous tab's mapping" : "legacy positions"} (verify this tab!)`;
  }
  layoutNotes.push(`${p.name}: ${how}`);
  p.rows.slice(dataStart).forEach((r, i) => {
    if (!g(r, 0)) return;
    const rec = { source_tab: p.name, source_row: i + 1 + dataStart };
    for (const f of ALL_FIELDS) rec[f] = pick(map, r, f);
    // Skip repeated header lines pasted into the data area.
    if (normHdr(rec.patient_name).startsWith("patientname")) return;
    records.push(rec);
  });
}

// ---- Emit -------------------------------------------------------------------
// Keep in sync with gcp/db/migrations/0012_workbook_v2.sql (embedded so the
// Cloud SQL Studio paste is self-contained; idempotent).
const MIGRATION_SQL = `
alter table staging_import add column if not exists first_dos_raw   text;
alter table staging_import add column if not exists category        text;
alter table staging_import add column if not exists sub_category    text;
alter table staging_import add column if not exists additional_info text;

create or replace function normalize_import()
returns table(cases_created int, firms_total int, rows_flagged int)
language plpgsql as $fn$
declare
  v_prov uuid; rec record;
  v_firm uuid; v_client uuid; v_case uuid;
  v_first text; v_last text; v_charges numeric; v_lien boolean;
  v_doi date; v_dos date; v_las date; v_pip text; v_paid boolean;
  v_notes text;
  v_review boolean; v_reason text;
  n_imp int := 0; n_rev int := 0;
begin
  insert into providers(name, type, is_miispine, emr_system)
    values ('miiSpine Surgery Center', 'spine_surgery', true, 'modmed')
    on conflict (lower(name)) do nothing;
  select id into v_prov from providers where lower(name) = 'miispine surgery center' limit 1;

  insert into firms(name)
    select distinct on (import_firm_key(attorney)) import_firm_display(attorney)
    from staging_import
    where import_firm_display(attorney) is not null
    order by import_firm_key(attorney)
    on conflict (import_firm_key(name)) do nothing;
  insert into firms(name) values ('Unassigned (import)')
    on conflict (import_firm_key(name)) do nothing;

  for rec in
    select distinct on (lower(trim(patient_name)), coalesce(nullif(lower(trim(pip_claim)), ''), '~n~')) *
    from staging_import
    where coalesce(trim(patient_name), '') <> ''
    order by lower(trim(patient_name)),
             coalesce(nullif(lower(trim(pip_claim)), ''), '~n~'),
             import_is_paid(status_raw) desc,
             import_parse_date(last_action_raw) desc nulls last, id
  loop
    v_review := false; v_reason := '';
    v_last  := trim(split_part(rec.patient_name, ',', 1));
    v_first := nullif(trim(split_part(rec.patient_name, ',', 2)), '');
    if v_first is null then v_review := true; v_reason := v_reason || 'no-comma-name; '; v_first := ''; end if;

    v_charges := import_parse_money(rec.charges_raw);
    if v_charges is null then v_review := true; v_reason := v_reason || 'charges-unparsed; '; v_charges := 0; end if;

    v_lien := import_lien(rec.lien_on_file);
    v_doi  := import_parse_date(rec.doi_raw);
    v_dos  := import_parse_date(rec.first_dos_raw);
    v_las  := import_parse_date(rec.last_action_raw);
    v_pip  := import_pip_status(rec.status_raw);
    if v_pip is null then v_review := true; v_reason := v_reason || 'status-unrecognized; '; v_pip := 'open'; end if;
    v_paid := import_is_paid(rec.status_raw);

    v_notes := nullif(concat_ws(' | ', nullif(trim(rec.notes), ''), nullif(trim(rec.additional_info), '')), '');

    if import_firm_display(rec.attorney) is null then
      v_review := true; v_reason := v_reason || 'no-attorney; ';
      select id into v_firm from firms where import_firm_key(name) = import_firm_key('Unassigned (import)') limit 1;
    else
      select id into v_firm from firms where import_firm_key(name) = import_firm_key(rec.attorney) limit 1;
    end if;

    select id into v_client from clients
      where lower(last_name) = lower(v_last)
        and lower(coalesce(first_name, '')) = lower(coalesce(v_first, '')) limit 1;
    if v_client is null then
      insert into clients(first_name, last_name) values (coalesce(v_first, ''), v_last) returning id into v_client;
    end if;

    select id into v_case from cases
      where client_id = v_client
        and coalesce(claim_number, '') = coalesce(nullif(trim(rec.pip_claim), ''), '')
        and firm_id = v_firm limit 1;

    if v_case is null then
      insert into cases(firm_id, client_id, claim_number, date_of_injury, liability_carrier,
                        status, opened_at, last_outreach_at, followup_priority,
                        assigned_to, notes, health_insurance, review_status, review_reason)
        values (v_firm, v_client, nullif(trim(rec.pip_claim), ''), v_doi, nullif(trim(rec.pip_payer), ''),
                case when v_paid then 'settled' else 'active' end,
                coalesce(v_dos, v_doi, v_las, current_date), v_las::timestamptz, 'normal',
                nullif(trim(rec.assigned_to), ''), v_notes, nullif(trim(rec.medical_insurance), ''),
                case when v_review then 'needs_review' else 'ok' end, nullif(v_reason, ''))
        returning id into v_case;

      insert into pip_ledger(case_id, firm_id, carrier, claim_number, status, total_available, total_paid)
        values (v_case, v_firm, nullif(trim(rec.pip_payer), ''), nullif(trim(rec.pip_claim), ''),
                case when v_paid then 'closed' else v_pip end,
                10000, case when v_pip = 'exhausted' then 10000 else 0 end)
        on conflict (case_id) do nothing;

      insert into medical_bills(case_id, firm_id, provider_id, date_of_service, description,
                               billed_amount, pip_paid, insurance_paid, lien_type,
                               collected_amount, bill_status)
        values (v_case, v_firm, v_prov, coalesce(v_dos, v_doi, v_las, current_date), 'Imported aggregate charges',
                v_charges, 0, 0,
                case when coalesce(v_lien, false) then 'other' else null end,
                case when v_paid then v_charges else 0 end,
                case when v_paid then 'settled'
                     when coalesce(v_lien, false) then 'lien_active' else 'outstanding' end);

      if v_notes is not null then
        insert into outreach_log(case_id, firm_id, channel, direction, body, ai_generated, sent_by, sent_at)
          values (v_case, v_firm, 'portal_alert', 'outbound', v_notes, false,
                  nullif(trim(rec.assigned_to), ''), v_las::timestamptz);
      end if;

      n_imp := n_imp + 1;
    end if;

    if v_review then n_rev := n_rev + 1; end if;
    update staging_import set imported_case_id = v_case, needs_review = v_review,
                              review_reason = nullif(v_reason, '') where id = rec.id;
  end loop;

  return query select n_imp, (select count(*)::int from firms), n_rev;
end;
$fn$;
`.trim();

const LEGACY_COLS = ["source_tab","source_row","patient_name","pip_claim","doi_raw","charges_raw",
  "medical_insurance","lien_on_file","pip_payer","attorney","status_raw","last_action_raw",
  "notes","voice_mail","assigned_to","faxed"];
const SQL_COLS = LEGACY_COLS.concat(["first_dos_raw","category","sub_category","additional_info"]);

let output;
if (CSV_MODE) {
  const csvCell = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  output = [LEGACY_COLS.join(",")]
    .concat(records.map((r) => LEGACY_COLS.map((c) => (c === "source_row" ? r[c] : csvCell(r[c]))).join(",")))
    .join("\n") + "\n";
} else {
  const q = (s) => `'${String(s ?? "").replace(/'/g, "''")}'`;
  const lines = [
    "-- miiCase legacy-workbook import (generated by tools/import_workbook.js v2)",
    `-- source: ${FILE.replace(/.*[\\/]/, "")} · ${records.length} rows from ${sheets.length} tabs`,
    ...layoutNotes.map((n) => `--   ${n}`),
    "-- Run this whole file in Cloud SQL Studio, then:",
    "--   select * from normalize_import();",
    "--   select * from import_reconcile;",
    MIGRATION_SQL,
    "begin;",
    "delete from staging_import;",
  ];
  for (let i = 0; i < records.length; i += 50) {
    const batch = records.slice(i, i + 50)
      .map((r) => `(${SQL_COLS.map((c) => (c === "source_row" ? Number(r[c]) : q(r[c]))).join(",")})`)
      .join(",\n");
    lines.push(`insert into staging_import (${SQL_COLS.join(",")}) values\n${batch};`);
  }
  lines.push("commit;");
  lines.push(`-- ${records.length} rows staged. Now run: select * from normalize_import();`);
  output = lines.join("\n") + "\n";
}

if (OUT) {
  fs.writeFileSync(OUT, output);
  console.error(`wrote ${OUT} (${records.length} rows from ${sheets.length} tabs)`);
  for (const n of layoutNotes) console.error("  " + n);
} else {
  process.stdout.write(output);
  console.error(`extracted ${records.length} rows from ${sheets.length} tabs`);
}
