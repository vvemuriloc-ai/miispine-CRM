# miiCase API — Cloud Run. No build step: Node runs TypeScript via native
# type-stripping, so the image is just node + pg (+ firebase-admin).
FROM node:22-slim

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

ENV NODE_ENV=production PORT=8080
EXPOSE 8080
# --experimental-strip-types lets node execute the .ts sources directly.
CMD ["node", "--experimental-strip-types", "src/server.ts"]
