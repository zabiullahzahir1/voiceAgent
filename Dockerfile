# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Build stage — compiles TypeScript and produces a production node_modules tree.
#
# `pg` is pure JavaScript, so no compiler toolchain is needed in either stage.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS build

WORKDIR /app

# Copy manifests first so `npm ci` is cached across source-only changes.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop devDependencies from the tree we are about to copy forward.
RUN npm prune --omit=dev


# ---------------------------------------------------------------------------
# Runtime stage — no source, no dev dependencies, non-root.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY public ./public

# Never run the server as root.
USER node

EXPOSE 3000

# State lives in Postgres (DATABASE_URL), so the container itself is stateless
# and can be restarted or scaled freely without losing patient records.
CMD ["node", "dist/index.js"]
