#!/bin/sh
# Point d'entrée de l'image : « web » (par défaut), « worker », « migrate », « verifier-integrations » ou « admin-add <e-mail> ».
set -e
cd /app
case "${1:-web}" in
  web)
    exec node node_modules/next/dist/bin/next start apps/web --port "${PORT:-3000}" --hostname 0.0.0.0
    ;;
  worker)
    exec node_modules/.bin/tsx packages/worker/src/cli/run.ts
    ;;
  migrate)
    exec node_modules/.bin/tsx packages/db/src/cli/migrate.ts
    ;;
  verifier-integrations)
    exec node_modules/.bin/tsx packages/worker/src/cli/verify-integrations.ts
    ;;
  admin-add)
    shift
    exec node_modules/.bin/tsx packages/db/src/cli/admin-add.ts "$@"
    ;;
  *)
    exec "$@"
    ;;
esac
