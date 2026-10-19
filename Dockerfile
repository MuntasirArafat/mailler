FROM node:22-alpine

WORKDIR /app

# Copy package descriptors
COPY package*.json ./

# Install production dependencies
RUN npm install --omit=dev

# Copy application code
COPY . .

# Ensure data and config directories exist
RUN mkdir -p /app/data /app/config

# Global CLI symlink inside container
RUN chmod +x /app/bin/mailsource.js && \
    ln -sf /app/bin/mailsource.js /usr/local/bin/mailsource && \
    ln -sf /app/bin/mailsource.js /usr/local/bin/mailsouce

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
