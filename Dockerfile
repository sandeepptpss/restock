FROM node:20-alpine
RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production
# Prisma connection string. The default SQLite file lives on the container
# filesystem, so mount a volume at /app/prisma (or point DATABASE_URL at a
# managed Postgres/MySQL instance) to keep data across deploys.
ENV DATABASE_URL="file:/app/prisma/prod.sqlite"

COPY package.json package-lock.json* ./

RUN npm ci --omit=dev && npm cache clean --force

COPY . .

RUN npm run build

CMD ["npm", "run", "docker-start"]
