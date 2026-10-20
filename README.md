# Production Direct Node.js MTA Mail Server & MongoDB Job Queue System

A high-performance, production-ready **Direct MTA Mail Server** in Node.js backed by **MongoDB**. Features an enterprise outbound **Job Queue** with atomic worker checkout, automatic retry backoff, hard-bounce classification, and persistent **Inbound Message Storage** on Port 25.

**Pure Direct Port 25 Transmission**: Direct socket delivery to destination mail exchangers (Google, Microsoft, Yahoo, etc.) with opportunistic STARTTLS, DKIM signing, and zero third-party SMTP relay dependencies.

---

## ⚡ Key Highlights

- **MongoDB Job Queue System**:
  - Atomic job checkout via MongoDB `findOneAndUpdate` (safe across multiple concurrent workers).
  - Complete status lifecycle: `queued` ➔ `processing` ➔ `completed` or `failed`.
  - Exponential backoff retry system: 1m, 5m, 15m, 30m, 1h for temporary delivery errors (4xx greylisting, DNS/connection timeouts).
  - Instant classification of permanent 5xx hard bounces ("User unknown", "Mailbox not found") to prevent reputation damage.
- **Persistent Inbound Message Store**:
  - Receives emails on Port 25, parses MIME with `mailparser`, extracts attachments and headers, and persists directly into MongoDB.
  - Query, filter, and search inbox via REST API and terminal CLI.
- **Direct & Queued Send API**:
  - `POST /api/send`: Queued by default (`status: 'queued'`), or immediate synchronous MX delivery when `?sync=true`.
  - `POST /api/jobs`: Bulk batch and single email queuing.
  - `GET /api/jobs`: Live job inspection, filtering by status and recipient.
  - `POST /api/jobs/:id/retry` & `POST /api/jobs/retry-all`: Re-trigger failed jobs.
- **Anti-Spam & Deliverability Shield**:
  - Automatic 2048-bit RSA DKIM signing.
  - Strict RFC 5321 Return-Path SPF alignment + HELO SPF support (`mail.<domain>`).
  - RFC 8058 One-Click List-Unsubscribe headers (`List-Unsubscribe` & `List-Unsubscribe-Post`).
  - Pre-flight DNS deliverability auditor (SPF, DKIM, DMARC, Port 25 reachability).
- **Password Authentication**: Secured via `x-api-key: ar@51/er` or `Authorization: Bearer ar@51/er`.

---

## 🗄️ MongoDB Database Architecture (Mongoose Models & 2 Modes)

