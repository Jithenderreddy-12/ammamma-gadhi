# Ammamma Gadhi — API image.
# Node 22 (matches "engines" in package.json; node:sqlite needs Node 22+).
FROM node:22-alpine

WORKDIR /app

# Install production dependencies first (cached unless package.json changes).
COPY package.json ./
RUN npm install --omit=dev

# Then copy the app. .dockerignore keeps node_modules, local SQLite files,
# .env and test artefacts out of the image.
COPY . .
RUN mkdir -p data && chown -R node:node /app

USER node

EXPOSE 3000

# The /health endpoint answers without touching the database.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server/index.js"]
