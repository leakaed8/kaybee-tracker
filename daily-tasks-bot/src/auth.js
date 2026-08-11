// Pure whitelist check: only the configured Telegram user id may use the
// bot. Every command and callback handler must call this before touching
// any data.
function isAuthorized(allowedUserId, incomingUserId) {
  if (!allowedUserId) return false; // setup mode: nobody is authorized yet
  if (incomingUserId == null) return false;
  return String(incomingUserId) === String(allowedUserId);
}

module.exports = { isAuthorized };
