FROM node:20-bookworm-slim

# FFmpeg (libx264, AAC, libass) plus fonts for English and Hebrew subtitles.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg fonts-noto-core fonts-dejavu-core ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src

ENV NODE_ENV=production PORT=10000 WORK_DIR=/tmp/pov39
RUN mkdir -p /tmp/pov39 && chown -R node:node /tmp/pov39 /app
USER node

EXPOSE 10000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.js"]