FROM node:20-alpine
RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production
# MongoDB connection. Supply MONGODB_URI (and optionally MONGODB_DB) at runtime —
# it holds credentials, so it must not be baked into the image.
ENV MONGODB_DB="stock-shield"

COPY package.json package-lock.json* ./

RUN npm ci --omit=dev && npm cache clean --force

COPY . .

RUN npm run build

CMD ["npm", "run", "docker-start"]
