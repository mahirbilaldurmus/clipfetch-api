FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    ffmpeg \
    ca-certificates \
    && pip3 install --break-system-packages --no-cache-dir --upgrade yt-dlp yt-dlp-ejs curl-cffi \
    && yt-dlp --version \
    && node --version \
    && python3 -m pip show yt-dlp-ejs \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY server.js ./

ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "server.js"]
