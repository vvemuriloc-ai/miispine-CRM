/**
 * miiSpine Outreach CRM — read handler.
 *
 * Lets the CRM read the sheet with no Google API key in the browser, so the
 * spreadsheet can be shared with named people instead of "anyone with link".
 *
 * THREE RULES:
 *  1. This must be at the TOP LEVEL of the file. Not inside myFunction().
 *  2. A project can have only ONE doGet. Delete any other one.
 *  3. Leave doPost alone — the CRM's writes need it.
 *
 * Script properties required: SHEET_ID, READ_TOKEN.
 * After editing: Deploy → Manage deployments → edit → Version: New version.
 *
 * See apps-script/README.md for what the token does and does not protect.
 */

function doGet(e) {
  var params = (e && e.parameter) || {};

  // Bare URL: the original health check, kept so nothing that used it breaks.
  if (!params.tab && !params.token) {
    return json({ status: 'miiSpine CRM Script is live' });
  }

  var props = PropertiesService.getScriptProperties();
  var expected = props.getProperty('READ_TOKEN');

  if (!expected || params.token !== expected) {
    return json({ error: { message: 'Unauthorized' } });
  }

  try {
    var id = props.getProperty('SHEET_ID');
    if (!id) return json({ error: { message: 'SHEET_ID script property is not set' } });
    if (!params.tab) return json({ error: { message: 'Missing tab parameter' } });

    var sheet = SpreadsheetApp.openById(id).getSheetByName(params.tab);
    if (!sheet) return json({ error: { message: 'No sheet named "' + params.tab + '"' } });

    // Same response shape the Sheets API returned, so the client is unchanged.
    var rows = sheet.getRange(
      1, 1,
      Math.max(sheet.getLastRow(), 1),
      Math.min(Math.max(sheet.getLastColumn(), 1), params.wide ? 52 : 26)
    ).getDisplayValues();

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
