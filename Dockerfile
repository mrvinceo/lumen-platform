# Builds one app from the monorepo: docker build --build-arg APP=api -t lumen-api .
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo

FROM base AS build
ARG APP=api
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @lumen/${APP} build
RUN pnpm --filter @lumen/${APP} deploy --prod --legacy /out

FROM node:22-slim AS runtime
ARG APP=api
ENV NODE_ENV=production MIGRATIONS_DIR=/app/migrations
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./package.json
COPY --from=build /repo/apps/${APP}/dist ./dist
COPY --from=build /repo/packages/db/migrations ./migrations
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
