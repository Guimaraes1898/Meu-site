FROM node:22-alpine AS dependencies
WORKDIR /app

RUN npm install --global pnpm@10
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM node:22-alpine AS production
WORKDIR /app
ENV NODE_ENV=production

COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY .sequelizerc.cjs ./
COPY src ./src
COPY public ./public

EXPOSE 3001
CMD ["node", "src/server.js"]
