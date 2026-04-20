FROM node:20-slim

# Install postgresql-client and cron
RUN apt-get update && \
    apt-get install -y postgresql-client cron && \
    rm -rf /var/lib/apt/lists/*

# Ensure directories exist with proper permissions
RUN mkdir -p logs /var/run && \
    chown -R 1000:1000 logs /var/run

# Copy cron config and set permissions
COPY cron/etc/cron.d/relink-cron /etc/cron.d/relink-cron
RUN chmod 0644 /etc/cron.d/relink-cron

WORKDIR /home/dev/mcp/wiki-v2