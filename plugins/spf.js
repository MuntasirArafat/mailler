const constants = require('../core/constants');
const dns = require('dns').promises;

/**
 * Haraka-style SPF (Sender Policy Framework) Plugin
 * Inspects sender domain SPF records on 'mail' hook.
 */
exports.register = function() {
  console.log('[Plugin: spf] SPF validation plugin active');
};

exports.hook_mail = async function(next, connection, params) {
  const mail_from = params[0];
  if (!mail_from || !mail_from.domain) {
    return next(constants.CONT);
  }

  try {
    const txts = await dns.resolveTxt(mail_from.domain);
    const flattened = txts.map(t => t.join(''));
    const spfRecord = flattened.find(r => r.startsWith('v=spf1'));

    if (spfRecord) {
      connection.transaction.notes.spf_record = spfRecord;
      connection.log(`[SPF] Found SPF record for ${mail_from.domain}: ${spfRecord}`, 'info');
    } else {
      connection.log(`[SPF] No SPF record for ${mail_from.domain}`, 'info');
    }
  } catch (err) {
    // DNS error, continue without hard rejection
    connection.log(`[SPF Lookup Error] ${err.message}`, 'warn');
  }

  next(constants.CONT);
};
