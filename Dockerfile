# syntax=docker/dockerfile:1.7

FROM node:22.19.0-alpine3.22 AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22.19.0-alpine3.22 AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/app/data

WORKDIR /app
COPY --from=build /app/dist/src ./dist/src
COPY public ./public

RUN mkdir -p /app/data && chown -R node:node /app

USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "dist/src/server.js"]
