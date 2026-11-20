# Image unique de production : application web, tâches de fond et migrations.
#   docker build -t rostra .
#   web :        docker run rostra            (par défaut)
#   tâches :     docker run rostra worker
#   migrations : docker run rostra migrate
# Les paquets du dépôt sont en TypeScript source : Next.js les compile pour le web, tsx les
# exécute pour les tâches de fond.

FROM node:24-bookworm-slim AS base
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

# Dépendances (couche mise en cache tant que les package.json ne changent pas).
FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY packages/ai/package.json packages/ai/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/linkedin/package.json packages/linkedin/
COPY packages/services/package.json packages/services/
COPY packages/visuals/package.json packages/visuals/
COPY packages/worker/package.json packages/worker/
RUN npm ci --no-fund --no-audit

FROM deps AS build
COPY tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
RUN npm run build -w @posts-auto/web
# Les dépendances de développement ne partent pas en production.
RUN npm prune --omit=dev --no-fund --no-audit

FROM base AS runtime
ENV NODE_ENV=production
# tsx (tâches de fond, migrations) reste nécessaire à l'exécution.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json /app/tsconfig.base.json ./
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/web ./apps/web
COPY deploy/entrypoint.sh /usr/local/bin/entrypoint
RUN chmod +x /usr/local/bin/entrypoint && mkdir -p /data/media && chown -R node:node /data
USER node
ENV MEDIA_ROOT=/data/media
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s CMD node -e "fetch('http://127.0.0.1:3000/sante').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" || exit 1
ENTRYPOINT ["entrypoint"]
CMD ["web"]
