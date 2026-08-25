FROM node:24-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends poppler-utils ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src

ENV TEMP_DIR=/tmp/afp
RUN mkdir -p /tmp/afp

# Overridden per service in docker-compose.yml
CMD ["npx", "tsx", "src/orchestrator/server.ts"]
