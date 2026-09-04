// miiSpine Outreach CRM — Google Apps Script Backend
// Paste this entire file into Extensions → Apps Script → Code.gs (replace all)
// Then Deploy → Manage deployments → edit → Version: New version → Deploy
//
// Only doGet has changed: it now reads the sheet for the CRM, so index.html
// needs no Google API key and the spreadsheet can be shared with named people
// instead of "anyone with the link". Everything below doGet is untouched.
//
// Requires ONE script property:  READ_TOKEN  (Project Settings → Script properties)
// SHEET_ID is not needed — this script is bound to the spreadsheet.

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    const action  = payload.action;

    if (action === 'ensureSheet')  return respond(ensureSheet(payload));
    if (action === 'append')       return respond(appendRow(payload));
    if (action === 'batchAppend')  return respond(batchAppend(payload));
    if (action === 'update')       return respond(updateRow(payload));
    if (action === 'deleteRow')    return respond(deleteRow(payload));

    return respond({ error: 'Unknown action: ' + action });
  } catch(err) {
    return respond({ error: err.toString() });
  }
}

// ── Read handler ──────────────────────────────────────────────────────
// No params  → the original health check, so anything using it still works.
// ?token=…&tab=…  → returns { values: [...] }, the same shape the Sheets API
//                    returned, so the CRM's parsing is unchanged.
// &wide=1     → widen from column Z to AZ (the Outscraper import needs this).
function doGet(e) {
  const params = (e && e.parameter) || {};

  if (!params.tab && !params.token) {
    return respond({ status: 'miiSpine CRM Script is live' });
  }

  const expected = PropertiesService.getScriptProperties().getProperty('READ_TOKEN');
  if (!expected || params.token !== expected) {
    return respond({ error: 'Unauthorized' });
  }

  try {
    if (!params.tab) return respond({ error: 'Missing tab parameter' });

    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(params.tab);
    if (!sheet) return respond({ error: 'No sheet named "' + params.tab + '"' });

    const rows = sheet.getRange(
      1, 1,
      Math.max(sheet.getLastRow(), 1),
      Math.min(Math.max(sheet.getLastColumn(), 1), params.wide ? 52 : 26)
    ).getDisplayValues();

    while (rows.length && rows[rows.length - 1].every(c => c === '')) rows.pop();

    return respond({ values: rows });
  } catch(err) {
    return respond({ error: err.toString() });
  }
}

function respond(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── Get or create a sheet tab ─────────────────────────────────────────
function ensureSheet(payload) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const name  = payload.sheet;
  let sheet   = ss.getSheetByName(name);

  // Sheet already exists — don't touch it
  if (sheet) return { status: 'exists', sheet: name };

  // Create it — but since our clean sheet already has the right tabs,
  // this should only fire for truly missing sheets
  sheet = ss.insertSheet(name);
  if (payload.headers) {
    sheet.getRange(1, 1, 1, payload.headers.length).setValues([payload.headers]);
  }
  return { status: 'created', sheet: name };
}

// ── Find a row by id or by phone+name key ─────────────────────────────
function findRow(sheet, id, phone, practice) {
  const data = sheet.getDataRange().getValues();
  if (!data.length) return -1;

  const headers = data[0].map(h => String(h).trim().toLowerCase());
  const idCol   = headers.indexOf('id');

  // Try matching by CRM id first
  if (id && idCol !== -1) {
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][idCol]).trim() === String(id).trim()) return i + 1; // 1-indexed sheet row
    }
  }

  // Fallback: match by phone number (digits only)
  const phoneCol    = headers.indexOf('phone');
  const practiceCol = headers.findIndex(h => h === 'practice name' || h === 'firm name' || h === 'practice');

  if (phone && phoneCol !== -1) {
    const cleanPhone = phone.replace(/\D/g, '');
    for (let i = 1; i < data.length; i++) {
      const rowPhone = String(data[i][phoneCol] || '').replace(/\D/g, '');
      if (cleanPhone && rowPhone === cleanPhone) return i + 1;
    }
  }

  // Last resort: match by practice/firm name
  if (practice && practiceCol !== -1) {
    const cleanName = String(practice).toLowerCase().trim();
    for (let i = 1; i < data.length; i++) {
      const rowName = String(data[i][practiceCol] || '').toLowerCase().trim();
      if (cleanName && rowName === cleanName) return i + 1;
    }
  }

  return -1;
}

// ── Get column index map from header row ──────────────────────────────
function getHeaderMap(sheet) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const map = {};
  headers.forEach((h, i) => { map[String(h).trim()] = i + 1; }); // 1-indexed columns
  return map;
}

// ── Append a single row ───────────────────────────────────────────────
function appendRow(payload) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(payload.sheet);
  if (!sheet) return { error: 'Sheet not found: ' + payload.sheet };

  sheet.appendRow(payload.values);
  return { status: 'appended' };
}

