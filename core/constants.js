/**
 * Haraka-style SMTP Return Codes & Constants
 */
const constants = {
  // Hook execution return codes
  CONT: 900,            // Continue to next plugin in the chain
  OK: 901,              // Plugin handled this hook successfully; skip remaining plugins
  DENY: 902,            // 5xx Permanent failure (reject transaction)
  DENYSOFT: 903,        // 4xx Temporary failure (try again later)
  DENYDISCONNECT: 904,  // 5xx Error and immediately disconnect client
  DISCONNECT: 905,      // Immediately disconnect client cleanly

  // SMTP Response Code defaults
  default_responses: {
    902: [550, '5.7.1 Message or recipient rejected'],
    903: [451, '4.7.1 Temporary error, please try again later'],
    904: [554, '5.7.1 Transaction failed, closing transmission channel']
  }
};

module.exports = constants;
