#!/usr/bin/env node

const DnsChecker = require('./src/dns-checker');

function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        options[key] = next;
        i++;
      } else {
        options[key] = true;
      }
    } else if (!options._command) {
      options._command = arg;
    } else if (!options._target) {
      options._target = arg;
    }
  }
  return options;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._command;

  if (!cmd || cmd === 'help' || args.help) {
    console.log(`
Direct Node.js Mail Server CLI (Direct MTA Delivery)

Usage:
  node cli.js send --to <email> --from <email> --subject "<subj>" --body "<text>"
  node cli.js test-port25 [host]
  node cli.js check-domain <domain>
  node cli.js generate-dkim <domain> [selector]

Commands:
  send             Send direct mail to recipient MX server on port 25
  test-port25      Test if outbound port 25 is reachable (e.g. to Google MX)
  check-domain     Inspect MX, SPF, DKIM, and DMARC DNS records for a domain
  generate-dkim    Generate 2048-bit RSA DKIM key & display DNS TXT records

Options for 'send':
  --to             Recipient email address (e.g. user@gmail.com)
  --from           Sender email address (e.g. admin@yourdomain.com)
  --subject        Email subject
  --body           Email plain text content
  --html           Optional HTML content
  --helo           Optional custom HELO/EHLO hostname
    `);
    process.exit(0);
  }

  if (cmd === 'test-port25') {
    const host = args._target || args.host || 'gmail-smtp-in.l.google.com';
    console.log(`Testing outbound TCP connection to ${host}:25...`);
    const res = await DnsChecker.testPort25(host, 25);
    if (res.open) {
      console.log(`\x1b[32m✔ SUCCESS: Port 25 is OPEN!\x1b[0m Latency: ${res.latencyMs}ms`);
      console.log(`Remote Banner: ${res.banner}`);
      console.log(`Your machine can send emails directly without third-party SMTP!`);
    } else {
      console.log(`\x1b[31m✖ FAILED: Port 25 unreachable.\x1b[0m`);
      console.log(`Details: ${res.error}`);
    }
    return;
  }

  if (cmd === 'check-domain') {
    const domain = args._target || args.domain;
    if (!domain) {
      console.error('Please specify a domain: node cli.js check-domain example.com');
      process.exit(1);
    }
    console.log(`Inspecting DNS deliverability records for ${domain}...`);
    const res = await DnsChecker.checkDomain(domain, args.selector || 'default');
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (cmd === 'generate-dkim') {
    const dkimManager = require('./src/dkim-manager');
    const domain = args._target || args.domain;
    const selector = args.selector || 'default';
    if (!domain) {
      console.error('Please specify a domain: node cli.js generate-dkim example.com');
      process.exit(1);
    }
    const key = dkimManager.generateKey(domain, selector);
    console.log(`\n\x1b[32m✔ DKIM Key Generated for ${domain}!\x1b[0m\n`);
    console.log(`Add this TXT Record in your DNS:`);
    console.log(`-----------------------------------------------------------------`);
    console.log(`Host / Name : ${key.recordName}`);
    console.log(`Type        : TXT`);
    console.log(`Value       : ${key.txtValue}`);
    console.log(`-----------------------------------------------------------------\n`);
    console.log(`Recommended SPF Record:`);
    console.log(`Host / Name : ${domain}`);
    console.log(`Type        : TXT`);
    console.log(`Value       : v=spf1 a mx ~all\n`);
    return;
  }

  if (cmd === 'send') {
    const DirectMtaSender = require('./src/direct-sender');
    const dkimManager = require('./src/dkim-manager');
    const to = args.to;
    const from = args.from;
    const subject = args.subject || 'Direct MTA Test Email';
    const text = args.body || args.text || 'This email was delivered directly via Node.js MTA on port 25 without any SMTP relay.';
    const html = args.html;
    const heloHost = args.helo;

    if (!to || !from) {
      console.error('Error: Both --to and --from are required.');
      console.error('Example: node cli.js send --to recipient@example.com --from me@mydomain.com');
      process.exit(1);
    }

    console.log(`\n======================================================`);
    console.log(`DIRECT MTA EMAIL TRANSMISSION`);
    console.log(`From   : ${from}`);
    console.log(`To     : ${to}`);
    console.log(`Subject: ${subject}`);
    console.log(`======================================================\n`);

    const sender = new DirectMtaSender({ heloHost });

    // Check DKIM
    const parsed = DirectMtaSender.parseEmail(from);
    let dkim = null;
    if (parsed.domain) {
      const stored = dkimManager.getKey(parsed.domain);
      if (stored) {
        dkim = {
          domainName: stored.domain,
          keySelector: stored.selector,
          privateKey: stored.privateKey
        };
        console.log(`\x1b[36m[DKIM]\x1b[0m Signing with selector "${stored.selector}"`);
      }
    }

    try {
      const result = await sender.sendMail({
        from,
        to,
        subject,
        text,
        html,
        dkim
      }, (entry) => {
        const time = entry.timestamp.split('T')[1].split('.')[0];
        let color = '\x1b[0m';
        if (entry.level === 'success') color = '\x1b[32m';
        if (entry.level === 'warn') color = '\x1b[33m';
        if (entry.level === 'error') color = '\x1b[31m';
        if (entry.level === 'outbound') color = '\x1b[34m';
        if (entry.level === 'inbound') color = '\x1b[35m';

        console.log(`[${time}] ${color}${entry.message}\x1b[0m`);
      });

      console.log(`\n======================================================`);
      if (result.success) {
        console.log(`\x1b[32m✔ DELIVERY COMPLETED SUCCESSFULLY!\x1b[0m`);
      } else {
        console.log(`\x1b[31m✖ DELIVERY FAILED.\x1b[0m`);
      }
      console.log(`======================================================\n`);
    } catch (err) {
      console.error(`\x1b[31mFatal Error: ${err.message}\x1b[0m`);
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
