FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY config.json ./
COPY public ./public

RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]