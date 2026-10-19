# Check server health, uptime, and queue counters
mailsource status

# List recent received inbound emails
mailsource inbox

# Read full content of an email (text, HTML, attachments)
mailsource read 1

# List hosted sending/receiving domains
mailsource domains

# Add a domain (auto-generates 2048-bit DKIM & exact DNS records to copy)
mailsource domains add mybrand.com

# Verify live DNS records (SPF, DKIM, DMARC, MX)
mailsource domains verify mybrand.com

# Remove/Delete a domain
mailsource domains remove mybrand.com

# Send an email
mailsource send --to user@gmail.com --from me@mybrand.com --subject "Subject" --body "Message body"

# View outbound delivery queue
mailsource queue

# Retry failed deliveries
mailsource retry
