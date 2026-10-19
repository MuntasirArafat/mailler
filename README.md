# High-Throughput Direct Node.js Mail Server & MTA Engine

A production-grade, autonomous **Direct Mail Server & MTA Engine** in Node.js built to **send and receive emails at scale (millions of emails)** directly to and from recipient mail exchangers (MX) on Port 25.

**Zero third-party SMTP relays** (No SendGrid, Mailgun, or AWS SES) and **zero external email APIs**. 100% self-hosted, headless REST API, and built-in anti-spam deliverability protection.

---

## ⚡ Key Highlights

- **Headless REST API**: Clean microservice interface for automated sending and receiving. Root (`/`) serves a minimal status indicator page.
- **Direct Port 25 Delivery**: Connects straight to destination MX (Google, Microsoft, Yahoo, etc.) using raw TCP sockets with opportunistic STARTTLS and connection reuse.
- **Millions-Ready Job Engine**: High-performance SQLite in WAL mode supporting 20,000+ atomic inserts/sec, concurrent worker pool, per-domain rate limiting, and exponential backoff retry.
- **Two-Way Email (Sending + Receiving)**: Built-in Inbound SMTP receiver on port 25/2525 that parses RFC 5322 MIME messages, HTML, text, and attachments into a searchable inbox API.
- **Anti-Spam & Deliverability Shield**:
  - Automatic 2048-bit RSA DKIM signing (`relaxed/relaxed`).
  - Strict RFC 5321 Return-Path SPF alignment.
  - RFC 8058 One-Click List-Unsubscribe headers (`List-Unsubscribe` & `List-Unsubscribe-Post`).
  - Automated suppression list capturing permanent bounces (550 "User unknown") and unsubscribes.
  - Unrestricted daily sending volume (100% controlled and scheduled by your software).
  - Pre-flight DNS deliverability auditor (SPF, DKIM, DMARC, PTR, Port 25 reachability with 0–100 score).
- **Multi-Domain Hosting**: Host multiple sending and receiving domains with automatic DKIM key generation and live DNS verification.
- **Password Authentication**: Every API request is strictly secured by password authentication.

---

## 🚀 VPS One-Command Automated Setup