The database layer is managed by **Mongoose** in [`src/db.js`](file:///Users/muntasirarafat/Documents/mailserver/src/db.js).

### Two MongoDB Operational Modes (`MONGO_MODE`):

1. **Local Mode (`MONGO_MODE=local`, Default)**:
   - Connects to the local MongoDB 7 container included in `docker-compose.yml`.
   - URI: `MONGO_LOCAL_URI=mongodb://127.0.0.1:27017/mailserver`
   - Data is persisted on the VPS host at `./data/mongo`.

2. **Remote Mode (`MONGO_MODE=remote`)**:
   - Connects to an external MongoDB Atlas cluster or central managed database.
   - URI: `MONGO_REMOTE_URI=mongodb+srv://user:password@cluster.mongodb.net/mailserver`

### Mongoose Models Defined in [`src/db.js`](file:///Users/muntasirarafat/Documents/mailserver/src/db.js):
- **`MailJob`**: Tracks outbound mail lifecycle (`queued` ➔ `processing` ➔ `completed` / `failed`), retry attempts, exponential backoff, hard bounces, and delivery responses.
- **`InboundMessage`**: Stores incoming emails received on Port 25 with parsed MIME, sender, recipient, plain text, HTML, and base64 attachments.

---

## 🚀 1-Click Docker Setup (Mail Server + MongoDB)

The included `docker-compose.yml` automatically spins up both the **MongoDB 7** container and the **Mail Server** together with data persistence.

### Step 1: Clone & Configure `.env`
```bash
cp .env.example .env
nano .env
```

Your `.env` file:
```env
PORT=3000
API_PASSWORD=ar@51/er

# MongoDB Modes: 'local' (default) or 'remote'
MONGO_MODE=local
MONGO_LOCAL_URI=mongodb://127.0.0.1:27017/mailserver
MONGO_REMOTE_URI=mongodb+srv://user:pass@cluster.mongodb.net/mailserver

HELO_HOST=mail.exauraa.com
INBOUND_PORT=25
CONCURRENCY=25
```

### Step 2: Deploy Container
```bash
sudo bash docker-deploy.sh
```
*(Or simply run `docker compose up -d --build`)*

The installer launches MongoDB and Mail Server in the background, sets up host networking on Port 25 & 3000, and enables the global host `mailsource` CLI.

---

## ⚡ Global CLI Tool (`mailsource`)

Manage your mail server, inspect jobs, and read incoming emails directly from your server terminal:

### 1. View Outbound Queue & Job Retries:
```bash
mailsource queue
```
Displays live summary:
```text
📬 Outbound Mail Job Queue (MongoDB):
  • Status Summary : Queued: 2 | Processing: 1 | Completed: 48 | Failed: 0
  • Concurrency    : 25 worker slots (1 currently active)

JOB ID               RECIPIENT                  STATUS         ATTEMPTS   DETAILS
-----------------------------------------------------------------------------------------------
job_a8f9c102b3       client@gmail.com           COMPLETED      1/5        gmail-smtp-in.l.google.com
job_e718bc3d4a       user@yahoo.com             QUEUED         2/5        Retrying in 240s
```

### 2. Retry Failed Jobs:
```bash
# Retry a specific job
mailsource retry job_e718bc3d4a

# Retry all failed jobs
mailsource retry
```

### 3. Read Inbound Received Emails (from MongoDB):
```bash
# List recent emails
mailsource inbox

# Read full email body and attachments by ID
mailsource read 1774182900000
```

### 4. Send Email via CLI:
```bash
# Send via background Job Queue (Recommended)
mailsource send --to client@gmail.com --from noreply@exauraa.com --subject "Hello" --body "Welcome!"

# Or send synchronously (waits for live MX socket connection)
mailsource send --to client@gmail.com --from noreply@exauraa.com --subject "Hello" --body "Welcome!" --sync
```

### 5. Check Overall Server & MongoDB Health:
```bash
mailsource status
```

---

## ⚙️ Manual Local / CLI Startup Options

You can also start the server directly using command-line arguments or environment variables:

```bash
# Using CLI flags (recommended)
node index.js --port 3000 --password "ar@51/er" --webhook "https://central.example.com/api/inbound"

# Shorthand flags
node index.js -p 3000 -k "ar@51/er" -w "https://central.example.com/api/inbound"

# Using environment variables
PORT=3000 API_PASSWORD="ar@51/er" WEBHOOK_URL="https://central.example.com/api/inbound" npm start
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

### 1. System Health & Node Status
#### `GET /api/health`
Returns system status, worker role, uptime, memory, and HELO hostname.

**Request:**
```bash
curl -H "x-api-key: ar@51/er" http://localhost:3000/api/health
```

**Response (`200 OK`):**
```json
{
  "status": "healthy",
  "role": "stateless-mta-worker",
  "uptime": 342.12,
  "memory": {
    "rss": 45182976,
    "heapTotal": 24969216,
    "heapUsed": 18274912
  },
  "heloHost": "mail.localmta.dev",
  "authRequired": true
}
```

---

### 2. Direct Single Email Send
#### `POST /api/send`
Immediately delivers an email directly to the destination MX on port 25 and returns live delivery confirmation.

**Headers:**
`Content-Type: application/json`  
`x-api-key: <your_password>`

**Request Body Parameters:**
| Parameter | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `from` | string | **Yes** | Sender email (e.g. `"support@yourdomain.com"`). |
| `to` | string | **Yes** | Recipient email (e.g. `"client@gmail.com"`). |
| `name` / `fromName` | string | No | Sender display name (e.g. `"Support Team"`). |
| `subject` | string | **Yes** | Email subject line. |
| `text` | string | No | Plain text content. |
| `html` | string | No | HTML content. |
| `unsubscribeUrl` | string | No | RFC 8058 One-Click Unsubscribe URL. |
| `unsubscribeEmail` | string | No | RFC 8058 One-Click Unsubscribe mailto. |
| `headers` | object | No | Custom email headers (e.g. `{"X-Campaign-ID": "camp_99"}`). |
| `dkim` | object | No | Optional dynamic DKIM passed from central controller: `{"domainName":"domain.com", "keySelector":"default", "privateKey":"..."}`. |

**Example A: Send Plain Text Email:**
```bash
curl -X POST http://localhost:3000/api/send \
  -H "x-api-key: ar@51/er" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "noreply@exauraa.com",
    "name": "Support",
    "to": "client@gmail.com",
    "subject": "Plain Text Notification",
    "text": "Hello!\n\nThis is a pure plain-text email sent directly to your destination mail server without HTML."
  }'
