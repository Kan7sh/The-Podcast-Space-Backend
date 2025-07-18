FROM node:18-alpine

WORKDIR /app

RUN apk add --no-cache ffmpeg

COPY package*.json ./

RUN npm ci --only=production

COPY . .

EXPOSE 3005

RUN mkdir -p recordings

CMD ["node", "server.js"]