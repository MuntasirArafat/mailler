# Check server health, role, and uptime
mailsource status

# Send an email directly via MTA
mailsource send --to user@gmail.com --from me@mybrand.com --subject "Subject" --body "Message body"

# List hosted sending domains
mailsource domains

# Add a domain (auto-generates 2048-bit DKIM & exact DNS records to copy)
mailsource domains add mybrand.com

# Verify live DNS records (SPF, DKIM, DMARC, MX)
mailsource domains verify mybrand.com

# Remove/Delete a domain
mailsource domains remove mybrand.com

# Test if Outbound Port 25 is reachable to Google MX
node cli.js test-port25