// ── Batch append multiple rows ────────────────────────────────────────
function batchAppend(payload) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(payload.sheet);
  if (!sheet) return { error: 'Sheet not found: ' + payload.sheet };

  const rows = payload.values;
  if (!rows || !rows.length) return { status: 'nothing to append' };

  const lastRow = sheet.getLastRow();
  sheet.getRange(lastRow + 1, 1, rows.length, rows[0].length).setValues(rows);
  return { status: 'batchAppended', count: rows.length };
}

// ── Update a row — matches by id, phone, or name ──────────────────────
function updateRow(payload) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(payload.sheet);
  if (!sheet) return { error: 'Sheet not found: ' + payload.sheet };

  const values   = payload.values;  // CRM column array [id, type, firstname, ...]
  const id       = payload.id || (values && values[0]);
  const phone    = values && values[5]; // phone is index 5 in COLS
  const practice = values && values[4]; // practice is index 4 in COLS

  const rowNum = findRow(sheet, id, phone, practice);

  if (rowNum === -1) {
    // Row not found — append it instead so the update isn't lost
    sheet.appendRow(values);
    return { status: 'appended_not_found' };
  }

  // Found the row — now update only the CRM tracking columns
  // (touch, completed, nextActionDate, lastContactDate, notes)
  // without overwriting the clean contact data already in the sheet
  const headerMap = getHeaderMap(sheet);

  // CRM field positions in the values array (matches COLS order)
  const COLS = ['id','type','firstname','lastname','practice','phone','email','website',
                'address','city','zip','source','priority','touch','completed',
                'nextActionDate','lastContactDate','createdAt','notes'];

  const colsToUpdate = {
    'touch':           COLS.indexOf('touch'),
    'completed':       COLS.indexOf('completed'),
    'nextActionDate':  COLS.indexOf('nextActionDate'),
    'lastContactDate': COLS.indexOf('lastContactDate'),
    'notes':           COLS.indexOf('notes'),
    'priority':        COLS.indexOf('priority'),
    'source':          COLS.indexOf('source'),
  };

  // Also write the id back so future updates can find by id
  const idColInSheet = headerMap['id'];
  if (idColInSheet) {
    sheet.getRange(rowNum, idColInSheet).setValue(id || '');
  }

  // Write each tracked field to its column if the sheet has that column
  for (const [fieldName, valIdx] of Object.entries(colsToUpdate)) {
    // Try exact field name first, then title-cased variants
    const sheetCol = headerMap[fieldName]
      || headerMap['Touch Status']    // clean sheet column name
      || null;

    // Map field names to clean sheet column names
    const cleanSheetCols = {
      'touch':           'Touch Status',
      'completed':       'Touch Status',
      'nextActionDate':  'Next Action Date',
      'lastContactDate': 'Last Contact Date',
      'notes':           'Notes',
      'priority':        'Priority',
      'source':          'Source',
    };

    const col = headerMap[fieldName] || headerMap[cleanSheetCols[fieldName]];
    if (col && values[valIdx] !== undefined) {
      // For touch/completed, write a human-readable status to "Touch Status" col
      if (fieldName === 'touch') {
        const touchNum  = parseInt(values[valIdx]) || 1;
        const completed = values[COLS.indexOf('completed')] === 'true';
        // touchNum = which touch they are CURRENTLY ON
        // so "sent" count = touchNum - 1
        // touch=1 → Not Started, touch=2 → Touch 1 Sent, touch=3 → Touch 2 Sent, touch=4 → Touch 3 Sent/Complete
        const labels    = ['Not Started', 'Not Started', 'Touch 1 Sent', 'Touch 2 Sent', 'Touch 3 Sent'];
        const label     = completed ? 'Complete' : (labels[touchNum] || 'Touch ' + (touchNum - 1) + ' Sent');
        const touchStatusCol = headerMap['Touch Status'];
        if (touchStatusCol) sheet.getRange(rowNum, touchStatusCol).setValue(label);
        // Also write raw touch number if there's a separate 'touch' column
        if (headerMap['touch']) sheet.getRange(rowNum, headerMap['touch']).setValue(touchNum);
      } else if (fieldName !== 'completed') {
        sheet.getRange(rowNum, col).setValue(values[valIdx]);
      }
    }
  }

  return { status: 'updated', row: rowNum };
}

// ── Delete a row ──────────────────────────────────────────────────────
function deleteRow(payload) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(payload.sheet);
  if (!sheet) return { error: 'Sheet not found: ' + payload.sheet };

  const rowNum = findRow(sheet, payload.id, null, null);
  if (rowNum === -1) return { status: 'not_found' };

  sheet.deleteRow(rowNum);
  return { status: 'deleted', row: rowNum };
}
