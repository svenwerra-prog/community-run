# Für Hoster, die Container erwarten (Fly.io, Railway, eigener Server)
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js store.js ./
COPY public ./public
ENV PORT=3000
EXPOSE 3000
USER node
CMD ["node", "server.js"]
