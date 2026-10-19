const constants = require('../core/constants');
const dkimManager = require('../src/dkim-manager');

/**
 * Haraka-style DKIM Signing Plugin
 * Hooks into 'data_post' to load domain DKIM key and attach cryptographic signature.
 */
exports.register = function() {
  console.log('[Plugin: dkim_sign] DKIM Signing plugin active');
};

exports.hook_data_post = function(next, connection) {
  const tx = connection.transaction;
  if (!tx || !tx.mail_from || !tx.mail_from.domain) {
    return next(constants.CONT);
  }

  const domain = tx.mail_from.domain;
  const key = dkimManager.getKey(domain);

  if (key) {
    tx.notes.dkim_config = {
      domainName: key.domain,
      keySelector: key.selector,
      privateKey: key.privateKey
    };
    tx.notes.dkim_signed = true;
    connection.log(`[DKIM] Attached DKIM signing key for domain "${domain}" (selector: ${key.selector})`, 'info');
  } else {
    connection.log(`[DKIM] No DKIM key found for "${domain}". Sending unsigned.`, 'info');
  }

  next(constants.CONT);
};
