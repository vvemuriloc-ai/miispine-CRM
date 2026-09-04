# Apps Script — reading the sheet without an API key

## Why

The CRM used a Google API key in client-side JavaScript. An API key can only read
**publicly shared** data, which is why the spreadsheet had to be set to
"anyone with the link — reader". Combined with the sheet ID sitting in the same
file, that made the whole outreach pipeline world-readable to anyone who found it.

Rotating the key did not change that. `doGet.gs` does: the script runs as the
owner, so the sheet can be private.

## What this achieves, honestly

**Fixed:** no API key in the browser · the spreadsheet can be shared with named
people only · the sheet ID no longer leaves the server · the endpoint is
revocable by changing one script property.

**Not fixed:** the CRM is still a static page with no login, so the read token it
carries is visible to anyone who views source. The token is an identifier that can
be rotated, not a password. Someone who has both the deployment URL and the token
can read the data.

That is strictly better than before — the data is no longer discoverable from the
sheet ID alone, and access can be cut instantly — but it is obfuscation, not
authentication. Do not describe it to anyone as "secured".

## The real fix, when it's worth the effort

Serve the CRM itself from Apps Script rather than static hosting:

```js
function doGet(e) {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('miiSpine Outreach CRM');
}
```

Deploy with **Execute as: Me**, **Who has access: Anyone with a Google account**.
Google then handles login, you control access by sharing, and reads/writes go
through `google.script.run` with no token in the page at all.

Cost: the app is served from a `script.google.com` URL (staff re-bookmark), and
`index.html` lives in the Apps Script project, so it needs pushing to two places
or managing with `clasp`. Worth doing if the CRM ever holds anything more
sensitive than business contact details.

## Deployment gotcha

Editing the script does **not** change what the URL serves. Every time:
**Deploy → Manage deployments → edit → Version: New version → Deploy.**
Forgetting this is the usual cause of "I changed it and nothing happened."
