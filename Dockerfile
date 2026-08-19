FROM node:20-alpine
RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production
# MySQL connection. Supply MYSQL_HOST / MYSQL_USER / MYSQL_PASSWORD (or a single
# MYSQL_URL) at runtime — they hold credentials, so they must not be baked into
# the image.
ENV MYSQL_DATABASE="stock-shield"

COPY package.json package-lock.json* ./

RUN npm ci --omit=dev && npm cache clean --force

COPY . .

RUN npm run build

CMD ["npm", "run", "docker-start"]
