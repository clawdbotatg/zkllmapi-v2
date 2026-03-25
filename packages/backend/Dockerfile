# Build: docker build -f packages/backend/Dockerfile .
# ── Build stage ─────────────────────────────────────────────
FROM node:22-slim AS builder

WORKDIR /app

COPY packages/backend/package.json ./
RUN npm install

COPY packages/backend/tsconfig.json ./
COPY packages/backend/src/ ./src/

RUN npm run build

# ── Production stage ───────────────────────────────────────
FROM node:22-slim

WORKDIR /app

COPY packages/backend/package.json ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist

# Circuit artifacts
COPY packages/circuits/target/ ./circuits/target/

ENV NODE_ENV=production
ENV PORT=3001
ENV CIRCUIT_PATH=/app/circuits/target/circuits.json

EXPOSE 3001

CMD ["node", "dist/index.js"]
