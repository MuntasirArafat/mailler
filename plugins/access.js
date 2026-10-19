const constants = require('../core/constants');

/**
 * Access / Relay Protection Plugin
 * Permits relaying from localhost / trusted IPs or authenticated users.
 * Blocks open relay abuse from unauthorized external IPs.
 */
exports.register = function() {
  console.log('[Plugin: access] Access and relaying rules active');
};

exports.hook_connect = function(next, connection) {
  const ip = connection.remote_ip;
  // Trust localhost / private subnets by default
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip === 'localhost') {
    connection.relaying = true;
    connection.log(`Client IP ${ip} marked as TRUSTED (relaying enabled)`, 'info');
  }
  next(constants.CONT);
};

exports.hook_rcpt = function(next, connection, params) {
  const rcpt = params[0];
  if (!rcpt) return next(constants.DENY, '5.5.4 Invalid recipient');

  // If connection is allowed to relay, allow any destination
  if (connection.relaying) {
    return next(constants.CONT);
  }

  // If not relaying, only accept mail destined for our local domains (if configured)
  const allowedLocalDomains = ['localmta.dev', 'localhost'];
  if (allowedLocalDomains.includes(rcpt.domain)) {
    return next(constants.CONT);
  }

  connection.log(`Relay attempt rejected for recipient <${rcpt.address}> from unauthenticated ${connection.remote_ip}`, 'warn');
  return next(constants.DENY, '5.7.1 Relaying denied. Please authenticate or send from authorized host.');
};
