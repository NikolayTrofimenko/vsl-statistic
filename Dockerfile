# --- build: compile the Angular bundle and the server ---
FROM node:24-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# --- runtime ---
FROM node:24-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/tracker ./tracker
COPY deploy/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 755 /usr/local/bin/entrypoint.sh

# SQLite database, thumbnail cache and logs — mount a volume.
ENV VSL_STAT_DATA=/data
VOLUME ["/data"]

EXPOSE 4310

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4310)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The server runs as `node`, not root (see deploy/entrypoint.sh).
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "dist-server/server/index.js"]
