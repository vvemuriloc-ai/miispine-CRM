# miiCase jobs — Cloud Run. No build step (native TS type-stripping).
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
COPY lib ./lib
COPY modmed-sync ./modmed-sync
COPY modmed-records ./modmed-records
COPY autopilot ./autopilot
COPY server.ts ./
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["node", "--experimental-strip-types", "server.ts"]
