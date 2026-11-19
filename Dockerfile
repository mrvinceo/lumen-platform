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
# The API image also serves the console, the widget's chat app and the widget loader script.
RUN if [ "$APP" = "api" ]; then pnpm --filter @lumen/console --filter @lumen/chat --filter @lumen/widget build; \
    else mkdir -p apps/console/dist apps/chat/dist packages/widget/dist && touch packages/widget/dist/widget.js; fi
# Hoisted layout so the bundle can import the dependencies of bundled workspace packages.
RUN pnpm --filter @lumen/${APP} deploy --prod --legacy --config.node-linker=hoisted /out

FROM node:22-slim AS runtime
ARG APP=api
ENV NODE_ENV=production MIGRATIONS_DIR=/app/migrations CONSOLE_DIST=/app/console \
    CHAT_DIST=/app/chat WIDGET_SCRIPT=/app/widget/widget.js
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./package.json
COPY --from=build /repo/apps/${APP}/dist ./dist
COPY --from=build /repo/packages/db/migrations ./migrations
COPY --from=build /repo/apps/console/dist ./console
COPY --from=build /repo/apps/chat/dist ./chat
COPY --from=build /repo/packages/widget/dist/widget.js ./widget/widget.js
# Uploads directory for STORAGE_DRIVER=fs; a named volume mounted here inherits this ownership.
RUN mkdir -p /data/uploads && chown node:node /data/uploads
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
