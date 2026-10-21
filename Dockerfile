# -------------------------------------------------------------
# Stage 1: Build
# -------------------------------------------------------------
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Copy package definitions
COPY package*.json ./

# Install dependencies for compilation
RUN npm ci

# Copy TypeScript configuration and source code
COPY tsconfig*.json nest-cli.json ./
COPY src/ ./src/

# Compile NestJS application to dist/
RUN npm run build

# Prune development dependencies
RUN npm prune --production

# -------------------------------------------------------------
# Stage 2: Production Runner
# -------------------------------------------------------------
FROM node:22-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV RELAY_DB_PATH=/app/data/relay.sqlite

# Create data directory for persistent SQLite storage
RUN mkdir -p /app/data && chown -R node:node /app

# Copy production dependencies and compiled artifacts
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/package.json ./package.json

USER node

EXPOSE 3000

CMD ["node", "dist/main.js"]
