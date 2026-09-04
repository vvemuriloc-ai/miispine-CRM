/**
 * miiSpine Outreach CRM — read handler
 *
 * IMPORTANT: Apps Script allows exactly ONE doGet in a project. If the project
 * already has one (the original returned {"status":"miiSpine CRM Script is
 * live"}), you cannot simply add a second — one silently overrides the other.
 * REPLACE the old doGet with this one. It preserves the original health-check
 * response when called with no parameters, so nothing that relied on it breaks.
 *
 * Leave doPost alone — the CRM's writes depend on it.
 *
 * Purpose: let the CRM read the sheet WITHOUT a Google API key in the browser.
 * This script runs as you, so the spreadsheet can be shared with named people
 * only instead of "anyone with the link".
 *
 * ── Setup ────────────────────────────────────────────────────────────────
 * 1. Project Settings → Script properties → add:
 *      SHEET_ID     = 1VqKy0ofK_xX33fQ1fX0qSHni1pI_5WUs_sEynbTcpwA
 *      READ_TOKEN   = <any long random string you generate>
 * 2. Deploy → Manage deployments → edit the existing deployment →
 *      Version: NEW VERSION   (without this the URL keeps serving old code)
 *      Execute as: Me
 *      Who has access: Anyone
 * 3. Put the same READ_TOKEN into index.html as READ_TOKEN.
 * 4. Once the CRM loads, set the spreadsheet's sharing to specific people
 *    and delete the Google API key.
 *
 * ── What the token is and is not ─────────────────────────────────────────
 * The token lives in client-side JavaScript, so anyone who views source can
 * read it. It is NOT authentication. What it buys you: the sheet stops being
 * world-readable by ID, the endpoint is revocable in one click by changing
 * the property, and casual discovery of the sheet no longer exposes the data.
 * For real authentication see apps-script/README.md.
 */

function doGet(e) {
  var params = (e && e.parameter) || {};

  // No parameters: keep the original health check so anything pointing at the
  // bare URL still gets the response it expects.
  if (!params.tab && !params.token) {
    return json({ status: 'miiSpine CRM Script is live' });
  }

  var props = PropertiesService.getScriptProperties();
  var expected = props.getProperty('READ_TOKEN');
  var given = params.token || '';

  if (!expected || given !== expected) {
    return json({ error: { message: 'Unauthorized' } });
  }

  try {
    var id = props.getProperty('SHEET_ID');
    if (!id) return json({ error: { message: 'SHEET_ID script property is not set' } });

    var ss  = SpreadsheetApp.openById(id);
    var tab = params.tab;
    if (!tab) return json({ error: { message: 'Missing tab parameter' } });

    var sheet = ss.getSheetByName(tab);
    if (!sheet) return json({ error: { message: 'No sheet named "' + tab + '"' } });

    // Match the Sheets API response shape so the client code stays simple.
    var lastCol = params.wide ? 52 : 26;              // AZ or Z
    var rows = sheet.getRange(
      1, 1,
      Math.max(sheet.getLastRow(), 1),
      Math.min(Math.max(sheet.getLastColumn(), 1), lastCol)
    ).getDisplayValues();

    // Trim wholly empty trailing rows, as the Sheets API does.
    while (rows.length && rows[rows.length - 1].every(function (c) { return c === ''; })) rows.pop();

    return json({ values: rows });
  } catch (err) {
    return json({ error: { message: String(err) } });
  }
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