The included installer [`deploy.sh`](file:///Users/muntasirarafat/Documents/mailserver/deploy.sh) asks for your desired **API Port** and **API Password**, then fully automates everything: installs Node 22 LTS, sets up firewall rules, writes configuration, and creates a persistent background `systemd` service (`mailserver.service`) that automatically starts on server reboots.

### Step 1: Run Installer on VPS (Ubuntu / Debian / Rocky / CentOS)
```bash
sudo bash deploy.sh
```

### Step 2: Interactive Prompt
When you run the script, it asks:
```text
⚙️  Configure Your Mail Server Credentials:
Select API Service Port [default: 3000]: 8080
Enter Secret API Password [press Enter to auto-generate]: mySecretPassword123

✔ Configuration chosen:
  • Service Port : 8080
  • API Password : mySecretPassword123

Starting automated system setup...
```
The installer opens firewall ports (25, 2525, 8080), installs dependencies, enables the systemd service, and verifies server health.

*(Optional: Pass flags for non-interactive / CI deployments: `sudo bash deploy.sh -p 8080 -k mySecretPassword123`)*

### Managing the Background Service:
```bash
# Check service status
sudo systemctl status mailserver

# View live delivery and inbound logs
sudo journalctl -u mailserver -f

# Restart service
sudo systemctl restart mailserver

# Stop service
sudo systemctl stop mailserver
```

---

## ⚡ Global CLI Tool (`mailsource` / `mailsouce`)

After installing on your VPS, you can manage the mail server directly from any terminal using `mailsource` (or `mailsouce`):

### 1. Send Email via CLI:
```bash
mailsource send --to client@gmail.com --from me@yourdomain.com --subject "Direct Test" --body "Hello from terminal!"
```

### 2. View Server Status & Queue:
```bash
mailsource status
```

### 3. Read Inbound Received Emails:
```bash
# List all received emails
mailsource inbox

# Read email by ID
mailsource read 1
```

### 4. Manage Hosted Domains & DNS:
```bash
# List domains
mailsource domains

# Add new domain (generates 2048-bit DKIM & DNS instructions)
mailsource domains add mybrand.com

# Verify live DNS records
mailsource domains verify mybrand.com
```

### 5. Inspect Queue & Retry Failed Jobs:
```bash
# View recent jobs
mailsource queue

# Retry failed deliveries
mailsource retry
```

---

## ⚙️ Manual Local / CLI Startup Options

You can also start the server directly using command-line arguments or environment variables:

```bash
# Using CLI flags (recommended)
node index.js --port 8080 --password mySecretPassword123

# Shorthand flags
node index.js -p 8080 -k mySecretPassword123

# Using environment variables
PORT=8080 API_PASSWORD=mySecretPassword123 npm start
```

Configuration is automatically saved to [`config/server.json`](file:///Users/muntasirarafat/Documents/mailserver/config/server.json) so your settings persist across restarts.

---

## 🔒 API Authentication

All `/api/*` endpoints require authentication. Unauthenticated requests receive HTTP **`401 Unauthorized`**.

Provide your password in any of these 3 ways:

| Authentication Method | Header / Parameter Format |
| :--- | :--- |
| **API Key Header (Recommended)** | `-H "x-api-key: <your_password>"` |
| **Bearer Token** | `-H "Authorization: Bearer <your_password>"` |
| **URL Query Parameter** | `?api_key=<your_password>` |

---

## 📖 Complete API Reference Documentation

### 1. System Health & Stats
#### `GET /api/health`
Returns system status, authentication status, uptime, memory, and queue snapshot.

**Request:**
```bash
curl -H "x-api-key: mySecretPassword123" http://localhost:8080/api/health
```

**Response (`200 OK`):**
```json
{
  "status": "healthy",
  "authRequired": true,
  "uptime": 342.12,
  "memory": {
    "rss": 45182976,
    "heapTotal": 24969216,
    "heapUsed": 18274912
  },
  "queue": {
    "pending": 0,
    "delivering": 0,
    "completed": 142,
    "failed": 0,
    "deferred": 0
  }
}
```

---

### 2. Send Single Email
#### `POST /api/send`
Sends an email directly to the destination MX. Supports asynchronous queueing (default) or synchronous delivery.

**Headers:**
`Content-Type: application/json`  
`x-api-key: <your_password>`

**Request Body Parameters:**
| Parameter | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `from` | string | **Yes** | Sender email (e.g. `"support@yourdomain.com"`). Return-Path & DKIM align with this domain. |
| `to` | string | **Yes** | Recipient email (e.g. `"client@gmail.com"`). |
| `subject` | string | **Yes** | Email subject line. |
| `text` | string | No | Plain text content. |
| `html` | string | No | HTML content. |
| `unsubscribeUrl` | string | No | URL for RFC 8058 One-Click Unsubscribe (required for Gmail/Yahoo bulk delivery). |
| `unsubscribeEmail` | string | No | Mailto address for unsubscribe (e.g. `"unsub@yourdomain.com"`). |
| `headers` | object | No | Custom email headers (e.g. `{"X-Campaign-ID": "camp_99"}`). |
| `sync` | boolean | No | `false` (default): Fast enqueue, returns job ID. `true`: Awaits live delivery to recipient MX. |

**Example (Async Mode - Default):**
```bash
curl -X POST http://localhost:8080/api/send \
  -H "x-api-key: mySecretPassword123" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "notifications@yourdomain.com",
    "to": "client@gmail.com",
    "subject": "Direct MX Delivery Test",
    "html": "<h1>Direct Delivery Succeeded</h1><p>Sent directly to MX without 3rd party relays.</p>",
    "unsubscribeUrl": "https://yourdomain.com/unsubscribe?user=client"
  }'
```
**Response (`202 Accepted`):**
```json
{
  "success": true,
  "queued": true,
  "jobId": "f7a30369-2ba1-40be-8451-b0db3717282b"
}
```

**Example (Sync Mode):**
```bash
curl -X POST http://localhost:8080/api/send \
  -H "x-api-key: mySecretPassword123" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "notifications@yourdomain.com",
    "to": "client@gmail.com",
    "subject": "Urgent Alert",
    "text": "Your code is 123456",
    "sync": true
  }'
```
**Response (`200 OK`):**
```json
{
  "success": true,
  "sync": true,
  "messageId": "<b94a0f44-d830-47b2-8c70-13f8cbe0efea@yourdomain.com>",
  "dkimSigned": true,
  "response": "250 2.0.0 OK 1792427620 s20si10237937pgv.489 - gsmtp"
}
```

---

### 3. Bulk Batch Ingestion (Millions of Emails)
#### `POST /api/jobs/batch`
Ingests an array of email objects in a single atomic SQLite transaction (capable of 20,000+ insertions/sec).

**Request Body:**
```json
{
  "emails": [
    {
      "from": "newsletter@yourdomain.com",
      "to": "user1@gmail.com",
      "subject": "Weekly Update",
      "html": "<p>Hello User 1</p>",
      "unsubscribeUrl": "https://yourdomain.com/unsub?id=1"
    },
    {
      "from": "newsletter@yourdomain.com",
      "to": "user2@yahoo.com",
      "subject": "Weekly Update",
      "html": "<p>Hello User 2</p>",
      "unsubscribeUrl": "https://yourdomain.com/unsub?id=2"
    }
  ]
}
```

**Curl Command:**
```bash
curl -X POST http://localhost:8080/api/jobs/batch \
  -H "x-api-key: mySecretPassword123" \
  -H "Content-Type: application/json" \
  -d '{"emails":[{"from":"team@brand.com","to":"user1@gmail.com","subject":"Hi 1","text":"Msg 1"},{"from":"team@brand.com","to":"user2@yahoo.com","subject":"Hi 2","text":"Msg 2"}]}'
```

**Response (`202 Accepted`):**
```json
{
  "success": true,
  "enqueued": 2,
  "jobs": [
    { "jobId": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d", "to": "user1@gmail.com" },
    { "jobId": "1b9c1d2e-4f5a-6b7c-8d9e-0f1a2b3c4d5e", "to": "user2@yahoo.com" }
  ]
}
```

---

### 4. Job Queue Monitoring & Control

#### `GET /api/jobs/stats`
Returns counts of jobs broken down by status.
```bash
curl -H "x-api-key: mySecretPassword123" http://localhost:8080/api/jobs/stats
```
**Response:**
```json
{
  "pending": 50,
  "delivering": 12,
  "completed": 12480,
  "failed": 2,
  "deferred": 15
}
```

#### `GET /api/jobs`
List recent outbound jobs with optional status filter and pagination.
- Query Parameters:
  - `status` (optional): `pending`, `delivering`, `completed`, `failed`, `deferred`
  - `limit` (default: 50, max: 500)
  - `offset` (default: 0)

```bash
curl -H "x-api-key: mySecretPassword123" "http://localhost:8080/api/jobs?status=completed&limit=2"
```

#### `GET /api/jobs/:id`
Inspect details and delivery logs for a specific job ID.
```bash
curl -H "x-api-key: mySecretPassword123" http://localhost:8080/api/jobs/f7a30369-2ba1-40be-8451-b0db3717282b
```
**Response:**
```json
{
  "id": "f7a30369-2ba1-40be-8451-b0db3717282b",
  "from_email": "notifications@yourdomain.com",
  "to_email": "client@gmail.com",
  "destination_domain": "gmail.com",
  "status": "completed",
  "attempts": 1,
  "last_response": "250 2.0.0 OK 1792427620 s20si10237937pgv.489 - gsmtp",
  "created_at": 1792427618000,
  "updated_at": 1792427620300
}
```

#### `POST /api/jobs/retry-failed`
Re-queues all failed jobs back to `pending` status with reset attempt counters.
```bash
curl -X POST -H "x-api-key: mySecretPassword123" http://localhost:8080/api/jobs/retry-failed
```

---

### 5. Inbound Mail Reader (Receive & Query Emails)

#### `GET /api/inbox`
List received emails captured by the inbound SMTP receiver.
- Query Parameters:
  - `limit` (default: 50, max: 200)
  - `offset` (default: 0)
  - `to` (filter by recipient address, e.g. `support@yourdomain.com`)
  - `from` (filter by sender address)
  - `query` (search subject and text content)

```bash
curl -H "x-api-key: mySecretPassword123" "http://localhost:8080/api/inbox?limit=10"
```
**Response:**
```json
[
  {
    "id": 1,
    "message_id": "<user-request-101@external.com>",
    "from_email": "client@external.com",
    "from_name": "Client Name",
    "to_email": "support@yourdomain.com",
    "subject": "Help with account setup",
    "raw_size": 1420,
    "received_at": 1792427620392
  }
]
```

#### `GET /api/inbox/:id`
Retrieve full email including headers, parsed HTML, plain text, and attachment metadata.
```bash
curl -H "x-api-key: mySecretPassword123" http://localhost:8080/api/inbox/1
```
**Response:**
```json
{
  "id": 1,
  "message_id": "<user-request-101@external.com>",
  "from_email": "client@external.com",
  "from_name": "Client Name",
  "to_email": "support@yourdomain.com",
  "subject": "Help with account setup",
  "text_body": "Hello support, I need help setting up my domain.",
  "html_body": "<p>Hello support, I need help setting up my domain.</p>",
  "headers_json": "{\"content-type\":\"text/html; charset=utf-8\",\"mime-version\":\"1.0\"}",
  "attachments_json": "[]",
  "raw_size": 1420,
  "received_at": 1792427620392
}
```

#### `DELETE /api/inbox/:id`
Delete an email from the inbound database.
```bash
curl -X DELETE -H "x-api-key: mySecretPassword123" http://localhost:8080/api/inbox/1
```

---

### 6. Domain Management (Multi-Domain Hosting)

#### `POST /api/domains`
Adds a sending/receiving domain, auto-generates a dedicated 2048-bit RSA DKIM key, and provides exact DNS records to configure.

**Request Body:**
```json
{
  "domain": "mybrand.com",
  "selector": "default",
  "inboundEnabled": true,
  "outboundEnabled": true
}
```

```bash
curl -X POST http://localhost:8080/api/domains \
  -H "x-api-key: mySecretPassword123" \
  -H "Content-Type: application/json" \
  -d '{"domain":"mybrand.com","selector":"default"}'
```

**Response (`201 Created`):**
```json
{
  "success": true,
  "domain": "mybrand.com",
  "selector": "default",
  "dkimRecord": {
    "name": "default._domainkey.mybrand.com",
    "type": "TXT",
    "value": "v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA..."
  },
  "dnsRecords": {
    "spf": {
      "type": "TXT",
      "host": "mybrand.com",
      "value": "v=spf1 ip4:YOUR_SERVER_IP ~all"
    },
    "dkim": {
      "type": "TXT",
      "host": "default._domainkey.mybrand.com",
      "value": "v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA..."
    },
    "dmarc": {
      "type": "TXT",
      "host": "_dmarc.mybrand.com",
      "value": "v=DMARC1; p=none; rua=mailto:dmarc@mybrand.com"
    },
    "mx": {
      "type": "MX",
      "host": "mybrand.com",
      "priority": 10,
      "value": "mail.yourdomain.com."
    }
  }
}
```

#### `GET /api/domains`
Lists all hosted domains and their live verification statuses.
```bash
curl -H "x-api-key: mySecretPassword123" http://localhost:8080/api/domains
```

#### `GET /api/domains/:domain`
Inspect a specific domain, its configuration, and public DKIM key.
```bash
curl -H "x-api-key: mySecretPassword123" http://localhost:8080/api/domains/mybrand.com
```

#### `POST /api/domains/:domain/verify`
Runs live DNS queries against public nameservers to verify that your SPF, DKIM, DMARC, and MX records have propagated.
```bash
curl -X POST -H "x-api-key: mySecretPassword123" http://localhost:8080/api/domains/mybrand.com/verify
```

#### `DELETE /api/domains/:domain`
Deletes a hosted domain and removes its associated DKIM key.
```bash
curl -X DELETE -H "x-api-key: mySecretPassword123" http://localhost:8080/api/domains/mybrand.com
```

---

### 7. Anti-Spam & Deliverability Tools

#### `POST /api/dkim/generate`
Generates a standalone 2048-bit RSA DKIM keypair.
```bash
curl -X POST http://localhost:8080/api/dkim/generate \
  -H "x-api-key: mySecretPassword123" \
  -H "Content-Type: application/json" \
  -d '{"domain":"anotherdomain.com","selector":"default"}'
```

#### `GET /api/dkim`
Lists all active DKIM keys stored in the database.
```bash
curl -H "x-api-key: mySecretPassword123" http://localhost:8080/api/dkim
```

#### `GET /api/deliverability/audit/:domain`
Pre-flight audit that runs live DNS lookups on SPF, DKIM, DMARC, Reverse DNS (PTR), and outbound port 25 connectivity, returning a **0–100 Deliverability Score** and issues to fix.
```bash
curl -H "x-api-key: mySecretPassword123" http://localhost:8080/api/deliverability/audit/mybrand.com
```
**Response:**
```json
{
  "domain": "mybrand.com",
  "score": 100,
  "spf": { "valid": true, "record": "v=spf1 ip4:198.51.100.1 ~all" },
  "dkim": { "valid": true, "selector": "default" },
  "dmarc": { "valid": true, "record": "v=DMARC1; p=none;" },
  "ptr": { "valid": true, "hostname": "mail.mybrand.com" },
  "port25Outbound": { "open": true },
  "recommendations": []
}
```

---

### 8. Suppression List Management

Protects sender reputation by suppressing addresses that bounced permanently (550 "User unknown") or clicked unsubscribe.

#### `GET /api/suppression`
List suppressed emails with pagination.
- Query Parameters: `limit` (default: 50), `offset` (default: 0), `reason` (`bounce`, `unsubscribe`, `manual`)
```bash
curl -H "x-api-key: mySecretPassword123" http://localhost:8080/api/suppression
```

#### `POST /api/suppression`
Manually add an email to the suppression list.
```bash
curl -X POST http://localhost:8080/api/suppression \
  -H "x-api-key: mySecretPassword123" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@bounced-address.com",
    "reason": "bounce",
    "details": "Hard bounce 550 recipient rejected"
  }'
```

#### `DELETE /api/suppression/:email`
Unsuppress an email to allow sending again.
```bash
curl -X DELETE -H "x-api-key: mySecretPassword123" http://localhost:8080/api/suppression/user@bounced-address.com
```

---

### 9. Sending Limits & Quotas (100% External Software Control)

The server enforces **no daily sending caps, warmup limits, or artificial throttles**. Your software has full ownership over:
- Daily send limits and quotas per user or account
- Sending speed and pacing
- Campaign scheduling and throttling
The server acts as an unrestricted, high-throughput delivery engine.

---

## 🛡️ Best Practices for High Inbox Delivery (Zero Spam Folder)

1. **Static Cloud VPS with Port 25 Open**: Host on a VPS provider (e.g., OVH, Hetzner, Linode, Vultr) that permits outbound port 25 traffic.
2. **Forward-Confirmed Reverse DNS (FCrDNS / PTR Record)**: Ensure your VPS provider sets the PTR record of your IP to match your server hostname (e.g., `mail.yourdomain.com`).
3. **Publish SPF Record (TXT)**: `v=spf1 ip4:<YOUR_VPS_IP> ~all`
4. **Publish DKIM Record (TXT)**: Use `POST /api/domains` to generate the 2048-bit key and publish to `default._domainkey.yourdomain.com`.
5. **Publish DMARC Record (TXT)**: At `_dmarc.yourdomain.com`: `v=DMARC1; p=none; sp=none; rua=mailto:dmarc@yourdomain.com`.
6. **Provide One-Click Unsubscribe**: Always pass `unsubscribeUrl` on marketing emails to comply with Google and Yahoo 2024+ sender mandates.