```

**Example B: Send HTML Email (With Auto Plain-Text Fallback & DKIM):**
```bash
curl -X POST http://localhost:3000/api/send \
  -H "x-api-key: ar@51/er" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "noreply@exauraa.com",
    "name": "Support Team",
    "to": "client@gmail.com",
    "subject": "Direct MX Delivery Test",
    "html": "<h1>Direct Delivery Succeeded</h1><p>Sent directly to MX without 3rd party relays.</p>",
    "text": "Direct Delivery Succeeded. Sent directly to MX without 3rd party relays.",
    "unsubscribeUrl": "https://exauraa.com/unsubscribe?user=client"
  }'
```

**Response (`200 OK`):**
```json
{
  "success": true,
  "messageId": "<f7a30369-2ba1-40be-8451-b0db3717282b@exauraa.com>",
  "dkimSigned": true,
  "recipient": "client@gmail.com",
  "durationMs": 420,
  "host": "gmail-smtp-in.l.google.com",
  "response": "250 2.0.0 OK 1792427620 s20si10237937pgv.489 - gsmtp",
  "tls": true
}
```

---

### 3. Direct Concurrent Batch Send
#### `POST /api/send-batch`
Allows your centralized system to dispatch an array of emails to this VPS node for parallel direct delivery.

**Request Body:**
```json
{
  "concurrency": 10,
  "emails": [
    {
      "from": "newsletter@yourdomain.com",
      "to": "user1@gmail.com",
      "subject": "Weekly Update",
      "html": "<p>Hello User 1</p>"
    },
    {
      "from": "newsletter@yourdomain.com",
      "to": "user2@yahoo.com",
      "subject": "Weekly Update",
      "html": "<p>Hello User 2</p>"
    }
  ]
}
```

**Response (`200 OK`):**
```json
{
  "success": true,
  "total": 2,
  "sent": 2,
  "failed": 0,
  "results": [
    {
      "to": "user1@gmail.com",
      "success": true,
      "messageId": "<uuid1@yourdomain.com>",
      "dkimSigned": true,
      "host": "gmail-smtp-in.l.google.com",
      "response": "250 2.0.0 OK"
    },
    {
      "to": "user2@yahoo.com",
      "success": true,
      "messageId": "<uuid2@yourdomain.com>",
      "dkimSigned": true,
      "host": "mta5.am0.yahoodns.net",
      "response": "250 ok dirdel"
    }
  ]
}
```

---

---

### 3. Outbound Job Queue API (MongoDB Backed)

#### `POST /api/jobs`
Enqueues one or more emails into MongoDB for asynchronous worker delivery.

**Single Email:**
```bash
curl -X POST http://localhost:3000/api/jobs \
  -H "x-api-key: ar@51/er" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "noreply@exauraa.com",
    "name": "Support",
    "to": "client@gmail.com",
    "subject": "Queued Delivery",
    "text": "Hello! Your report is ready."
  }'
```
**Response (`201 Created`):**
```json
{
  "success": true,
  "jobId": "job_9b3e1c07af82d1",
  "status": "queued",
  "recipient": "client@gmail.com"
}
```

**Bulk Email Batch:**
```bash
curl -X POST http://localhost:3000/api/jobs \
  -H "x-api-key: ar@51/er" \
  -H "Content-Type: application/json" \
  -d '{
    "emails": [
      { "from": "noreply@exauraa.com", "to": "user1@gmail.com", "subject": "Welcome User 1", "text": "Hi 1" },
      { "from": "noreply@exauraa.com", "to": "user2@yahoo.com", "subject": "Welcome User 2", "text": "Hi 2" }
    ]
  }'
