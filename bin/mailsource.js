#!/usr/bin/env node

/**
 * Direct Mail Server CLI Tool
 * Accessible as `mailsource` or `mailsouce` from any terminal on the VPS.
 * 
 * Usage Examples:
 *   mailsource send --to user@gmail.com --from me@domain.com --subject "Hello" --body "My text message"
 *   mailsource status
 *   mailsource inbox
 *   mailsource read 1
 *   mailsource domains
 *   mailsource domains add example.com
 *   mailsource domains verify example.com
 *   mailsource queue
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

// Colors for terminal output
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m'
};

function printHelp() {
  console.log(`
${colors.cyan}${colors.bold}📬 Mail Server CLI Tool (mailsource)${colors.reset}

${colors.bold}USAGE:${colors.reset}
  mailsource <command> [options]

${colors.bold}SEND COMMANDS:${colors.reset}
  mailsource send --to <email> --from <email> [--name "<name>"]
                  --subject "<subj>" --body "<text>" [--html "<html>"] [--sync]

${colors.bold}INBOX & READING COMMANDS:${colors.reset}
  mailsource inbox                 List received inbound emails
  mailsource read <id>             View full content & attachments of an email
  mailsource delete-mail <id>      Delete an inbound email

${colors.bold}SYSTEM & QUEUE COMMANDS:${colors.reset}
  mailsource status                Check server health, uptime, and queue stats
  mailsource queue                 List recent outbound delivery jobs
  mailsource retry                 Retry all failed delivery jobs

${colors.bold}DOMAIN & ANTI-SPAM COMMANDS:${colors.reset}
  mailsource domains               List all hosted sending/receiving domains
  mailsource domains add <domain>  Add domain & generate 2048-bit DKIM + DNS records
  mailsource domains verify <dom>  Test live SPF, DKIM, DMARC, and MX DNS propagation
  mailsource domains remove <dom>  Remove a domain and delete its DKIM keys
  mailsource audit <domain>        Run pre-flight deliverability audit (0-100 score)

${colors.bold}SUPPRESSION COMMANDS:${colors.reset}
  mailsource suppression           List suppressed emails (bounces/unsubscribes)
  mailsource suppress <email>      Manually suppress an email
  mailsource unsuppress <email>    Remove an email from suppression
`);
}

// Locate config file
function loadConfig() {
  const possiblePaths = [
    path.join(__dirname, '..', 'config', 'server.json'),
    '/opt/mailserver/config/server.json',
    path.join(process.cwd(), 'config', 'server.json')
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
      } catch (e) {}
    }
  }

  return {
    port: parseInt(process.env.PORT || '3000', 10),
    apiPassword: process.env.API_PASSWORD || ''
  };
}

const config = loadConfig();
const PORT = config.port || 3000;
const PASSWORD = config.apiPassword || '';

// HTTP API Request helper
function apiRequest(method, endpoint, body = null) {
  return new Promise((resolve, reject) => {
    const postData = body ? JSON.stringify(body) : null;
    const options = {
      hostname: '127.0.0.1',
      port: PORT,
      path: '/api' + endpoint,
      method: method,
      headers: {
        'x-api-key': PASSWORD,
        'Content-Type': 'application/json'
      }
    };

    if (postData) {
      options.headers['Content-Length'] = Buffer.byteLength(postData);
    }

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, data: parsed });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });

    req.on('error', (err) => {
      reject(new Error(`Failed to connect to Mail Server on 127.0.0.1:${PORT}. Is the server running? (${err.message})`));
    });

    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

// Parse CLI named flags (--to value, -t value, etc.)
function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--') || arg.startsWith('-')) {
      const key = arg.replace(/^--?/, '');
      const next = args[i + 1];
      if (next && !next.startsWith('-')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    }
  }
  return flags;
}

// Main execution dispatcher
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  try {
    // 1. SEND COMMAND
    if (command === 'send') {
      const flags = parseFlags(args.slice(1));
      const to = flags.to || flags.t;
      const from = flags.from || flags.f;
      const name = flags.name || flags.n || flags['from-name'] || flags.sender || null;
      const subject = flags.subject || flags.s;
      const body = flags.body || flags.text || flags.b || '';
      const html = flags.html || flags.h || null;
      const sync = flags.sync || false;

      if (!to || !from || !subject) {
        console.error(`${colors.red}✖ Error: Missing required arguments.${colors.reset}`);
        console.log(`Usage: mailsource send --to <email> --from <email> [--name "<name>"] --subject "<subj>" --body "<text>"`);
        process.exit(1);
      }

      let formattedFrom = from.trim();
      if (name && !formattedFrom.includes('<')) {
        formattedFrom = `"${name}" <${formattedFrom}>`;
      }

      console.log(`${colors.cyan}▶ Sending email from ${colors.bold}${formattedFrom}${colors.reset} to ${colors.bold}${to}${colors.reset}...`);
      
      const payload = { from: formattedFrom, name, to, subject, text: body, html: html || `<p>${body}</p>`, sync: !!sync };
      const res = await apiRequest('POST', '/send', payload);

      if (res.status === 200 || res.status === 202) {
        console.log(`\n${colors.green}${colors.bold}✔ SUCCESS! Email accepted by mail engine.${colors.reset}`);
        if (res.data.jobId) {
          console.log(`  • Job ID : ${colors.cyan}${res.data.jobId}${colors.reset}`);
          console.log(`  • Status : ${colors.yellow}Enqueued for direct MX delivery${colors.reset}`);
        } else if (res.data.response) {
          console.log(`  • Direct MX Response: ${colors.green}${res.data.response}${colors.reset}`);
        }
      } else {
        console.error(`\n${colors.red}✖ Failed (${res.status}): ${res.data.error || JSON.stringify(res.data)}${colors.reset}`);
        process.exit(1);
      }
      return;
    }

    // 2. STATUS / HEALTH COMMAND
    if (command === 'status' || command === 'health') {
      const res = await apiRequest('GET', '/health');
      if (res.status === 200) {
        const d = res.data;
        console.log(`\n${colors.cyan}${colors.bold}🚀 Mail Server Status & Performance:${colors.reset}`);
        console.log(`  • Server State : ${colors.green}${colors.bold}● ${d.status.toUpperCase()}${colors.reset}`);
        console.log(`  • Uptime       : ${(d.uptime / 60).toFixed(1)} minutes`);
        console.log(`  • Memory RSS   : ${(d.memory.rss / (1024 * 1024)).toFixed(1)} MB`);
        console.log(`\n${colors.bold}📊 Outbound Queue:${colors.reset}`);
        console.log(`  • Pending      : ${colors.yellow}${d.queue.pending || 0}${colors.reset}`);
        console.log(`  • In Progress  : ${colors.cyan}${d.queue.processing || d.queue.delivering || 0}${colors.reset}`);
        if (d.queue.retrying) {
          console.log(`  • Retrying     : ${colors.yellow}${d.queue.retrying}${colors.reset}`);
        }
        console.log(`  • Completed    : ${colors.green}${d.queue.completed || 0}${colors.reset}`);
        console.log(`  • Failed       : ${colors.red}${d.queue.failed || 0}${colors.reset}`);
      } else {
        console.error(`${colors.red}✖ Error: ${JSON.stringify(res.data)}${colors.reset}`);
      }
      return;
    }

    // 3. INBOX LIST COMMAND
    if (command === 'inbox') {
      const res = await apiRequest('GET', '/inbox?limit=20');
      if (res.status === 200) {
        const list = res.data;
        console.log(`\n${colors.cyan}${colors.bold}📥 Received Inbound Emails (${list.length}):${colors.reset}\n`);
        if (list.length === 0) {
          console.log(`  ${colors.dim}(No received emails yet)${colors.reset}`);
          return;
        }

        console.log(`${colors.bold}${'ID'.padEnd(6)} ${'FROM'.padEnd(30)} ${'SUBJECT'.padEnd(35)} ${'RECEIVED'}${colors.reset}`);
        console.log('-'.repeat(85));
        for (const item of list) {
          const date = new Date(item.received_at).toLocaleString();
          const from = (item.from_email || '').slice(0, 28).padEnd(30);
          const subj = (item.subject || '(no subject)').slice(0, 33).padEnd(35);
          console.log(`${String(item.id).padEnd(6)} ${from} ${subj} ${colors.dim}${date}${colors.reset}`);
        }
        console.log(`\n${colors.dim}To read an email, run: mailsource read <ID>${colors.reset}`);
      } else {
        console.error(`${colors.red}✖ Error: ${JSON.stringify(res.data)}${colors.reset}`);
      }
      return;
    }

    // 4. READ INBOUND EMAIL
    if (command === 'read') {
      const id = args[1];
      if (!id) {
        console.error(`${colors.red}✖ Error: Please specify an email ID. Example: mailsource read 1${colors.reset}`);
        process.exit(1);
      }
      const res = await apiRequest('GET', `/inbox/${id}`);
      if (res.status === 200) {
        const m = res.data;
        console.log(`\n${colors.cyan}${colors.bold}✉️  EMAIL #${m.id}${colors.reset}`);
        console.log(`  • From    : ${colors.bold}${m.from_name ? m.from_name + ' ' : ''}<${m.from_email}>${colors.reset}`);
        console.log(`  • To      : ${m.to_email}`);
        console.log(`  • Subject : ${colors.bold}${m.subject}${colors.reset}`);
        console.log(`  • Date    : ${new Date(m.received_at).toLocaleString()}`);
        console.log('\n' + '='.repeat(60));
        console.log(m.text_body || m.html_body || `${colors.dim}(No text body content)${colors.reset}`);
        console.log('='.repeat(60) + '\n');
      } else {
        console.error(`${colors.red}✖ Email not found: ${JSON.stringify(res.data)}${colors.reset}`);
      }
      return;
    }

    // 5. DOMAINS MANAGEMENT
    if (command === 'domains' || command === 'domain') {
      const sub = args[1];

      if (sub === 'add') {
        const dom = args[2];
        if (!dom) {
          console.error(`${colors.red}✖ Error: Please specify a domain. Example: mailsource domains add example.com${colors.reset}`);
          process.exit(1);
        }
        console.log(`${colors.cyan}▶ Adding domain ${colors.bold}${dom}${colors.reset} and generating 2048-bit DKIM key...`);
        const res = await apiRequest('POST', '/domains', { domain: dom });
        if (res.status === 200 || res.status === 201) {
          console.log(`\n${colors.green}${colors.bold}✔ Domain added successfully!${colors.reset}`);
          console.log(`\n${colors.bold}📋 Add the following DNS Records to your domain DNS provider:${colors.reset}\n`);
          const records = res.data.dnsRecords || [];
          for (const r of records) {
            console.log(`  • ${colors.bold}${r.type} Record${colors.reset} [${r.description || ''}]`);
            console.log(`    Host  : ${colors.cyan}${r.name}${colors.reset}`);
            console.log(`    Value : ${colors.yellow}${r.value}${colors.reset}`);
            if (r.priority) console.log(`    Priority: ${r.priority}`);
            console.log('');
          }
        } else {
          console.error(`${colors.red}✖ Error: ${JSON.stringify(res.data)}${colors.reset}`);
        }
        return;
      }

      if (sub === 'verify') {
        const dom = args[2];
        if (!dom) {
          console.error(`${colors.red}✖ Error: Please specify a domain. Example: mailsource domains verify example.com${colors.reset}`);
          process.exit(1);
        }
        console.log(`${colors.cyan}▶ Verifying live DNS propagation for ${colors.bold}${dom}${colors.reset}...`);
        const res = await apiRequest('POST', `/domains/${dom}/verify`);
        if (res.status === 200) {
          const v = res.data;
          console.log(`\n${colors.bold}DNS Verification Results for ${dom}:${colors.reset}`);
          console.log(`  • SPF Record   : ${v.spf.verified ? colors.green + '✔ PASS' : colors.red + '✖ MISSING'} ${colors.reset}`);
          console.log(`  • DKIM Record  : ${v.dkim.verified ? colors.green + '✔ PASS' : colors.red + '✖ MISSING'} ${colors.reset}`);
          console.log(`  • DMARC Record : ${v.dmarc.verified ? colors.green + '✔ PASS' : colors.red + '✖ MISSING'} ${colors.reset}`);
          console.log(`  • MX Record    : ${v.mx.verified ? colors.green + '✔ PASS' : colors.red + '✖ MISSING'} ${colors.reset}`);
          console.log(`\nOverall Verified: ${v.verified ? colors.green + colors.bold + 'YES (Ready to send)' : colors.yellow + 'NO (Records still propagating)'}${colors.reset}`);
        }
        return;
      }

      if (sub === 'remove' || sub === 'delete' || sub === 'rm') {
        const dom = args[2];
        if (!dom) {
          console.error(`${colors.red}✖ Error: Please specify a domain to remove. Example: mailsource domains remove example.com${colors.reset}`);
          process.exit(1);
        }
        console.log(`${colors.cyan}▶ Removing domain ${colors.bold}${dom}${colors.reset}...`);
        const delRes = await apiRequest('DELETE', `/domains/${dom}`);
        if (delRes.status === 200) {
          console.log(`\n${colors.green}${colors.bold}✔ Domain ${dom} and its DKIM keys have been successfully deleted.${colors.reset}\n`);
        } else {
          console.error(`${colors.red}✖ Error: ${JSON.stringify(delRes.data)}${colors.reset}`);
        }
        return;
      }

      const listRes = await apiRequest('GET', '/domains');
      if (listRes.status === 200) {
        console.log(`\n${colors.cyan}${colors.bold}🌐 Configured Domains (${listRes.data.length}):${colors.reset}\n`);
        if (listRes.data.length === 0) {
          console.log(`  ${colors.dim}(No domains added yet. Add one with: mailsource domains add yourdomain.com)${colors.reset}`);
          return;
        }
        for (const d of listRes.data) {
          const verified = d.is_verified ? colors.green + '✔ VERIFIED' : colors.yellow + '⏳ PENDING DNS';
          console.log(`  • ${colors.bold}${d.domain}${colors.reset} [DKIM selector: ${d.selector}] - ${verified}${colors.reset}`);
        }
      } else {
        console.error(`${colors.red}✖ Error: ${JSON.stringify(res.data)}${colors.reset}`);
      }
      return;
    }

    // 6. QUEUE COMMAND
    if (command === 'queue' || command === 'jobs') {
      const res = await apiRequest('GET', '/jobs?limit=15');
      if (res.status === 200) {
        console.log(`\n${colors.cyan}${colors.bold}📦 Recent Outbound Delivery Jobs:${colors.reset}\n`);
        if (res.data.length === 0) {
          console.log(`  ${colors.dim}(Queue is empty)${colors.reset}`);
          return;
        }
        for (const j of res.data) {
          let statusColor = colors.yellow;
          if (j.status === 'completed') statusColor = colors.green;
          if (j.status === 'failed') statusColor = colors.red;
          if (j.status === 'retrying') statusColor = colors.yellow;
          console.log(`  [${statusColor}${j.status.toUpperCase()}${colors.reset}] ${j.to_email} (from: ${j.from_email}) - Attempts: ${j.attempts}`);
          if (j.delivery_response) {
            console.log(`     └─ Response: ${colors.green}${j.delivery_response}${colors.reset}`);
          }
          if (j.last_error) {
            console.log(`     └─ Error: ${colors.red}${j.last_error}${colors.reset}`);
          }
        }
      } else {
        console.error(`${colors.red}✖ Error: ${JSON.stringify(res.data)}${colors.reset}`);
      }
      return;
    }

    // 7. RETRY FAILED JOBS
    if (command === 'retry' || command === 'retry-failed') {
      const res = await apiRequest('POST', '/jobs/retry-failed');
      if (res.status === 200) {
        console.log(`${colors.green}✔ Retried ${res.data.retriedCount} failed jobs.${colors.reset}`);
      } else {
        console.error(`${colors.red}✖ Error: ${JSON.stringify(res.data)}${colors.reset}`);
      }
      return;
    }

    // 8. AUDIT PRE-FLIGHT
    if (command === 'audit') {
      const dom = args[1];
      if (!dom) {
        console.error(`${colors.red}✖ Error: Please specify a domain. Example: mailsource audit example.com${colors.reset}`);
        process.exit(1);
      }
      console.log(`${colors.cyan}▶ Running deliverability audit on ${colors.bold}${dom}${colors.reset}...`);
      const res = await apiRequest('GET', `/deliverability/audit/${dom}`);
      if (res.status === 200) {
        const a = res.data;
        console.log(`\n${colors.bold}Deliverability Score: ${colors.cyan}${a.score}/100${colors.reset}`);
        console.log(`  • SPF  : ${a.spf.valid ? colors.green + '✔ VALID' : colors.red + '✖ INVALID'}${colors.reset}`);
        console.log(`  • DKIM : ${a.dkim.valid ? colors.green + '✔ VALID' : colors.red + '✖ INVALID'}${colors.reset}`);
        console.log(`  • DMARC: ${a.dmarc.valid ? colors.green + '✔ VALID' : colors.red + '✖ INVALID'}${colors.reset}`);
        console.log(`  • PTR  : ${a.ptr.valid ? colors.green + '✔ VALID' : colors.yellow + '▲ NO PTR / NOT MATCHED'}${colors.reset}`);
        console.log(`  • Port 25 Outbound : ${a.port25Outbound.open ? colors.green + '✔ OPEN' : colors.red + '✖ BLOCKED'}${colors.reset}`);
      } else {
        console.error(`${colors.red}✖ Error: ${JSON.stringify(res.data)}${colors.reset}`);
      }
      return;
    }

    console.log(`Unknown command "${command}". Run ${colors.bold}mailsource help${colors.reset} for available commands.`);
  } catch (err) {
    console.error(`\n${colors.red}${err.message}${colors.reset}\n`);
    process.exit(1);
  }
}

main();
