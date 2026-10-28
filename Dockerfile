FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production TZ=Asia/Shanghai
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY web ./web
COPY tools/container-worker.mjs tools/check-provider.mjs ./tools/
USER node
EXPOSE 3080
CMD ["node", "src/app.mjs"]
