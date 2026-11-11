FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma/
COPY prisma.config.ts ./

RUN npm ci
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src/

RUN npm run build

EXPOSE 4000

CMD ["node", "dist/index.js"]
