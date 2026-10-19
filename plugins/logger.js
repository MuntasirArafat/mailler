const constants = require('../core/constants');

exports.register = function() {
  console.log('[Plugin: logger] Registered Haraka event logger');
};

exports.hook_connect = function(next, connection) {
  connection.log(`Incoming TCP connection from ${connection.remote_ip}:${connection.remote_port}`, 'info');
  next(constants.CONT);
};

exports.hook_mail = function(next, connection, params) {
  const mail_from = params[0] ? params[0].address : 'unknown';
  connection.log(`MAIL FROM: <${mail_from}>`, 'info');
  next(constants.CONT);
};

exports.hook_rcpt = function(next, connection, params) {
  const rcpt_to = params[0] ? params[0].address : 'unknown';
  connection.log(`RCPT TO: <${rcpt_to}>`, 'info');
  next(constants.CONT);
};

exports.hook_data = function(next, connection) {
  connection.log('DATA command received, entering payload streaming mode', 'info');
  next(constants.CONT);
};

exports.hook_data_post = function(next, connection) {
  const tx = connection.transaction;
  const bytes = tx.raw_data ? tx.raw_data.length : 0;
  connection.log(`DATA completed (${bytes} bytes). Subject: "${tx.getSubject()}"`, 'info');
  next(constants.CONT);
};

exports.hook_disconnect = function(next, connection) {
  connection.log('Client disconnected', 'info');
  next(constants.CONT);
};
