FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY sync.mjs potentialpaper-plugin.json ./
USER node
CMD ["node", "sync.mjs", "--watch"]
