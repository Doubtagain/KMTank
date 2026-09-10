# Builds the KMTank game server. Build context is the repository root, because
# the server depends on the @kmtank/shared workspace.

FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/server/package.json ./packages/server/
COPY packages/client/package.json ./packages/client/
RUN npm ci --ignore-scripts

COPY packages/shared ./packages/shared
COPY packages/server ./packages/server
RUN npm run build -w @kmtank/shared && npm run build -w @kmtank/server

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
ENV PORT=8080
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/server/package.json ./packages/server/
COPY packages/client/package.json ./packages/client/
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/server/dist ./packages/server/dist

# Run unprivileged; the node image ships a `node` user for exactly this.
USER node

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=4s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "packages/server/dist/index.js"]
