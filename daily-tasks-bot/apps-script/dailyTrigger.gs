/**
 * Paste this into Extensions > Apps Script from your Google Sheet, then add
 * a time-driven trigger (see SETUP.md step 5). It just pings the bot's
 * /cron/daily endpoint once a day -- all the actual logic (building and
 * sending the message) lives on the server.
 *
 * The URL (which contains your CRON_SECRET) is read from a Script Property
 * instead of being pasted into this source file, so it's never visible if
 * you ever share this script's code with anyone.
 *
 * One-time setup inside the Apps Script editor:
 *   Project Settings (gear icon) > Script Properties > Add script property
 *   Name: CRON_URL
 *   Value: https://<your-render-url>/cron/daily?key=<your CRON_SECRET>
 */
function sendDailyTasksDigest() {
  var url = PropertiesService.getScriptProperties().getProperty('CRON_URL');
  if (!url) {
    Logger.log('CRON_URL script property is not set -- see the comment at the top of this file.');
    return;
  }

  // Render's free tier can be asleep and take up to ~50s to wake up, so this
  // tries twice before giving up.
  for (var attempt = 1; attempt <= 2; attempt++) {
    try {
      var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      Logger.log('Attempt ' + attempt + ': HTTP ' + response.getResponseCode() + ' ' + response.getContentText());
      if (response.getResponseCode() === 200) return;
    } catch (err) {
      Logger.log('Attempt ' + attempt + ' failed: ' + err.message);
    }
    if (attempt === 1) Utilities.sleep(15000);
  }
}