```

#### `GET /api/jobs/stats`
Returns live real-time job counts by status.
```bash
curl -H "x-api-key: ar@51/er" http://localhost:3000/api/jobs/stats
```
**Response (`200 OK`):**
```json
{
  "queued": 5,
  "processing": 2,
  "completed": 1250,
  "failed": 3,
  "total": 1260,
  "activeWorkers": 2,
  "concurrency": 25
}
```

#### `GET /api/jobs`
List jobs with pagination and status filters.
- Parameters: `status` (`queued`, `processing`, `completed`, `failed`), `recipient`, `search`, `limit`, `offset`
```bash
curl -H "x-api-key: ar@51/er" "http://localhost:3000/api/jobs?status=failed&limit=10"
```

#### `GET /api/jobs/:id`
Inspect full job details, attempts history, delivery duration, and last error.
```bash
curl -H "x-api-key: ar@51/er" http://localhost:3000/api/jobs/job_9b3e1c07af82d1
```

#### `POST /api/jobs/:id/retry`
Re-queues a specific failed job for immediate re-attempt.
```bash
curl -X POST -H "x-api-key: ar@51/er" http://localhost:3000/api/jobs/job_9b3e1c07af82d1/retry
```

#### `POST /api/jobs/retry-all`
Re-queues all failed jobs in MongoDB.
```bash
curl -X POST -H "x-api-key: ar@51/er" http://localhost:3000/api/jobs/retry-all
```

#### `DELETE /api/jobs/:id`
Cancel or delete a job.
```bash
curl -X DELETE -H "x-api-key: ar@51/er" http://localhost:3000/api/jobs/job_9b3e1c07af82d1
```

---

### 4. Inbound Mail Storage (MongoDB Backed)

The mail server runs an Inbound SMTP service on **Port 25**. When an email arrives:
1. It is parsed by `mailparser` (headers, sender, recipient, subject, plain text body, HTML body, attachments).
2. It is saved directly into the MongoDB `inbound_messages` collection.

#### `GET /api/inbox`
Query stored incoming messages with pagination and search filters.
- Parameters: `limit`, `offset`, `to`, `from`, `query`
```bash
curl -H "x-api-key: ar@51/er" "http://localhost:3000/api/inbox?limit=20"
```
**Response:**
```json
{
  "total": 1,
  "limit": 20,
  "offset": 0,
  "emails": [
    {
      "id": 1774182900000,
      "message_id": "<CABe4d8f...example@gmail.com>",
      "from_email": "client@gmail.com",
      "from_name": "John Doe",
      "to_email": "support@exauraa.com",
      "subject": "Help with account",
      "text_body": "Hello, I have a question about my account.",
      "html_body": "<p>Hello, I have a question about my account.</p>",
      "status": "received",
      "received_at": "2026-10-20T12:30:00.000Z"
    }
  ]
}
```

#### `GET /api/inbox/:id`
Retrieve full incoming email including base64 attachments and headers.
```bash
curl -H "x-api-key: ar@51/er" http://localhost:3000/api/inbox/1774182900000
```

#### `DELETE /api/inbox/:id`
Delete an incoming email from MongoDB.
```bash
curl -X DELETE -H "x-api-key: ar@51/er" http://localhost:3000/api/inbox/1774182900000
```

#### `DELETE /api/inbox`
Clear all incoming messages from MongoDB.
```bash
curl -X DELETE -H "x-api-key: ar@51/er" http://localhost:3000/api/inbox
```

---

### 5. Domain Management (Multi-Domain Hosting)

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
curl -X POST http://localhost:3000/api/domains \
  -H "x-api-key: ar@51/er" \
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
    "heloSpf": {
      "type": "TXT",
      "host": "mail.mybrand.com",
      "value": "v=spf1 a -all"
    },
    "dkim": {
      "type": "TXT",
      "host": "default._domainkey.mybrand.com",
      "value": "v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA..."
    },
    "dmarc": {
      "type": "TXT",
      "host": "_dmarc.mybrand.com",
      "value": "v=DMARC1; p=reject; sp=reject; pct=100; rua=mailto:dmarc@mybrand.com"
    },
    "mx": {
      "type": "MX",
      "host": "mybrand.com",
      "priority": 10,
      "value": "mail.mybrand.com."
    }
  }
}
```

#### `GET /api/domains`
Lists all hosted domains and their live verification statuses.
```bash
curl -H "x-api-key: ar@51/er" http://localhost:3000/api/domains
```

