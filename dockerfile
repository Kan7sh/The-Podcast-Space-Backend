FROM node:18-alpine

RUN apk add --no-cache ffmpeg openssl curl

WORKDIR /app

COPY package*.json ./

RUN npm ci --only=production

COPY . .

RUN mkdir -p /app/recordings /app/certificates

RUN if [ "$NODE_ENV" = "development" ]; then \
    openssl req -x509 -newkey rsa:2048 \
    -keyout certificates/localhost-key.pem \
    -out certificates/localhost.pem \
    -days 365 -nodes \
    -subj "/C=US/ST=State/L=City/O=Org/CN=localhost"; \
    fi

# RUN openssl req -x509 -newkey rsa:2048 -keyout certificates/localhost-key.pem -out certificates/localhost.pem -days 365 -nodes -subj "/C=US/ST=State/L=City/O=Org/CN=localhost"

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -k -f http://localhost:3005/health || curl -k -f https://localhost:3005/health || exit 1

EXPOSE 3005

CMD ["node", "server.js"]