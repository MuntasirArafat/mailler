# Stateless Direct Node.js MTA Sender Node (Multi-VPS Architecture)

A production-grade, lightweight, stateless **Direct MTA Mail Sender Node** in Node.js built to run across **multiple VPS instances** and be orchestrated from a **centralized control system**.

**Zero local database (No SQLite)**, zero local job queue bottlenecks, and zero third-party SMTP relays (No SendGrid, Mailgun, or AWS SES). Pure direct MTA transmission to destination mail exchangers (MX) on Port 25 with opportunistic STARTTLS.

---

## ⚡ Key Highlights

- **Stateless Sending Nodes**: Designed to run on multiple VPS worker nodes controlled centrally. No local database, no SQLite locks, zero persistence bottlenecks.
- **Direct Port 25 Delivery**: Direct socket delivery to destination MX (Google, Microsoft, Yahoo, etc.) with opportunistic STARTTLS.
- **Inbound Mail Receiver with Instant Webhook**: Listens on Port 25 for incoming emails, parses MIME, extracts attachments, and automatically dispatches a real-time HTTP POST JSON webhook callback to your central system.
- **Direct Single & Batch Send API**:
  - `POST /api/send`: Live direct send returning delivery status, MX banner, and messageId immediately (supports plain text, HTML, or both).
  - `POST /api/send-batch`: Parallel direct send across multiple recipients with concurrency throttling.
- **Dynamic DKIM from Central Controller**: Pass DKIM private keys directly in send requests or store in `config/dkim-keys.json`.
- **Anti-Spam & Deliverability Shield**:
  - Automatic 2048-bit RSA DKIM signing.
  - Strict RFC 5321 Return-Path SPF alignment + HELO SPF support.
  - RFC 8058 One-Click List-Unsubscribe headers (`List-Unsubscribe` & `List-Unsubscribe-Post`).
  - Pre-flight DNS deliverability auditor (SPF, DKIM, DMARC, Port 25 reachability).
- **Password Authentication**: Every API request is strictly secured by password authentication.

---

## 🚀 VPS One-Command Automated Setup

The installer scripts ([`deploy.sh`](file:///Users/muntasirarafat/Documents/mailserver/deploy.sh) and [`docker-deploy.sh`](file:///Users/muntasirarafat/Documents/mailserver/docker-deploy.sh)) interactively configure:
1. **API Port** (Default: `3000`)
2. **API Password** (Secret authentication key)
3. **Inbound Mail Webhook Callback URL** (When any incoming email is received, it is immediately POSTed as JSON to this URL)

### Option A: Standard VPS Installation (Systemd Service)
```bash
sudo bash deploy.sh
```

### Option B: Docker Container Installation (Recommended)
```bash
sudo bash docker-deploy.sh
```

### Interactive Setup Prompt Example:
```text
⚙️  Configure Your Mail Server Credentials:
Select API Service Port [default: 3000]: 3000
Enter Secret API Password [press Enter to auto-generate]: ar@51/er
Enter Inbound Mail Webhook Callback URL (e.g. https://central.example.com/api/inbound) [press Enter to skip]: https://central.example.com/api/inbound

✔ Configuration chosen:
  • API Port        : 3000
  • API Password    : ar@51/er
  • Inbound Webhook : https://central.example.com/api/inbound
```

*(Non-interactive flags are supported: `sudo bash deploy.sh -p 3000 -k ar@51/er -w https://central.example.com/api/inbound`)*

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

### 5. Inbound Mail Receiving & Webhook Callback (Receive Incoming Emails)

The mail server runs an Inbound SMTP service on **Port 25** (or configured port). When an email arrives:
1. It is parsed by `mailparser` (extracts headers, sender, recipient, subject, plain text body, HTML body, and base64 attachments).
2. It is saved in persistent memory/file (`data/inbox.json`).
3. **Webhook Callback Dispatch**: If a Webhook Callback URL is configured, the server immediately performs an HTTP `POST` request with `Content-Type: application/json` containing the complete parsed message.

#### 🔔 Webhook Callback Payload Specification
When an incoming email is delivered to your server, your callback URL receives this JSON payload:

```json
{
  "id": 1774182900000,
  "message_id": "<CABe4d8f...example@gmail.com>",
  "from_email": "sender@gmail.com",
  "from_name": "John Doe",
  "to_email": "contact@yourdomain.com",
  "subject": "Inquiry regarding your services",
  "text_body": "Hi there,\nI would like more information about your platform.\nThanks,\nJohn",
  "html_body": "<p>Hi there,<br>I would like more information about your platform.<br>Thanks,<br>John</p>",
  "headers": {
    "date": "Tue, 20 Oct 2026 12:30:00 +0000",
    "from": "John Doe <sender@gmail.com>",
    "to": "contact@yourdomain.com",
    "subject": "Inquiry regarding your services"
  },
  "attachments": [
    {
      "filename": "proposal.pdf",
      "contentType": "application/pdf",
      "size": 48200,
      "contentBase64": "JVBERi0xLjQK..."
    }
  ],
  "raw_size": 52140,
  "received_at": 1774182900000
}
```

#### `GET /api/webhook`
Check the currently active Webhook Callback URL.
```bash
curl -H "x-api-key: ar@51/er" http://localhost:3000/api/webhook
```
**Response:**
```json
{
  "webhookUrl": "https://central.example.com/api/inbound"
}
```

#### `POST /api/webhook`
Dynamically set or change the Inbound Webhook Callback URL without restarting the service.
```bash
curl -X POST http://localhost:3000/api/webhook \
  -H "x-api-key: ar@51/er" \
  -H "Content-Type: application/json" \
  -d '{"webhookUrl": "https://central.example.com/api/inbound"}'
```

#### `GET /api/inbox`
List received emails stored on the node.
- Query Parameters:
  - `limit` (default: 50, max: 200)
  - `offset` (default: 0)
  - `to` (filter by recipient address, e.g. `support@yourdomain.com`)
  - `from` (filter by sender address)
  - `query` (search subject and text content)

```bash
curl -H "x-api-key: ar@51/er" "http://localhost:3000/api/inbox?limit=10"
```

#### `GET /api/inbox/:id`
Retrieve a single email by timestamp ID with full body and attachments.
```bash
curl -H "x-api-key: ar@51/er" http://localhost:3000/api/inbox/1774182900000
```

#### `DELETE /api/inbox/:id`
Delete a specific email from the local inbox.
```bash
curl -X DELETE -H "x-api-key: ar@51/er" http://localhost:3000/api/inbox/1774182900000
```

#### `POST /api/inbox/clear`
Clear all local stored emails.
```bash
curl -X POST -H "x-api-key: ar@51/er" http://localhost:3000/api/inbox/clear
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
