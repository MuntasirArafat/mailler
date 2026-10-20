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
                  --subject "<subj>" --body "<text>" [--html "<html>"]

${colors.bold}SYSTEM & DIAGNOSTICS:${colors.reset}
  mailsource status                Check server health, role, and uptime

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

      console.log(`${colors.cyan}▶ Delivering email from ${colors.bold}${formattedFrom}${colors.reset} to ${colors.bold}${to}${colors.reset} via Direct MTA...`);
      
      const payload = { from: formattedFrom, name, to, subject, text: body, html: html || `<p>${body}</p>` };
      const res = await apiRequest('POST', '/send', payload);

      if (res.status === 200 || res.status === 202) {
        if (res.data.mode === 'queued') {
          console.log(`\n${colors.green}${colors.bold}✔ SUCCESS! Email enqueued into MongoDB Job Queue.${colors.reset}`);
          console.log(`  • Job ID       : ${colors.cyan}${res.data.jobId}${colors.reset}`);
          console.log(`  • Status       : ${colors.yellow}${res.data.status.toUpperCase()}${colors.reset}`);
          console.log(`  • Recipient    : ${colors.bold}${res.data.recipient}${colors.reset}`);
          console.log(`\n${colors.dim}Track worker delivery with: mailsource queue${colors.reset}`);
        } else {
          console.log(`\n${colors.green}${colors.bold}✔ SUCCESS! Email delivered directly to destination MX.${colors.reset}`);
          if (res.data.messageId) {
            console.log(`  • Message ID   : ${colors.cyan}${res.data.messageId}${colors.reset}`);
          }
          if (res.data.host) {
            console.log(`  • Destination  : ${colors.yellow}${res.data.host}${colors.reset}`);
          }
          if (res.data.response) {
            console.log(`  • MX Response  : ${colors.green}${res.data.response}${colors.reset}`);
          }
          if (res.data.durationMs) {
            console.log(`  • Delivery Time: ${colors.dim}${res.data.durationMs}ms${colors.reset}`);
          }
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
        console.log(`\n${colors.cyan}${colors.bold}🚀 Production Mail Server Status:${colors.reset}`);
        console.log(`  • Server State : ${colors.green}${colors.bold}● ${d.status.toUpperCase()}${colors.reset}`);
        console.log(`  • Database     : ${d.database === 'connected' ? colors.green + '✔ MongoDB (CONNECTED)' : colors.red + '✖ MongoDB (OFFLINE)'}${colors.reset}`);
        console.log(`  • Role         : ${colors.cyan}${d.role || 'production-mta-worker'}${colors.reset}`);
        console.log(`  • HELO Host    : ${colors.yellow}${d.heloHost || 'default'}${colors.reset}`);
        console.log(`  • Uptime       : ${(d.uptime / 60).toFixed(1)} minutes`);
        console.log(`  • Memory RSS   : ${(d.memory.rss / (1024 * 1024)).toFixed(1)} MB`);
        if (d.queue) {
          console.log(`  • Queue Stats  : ${colors.yellow}Queued: ${d.queue.queued}${colors.reset} | ${colors.cyan}Processing: ${d.queue.processing}${colors.reset} | ${colors.green}Completed: ${d.queue.completed}${colors.reset} | ${colors.red}Failed: ${d.queue.failed}${colors.reset}`);
        }
      } else {
        console.error(`${colors.red}✖ Error: ${JSON.stringify(res.data)}${colors.reset}`);
      }
      return;
    }

    // 3. INBOX LIST COMMAND
    if (command === 'inbox') {
      const res = await apiRequest('GET', '/inbox?limit=20');
      if (res.status === 200) {
        const list = res.data.emails || (Array.isArray(res.data) ? res.data : []);
        console.log(`\n${colors.cyan}${colors.bold}📥 Received Inbound Emails (${list.length}):${colors.reset}\n`);
        if (list.length === 0) {
          console.log(`  ${colors.dim}(No received emails in MongoDB yet)${colors.reset}`);
          return;
        }

        console.log(`${colors.bold}${'ID'.padEnd(16)} ${'FROM'.padEnd(28)} ${'SUBJECT'.padEnd(30)} ${'RECEIVED'}${colors.reset}`);
        console.log('-'.repeat(90));
        for (const item of list) {
          const date = new Date(item.received_at).toLocaleString();
          const from = (item.from_email || '').slice(0, 26).padEnd(28);
          const subj = (item.subject || '(no subject)').slice(0, 28).padEnd(30);
          console.log(`${String(item.id).slice(-14).padEnd(16)} ${from} ${subj} ${colors.dim}${date}${colors.reset}`);
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
          const spfPassed = v.checks?.spf?.passed ?? v.spf?.verified ?? v.spf?.valid ?? false;
          const dkimPassed = v.checks?.dkim?.passed ?? v.dkim?.verified ?? v.dkim?.valid ?? false;
          const dmarcPassed = v.checks?.dmarc?.passed ?? v.dmarc?.verified ?? v.dmarc?.valid ?? false;
          const mxPassed = v.checks?.mx?.passed ?? v.mx?.verified ?? v.mx?.valid ?? false;

          console.log(`\n${colors.bold}DNS Verification Results for ${dom}:${colors.reset}`);
          console.log(`  • SPF Record   : ${spfPassed ? colors.green + '✔ PASS' : colors.red + '✖ MISSING'} ${colors.reset}`);
          if (v.checks?.spf?.record) console.log(`    ${colors.dim}${v.checks.spf.record}${colors.reset}`);
          else if (v.checks?.spf?.advice) console.log(`    ${colors.yellow}👉 ${v.checks.spf.advice}${colors.reset}`);

          console.log(`  • DKIM Record  : ${dkimPassed ? colors.green + '✔ PASS' : colors.red + '✖ MISSING'} ${colors.reset}`);
          if (v.checks?.dkim?.record) console.log(`    ${colors.dim}${v.checks.dkim.record}${colors.reset}`);
          else if (v.checks?.dkim?.advice) console.log(`    ${colors.yellow}👉 ${v.checks.dkim.advice}${colors.reset}`);

          console.log(`  • DMARC Record : ${dmarcPassed ? colors.green + '✔ PASS' : colors.red + '✖ MISSING'} ${colors.reset}`);
          if (v.checks?.dmarc?.record) console.log(`    ${colors.dim}${v.checks.dmarc.record}${colors.reset}`);
          else if (v.checks?.dmarc?.advice) console.log(`    ${colors.yellow}👉 ${v.checks.dmarc.advice}${colors.reset}`);

          console.log(`  • MX Record    : ${mxPassed ? colors.green + '✔ PASS' : colors.red + '✖ MISSING'} ${colors.reset}`);
          if (v.checks?.mx?.records?.length) console.log(`    ${colors.dim}${v.checks.mx.records.join(', ')}${colors.reset}`);
          else if (v.checks?.mx?.advice) console.log(`    ${colors.yellow}👉 ${v.checks.mx.advice}${colors.reset}`);

          if (v.deliverabilityScore !== undefined || v.score !== undefined) {
            console.log(`  • Deliverability Score: ${colors.bold}${v.deliverabilityScore ?? v.score}/100${colors.reset}`);
          }
          console.log(`\nOverall Verified: ${v.verified ? colors.green + colors.bold + 'YES (Ready to send)' : colors.yellow + 'NO (Records still propagating)'}${colors.reset}`);
        } else {
          console.error(`${colors.red}✖ Error: ${res.data?.error || JSON.stringify(res.data)}${colors.reset}`);
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
        console.error(`${colors.red}✖ Error (${listRes.status}): ${listRes.data?.error || JSON.stringify(listRes.data || listRes.raw)}${colors.reset}`);
      }
      return;
    }

    // 6. QUEUE COMMAND
    if (command === 'queue' || command === 'jobs') {
      const statsRes = await apiRequest('GET', '/jobs/stats');
      const jobsRes = await apiRequest('GET', '/jobs?limit=15');

      if (statsRes.status === 200 && jobsRes.status === 200) {
        const stats = statsRes.data;
        const jobs = jobsRes.data.jobs || [];

        console.log(`\n${colors.cyan}${colors.bold}📬 Outbound Mail Job Queue (MongoDB):${colors.reset}`);
        console.log(`  • Status Summary : ${colors.yellow}Queued: ${stats.queued}${colors.reset} | ${colors.cyan}Processing: ${stats.processing}${colors.reset} | ${colors.green}Completed: ${stats.completed}${colors.reset} | ${colors.red}Failed: ${stats.failed}${colors.reset}`);
        console.log(`  • Concurrency    : ${stats.concurrency} worker slots (${stats.activeWorkers} currently active)\n`);

        if (jobs.length === 0) {
          console.log(`  ${colors.dim}(No jobs in queue yet. Enqueue with: mailsource send ...)${colors.reset}\n`);
          return;
        }

        console.log(`${colors.bold}${'JOB ID'.padEnd(20)} ${'RECIPIENT'.padEnd(26)} ${'STATUS'.padEnd(14)} ${'ATTEMPTS'.padEnd(10)} ${'DETAILS'}${colors.reset}`);
        console.log('-'.repeat(95));
        for (const j of jobs) {
          let statusStr = j.status.toUpperCase();
          if (j.status === 'completed') statusStr = colors.green + statusStr + colors.reset;
          else if (j.status === 'failed') statusStr = colors.red + statusStr + colors.reset;
          else if (j.status === 'processing') statusStr = colors.cyan + statusStr + colors.reset;
          else statusStr = colors.yellow + statusStr + colors.reset;

          const recipient = (j.recipient || '').slice(0, 24).padEnd(26);
          const attempts = `${j.attempts}/${j.maxRetries}`.padEnd(10);
          const details = j.lastError ? colors.red + j.lastError.slice(0, 30) + colors.reset : (j.host ? colors.dim + j.host + colors.reset : '');

          console.log(`${j.jobId.slice(0, 18).padEnd(20)} ${recipient} ${statusStr.padEnd(23)} ${attempts} ${details}`);
        }
        console.log(`\n${colors.dim}To retry failed jobs: mailsource retry [jobId]${colors.reset}\n`);
      } else {
        console.error(`${colors.red}✖ Failed to fetch queue status: ${JSON.stringify(jobsRes.data || statsRes.data)}${colors.reset}`);
      }
      return;
    }

    // 7. RETRY FAILED JOBS
    if (command === 'retry' || command === 'retry-failed') {
      const jobId = args[1];
      if (jobId) {
        console.log(`${colors.cyan}▶ Re-queuing failed job ${colors.bold}${jobId}${colors.reset}...`);
        const res = await apiRequest('POST', `/jobs/${jobId}/retry`);
        if (res.status === 200) {
          console.log(`\n${colors.green}${colors.bold}✔ Job ${jobId} has been successfully re-queued for delivery.${colors.reset}\n`);
        } else {
          console.error(`\n${colors.red}✖ Error: ${res.data.error || JSON.stringify(res.data)}${colors.reset}\n`);
        }
      } else {
        console.log(`${colors.cyan}▶ Re-queuing all failed jobs...${colors.reset}`);
        const res = await apiRequest('POST', '/jobs/retry-all');
        if (res.status === 200) {
          console.log(`\n${colors.green}${colors.bold}✔ Successfully re-queued ${res.data.reQueued} failed job(s) for delivery.${colors.reset}\n`);
        } else {
          console.error(`\n${colors.red}✖ Error: ${res.data.error || JSON.stringify(res.data)}${colors.reset}\n`);
        }
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
        const score = a.deliverabilityScore ?? a.score ?? 0;
        const spfValid = a.checks?.spf?.passed ?? a.spf?.valid ?? a.spf?.verified ?? false;
        const dkimValid = a.checks?.dkim?.passed ?? a.dkim?.valid ?? a.dkim?.verified ?? false;
        const dmarcValid = a.checks?.dmarc?.passed ?? a.dmarc?.valid ?? a.dmarc?.verified ?? false;
        const ptrValid = a.checks?.ptr?.passed ?? a.ptr?.valid ?? a.ptr?.verified ?? false;
        const port25Open = a.checks?.port25?.passed ?? a.port25Outbound?.open ?? false;

        console.log(`\n${colors.bold}Deliverability Score: ${colors.cyan}${score}/100${colors.reset}`);
        console.log(`  • SPF  : ${spfValid ? colors.green + '✔ VALID' : colors.red + '✖ INVALID'}${colors.reset}`);
        console.log(`  • DKIM : ${dkimValid ? colors.green + '✔ VALID' : colors.red + '✖ INVALID'}${colors.reset}`);
        console.log(`  • DMARC: ${dmarcValid ? colors.green + '✔ VALID' : colors.red + '✖ INVALID'}${colors.reset}`);
        console.log(`  • PTR  : ${ptrValid ? colors.green + '✔ VALID' : colors.yellow + '▲ NO PTR / NOT MATCHED'}${colors.reset}`);
        console.log(`  • Port 25 Outbound : ${port25Open ? colors.green + '✔ OPEN' : colors.red + '✖ BLOCKED'}${colors.reset}`);
      } else {
        console.error(`${colors.red}✖ Error: ${res.data?.error || JSON.stringify(res.data)}${colors.reset}`);
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