#### `GET /api/domains/:domain`
Inspect a specific domain, its configuration, and public DKIM key.
```bash
curl -H "x-api-key: ar@51/er" http://localhost:3000/api/domains/mybrand.com
```

#### `POST /api/domains/:domain/verify`
Runs live DNS queries against public nameservers to verify that your SPF, DKIM, DMARC, and MX records have propagated.
```bash
curl -X POST -H "x-api-key: ar@51/er" http://localhost:3000/api/domains/mybrand.com/verify
```

#### `DELETE /api/domains/:domain`
Deletes a hosted domain and removes its associated DKIM key.
```bash
curl -X DELETE -H "x-api-key: ar@51/er" http://localhost:3000/api/domains/mybrand.com
```

---

### 7. Anti-Spam & Deliverability Tools

#### `POST /api/dkim/generate`
Generates a standalone 2048-bit RSA DKIM keypair.
```bash
curl -X POST http://localhost:3000/api/dkim/generate \
  -H "x-api-key: ar@51/er" \
  -H "Content-Type: application/json" \
  -d '{"domain":"anotherdomain.com","selector":"default"}'
```

#### `GET /api/dkim`
Lists all active DKIM keys stored in the database.
```bash
curl -H "x-api-key: ar@51/er" http://localhost:3000/api/dkim
```

#### `GET /api/deliverability/audit/:domain`
Pre-flight audit that runs live DNS lookups on SPF, DKIM, DMARC, Reverse DNS (PTR), and outbound port 25 connectivity, returning a **0–100 Deliverability Score** and issues to fix.
```bash
curl -H "x-api-key: ar@51/er" http://localhost:3000/api/deliverability/audit/mybrand.com
```
**Response:**
```json
{
  "domain": "mybrand.com",
  "score": 100,
  "spf": { "valid": true, "record": "v=spf1 ip4:YOUR_IP ~all" },
  "dkim": { "valid": true, "selector": "default" },
  "dmarc": { "valid": true, "record": "v=DMARC1; p=reject; sp=reject; pct=100;" },
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
curl -H "x-api-key: ar@51/er" http://localhost:3000/api/suppression
```

#### `POST /api/suppression`
Manually add an email to the suppression list.
```bash
curl -X POST http://localhost:3000/api/suppression \
  -H "x-api-key: ar@51/er" \
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
curl -X DELETE -H "x-api-key: ar@51/er" http://localhost:3000/api/suppression/user@bounced-address.com
```

---

### 9. Sending Limits & Quotas (100% External Software Control)

The server enforces **no daily sending caps, warmup limits, or artificial throttles**. Your software has full ownership over:
- Daily send limits and quotas per user or account
- Sending speed and pacing
- Campaign scheduling and throttling
The server acts as an unrestricted, high-throughput delivery engine.

---

## 🛡️ Best Practices for High Inbox Delivery (Zero Spam Folder & 10/10 Score)

1. **Static Cloud VPS with Port 25 Open**: Host on a VPS provider that permits outbound port 25 traffic.
2. **Forward-Confirmed Reverse DNS (FCrDNS / PTR Record)**: Set the PTR record of your server IP to match your HELO hostname: `mail.yourdomain.com`.
3. **Publish Domain SPF Record (TXT)**: At `yourdomain.com`: `v=spf1 ip4:<YOUR_VPS_IP> ~all`.
4. **Publish HELO Hostname SPF Record (TXT)**: At `mail.yourdomain.com`: `v=spf1 a -all` *(Resolves "SPF: HELO does not publish an SPF Record")*.
5. **Publish DKIM Record (TXT)**: At `default._domainkey.yourdomain.com` with the 2048-bit RSA public key.
6. **Publish Strict DMARC Policy (TXT)**: At `_dmarc.yourdomain.com`: `v=DMARC1; p=reject; sp=reject; pct=100; rua=mailto:dmarc@yourdomain.com` *(Eliminates "DMARC policy is set to None" warnings)*.
7. **HTML Semantics & Plain-Text Fallback**: Always ensure emails include a valid `<!DOCTYPE html>` wrapper and plain-text body (handled automatically by the server's Anti-Spam Shield).
8. **Provide One-Click Unsubscribe**: Always pass `unsubscribeUrl` on marketing emails to comply with Google and Yahoo sender mandates.
