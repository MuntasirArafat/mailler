FROM node:22-bookworm-slim

# Install system dependencies (openssl, dns utilities, curl)
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl \
    ca-certificates \
    dnsutils \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package descriptors
COPY package*.json ./

# Install production dependencies
RUN npm ci --omit=dev

# Copy application code
COPY . .

# Ensure data and config directories exist
RUN mkdir -p /app/data /app/config

# Expose ports:
# 25   - Standard Inbound SMTP
# 3000 - REST API and Web Management UI
# 2525 - Optional Alternate SMTP / Relay port
EXPOSE 25 3000 2525

# Environment defaults
ENV NODE_ENV=production
ENV PORT=3000
ENV INBOUND_PORT=25
ENV CONCURRENCY=25

# Launch the mail server
CMD ["node", "index.js"]
