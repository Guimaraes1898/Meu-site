FROM node:alpine AS dependencies
WORKDIR /app

RUN npm install --global pnpm@8
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM node:alpine AS production
WORKDIR /app
ENV NODE_ENV=production

COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public

EXPOSE 3001
CMD ["node", "src/server.js"]
