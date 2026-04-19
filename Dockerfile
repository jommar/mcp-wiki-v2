FROM node:20-slim

# Install postgresql-client
RUN apt-get update && \
    apt-get install -y postgresql-client && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /home/dev/mcp/wiki-v2