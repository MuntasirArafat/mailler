const constants = require('../core/constants');

/**
 * Haraka Outbound Queue Plugin
 * Hooks into 'queue' to push accepted transactions into the disk spooler.
 */
exports.register = function() {
  console.log('[Plugin: queue_outbound] Spooler active, ready to route to direct MX');
};

exports.hook_queue = function(next, connection) {
  const tx = connection.transaction;
  if (!tx) {
    return next(constants.DENY, '5.3.0 No transaction found to queue');
  }

  try {
    const queue = connection.server.outboundQueue;
    const todoId = queue.enqueue(tx);
    connection.log(`[Queue] Message ${tx.uuid} queued to outbound spooler (${todoId})`, 'info');
    next(constants.OK, `Message accepted for direct delivery as ${tx.uuid}`);
  } catch (err) {
    connection.log(`[Queue Error] Failed to spool message: ${err.message}`, 'error');
    next(constants.DENYSOFT, '4.3.0 Temporary queue error, please try again');
  }
};
