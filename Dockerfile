# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Build stage — compiles TypeScript and produces a production node_modules tree.
#
# better-sqlite3 is a native addon. Prebuilt binaries usually cover linux/x64,
# but the toolchain is installed here so the build still succeeds if it has to
# compile from source. None of it reaches the runtime image.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS build

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy manifests first so `npm ci` is cached across source-only changes.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop devDependencies; the compiled native addon in node_modules is kept.
RUN npm prune --omit=dev


# ---------------------------------------------------------------------------
# Runtime stage — no compilers, no source, no dev dependencies.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    # Default to the Render disk mount point; override locally.
    DATABASE_PATH=/data/patients.sqlite

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY public ./public

# The SQLite file lives on a mounted volume so it survives restarts/redeploys.
RUN mkdir -p /data && chown -R node:node /app /data

# Never run the server as root.
USER node

EXPOSE 3000

CMD ["node", "dist/index.js"]
