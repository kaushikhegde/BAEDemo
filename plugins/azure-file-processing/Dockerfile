FROM node:24-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends poppler-utils ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# The corporate TLS-inspecting proxy (SA_Prisma_Forward_Trust) re-signs every
# HTTPS response, including the npm registry's. macOS trusts it via the
# System keychain; this image does not, so npm ci sees a self-signed cert in
# the chain and refuses it. Trust the same chain here instead of disabling
# certificate verification. corporate-ca.pem is gitignored (*.pem) — export
# it locally with `security find-certificate` before building if it's missing.
COPY corporate-ca.pem /usr/local/share/ca-certificates/corporate-ca.crt
RUN update-ca-certificates
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src

ENV TEMP_DIR=/tmp/afp
RUN mkdir -p /tmp/afp

# Overridden per service in docker-compose.yml
CMD ["npx", "tsx", "src/orchestrator/server.ts"]
