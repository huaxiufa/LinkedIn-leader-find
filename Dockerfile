FROM node:22-bookworm

WORKDIR /app

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     xvfb \
     x11vnc \
     fluxbox \
     novnc \
     websockify \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install
RUN npx playwright install --with-deps chromium

COPY . .
RUN npx prisma generate

EXPOSE 3000 7900 9222

CMD ["npm", "run", "dev"]
