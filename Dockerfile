# syntax=docker/dockerfile:1

# Cloud Run image for contrarian-product-rules.
#
# Database migrations are NOT run here. Cloud Run can start many instances of
# this image concurrently, and running `prisma migrate deploy` on each start
# would race and add cold-start latency. Migrations run once per release from
# the deploy workflow (.github/workflows/deploy.yml) before traffic is shifted.

FROM node:20-alpine AS base
RUN apk add --no-cache openssl
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
ENV NPM_CONFIG_FUND=false

# --- build: full dependency tree, compile the app ---------------------------
FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci
COPY prisma ./prisma
RUN npx prisma generate
COPY . .
RUN npm run build

# --- prod-deps: runtime dependency tree only --------------------------------
FROM base AS prod-deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY prisma ./prisma
RUN npx prisma generate

# --- runner -----------------------------------------------------------------
FROM base AS runner
ENV NODE_ENV=production
# Cloud Run injects PORT (8080 by default); react-router-serve honours it.
ENV PORT=8080

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY package.json package-lock.json ./
COPY prisma ./prisma

USER node
EXPOSE 8080

CMD ["npm", "run", "start"]
