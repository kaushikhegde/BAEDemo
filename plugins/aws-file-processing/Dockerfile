FROM node:24-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends poppler-utils ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# If you build behind a TLS-inspecting proxy, npm ci will refuse the registry's
# re-signed certificate: the proxy's root is in the host keychain and not in this
# image. Trust the same chain here rather than disabling verification —
# uncomment the three lines below and drop the PEM beside this Dockerfile.
#
#   COPY corporate-ca.pem /usr/local/share/ca-certificates/corporate-ca.crt
#   RUN update-ca-certificates
#   ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
#
# They are commented rather than present-and-optional because `COPY` of a file
# that is not there fails the build outright, and a plugin that cannot be built
# without a certificate nobody outside one office has is not a plugin.

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci || npm install
COPY tsconfig.json ./
COPY src ./src

ENV TEMP_DIR=/tmp/afp
RUN mkdir -p /tmp/afp

# Overridden per service in docker-compose.yml
CMD ["npx", "tsx", "src/orchestrator/server.ts"]
