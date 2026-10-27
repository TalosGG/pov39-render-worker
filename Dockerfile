FROM node:20-bookworm-slim

# FFmpeg (libx264, AAC, libass) plus fonts for English and Hebrew subtitles.
# Python + Pillow + numpy run the Timeline V2 compositor (src/render/v2/compose.py);
# libraqm gives Pillow real BiDi/shaping for Hebrew overlays.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg chromium fonts-noto-core fonts-dejavu-core ca-certificates tini \
     python3 python3-pil python3-numpy libraqm0 \
  && rm -rf /var/lib/apt/lists/*

# Offline transcription (sherpa-onnx Whisper-turbo int8 + Silero VAD) is optional: the
# model is ~560 MB on disk and ~1–1.5 GB in memory while decoding, which does not fit
# beside a render on a 2 GB instance. Build with --build-arg WITH_ASR=1 for an analysis
# worker; without it /capabilities reports transcribe as not ready and the job is refused.
ARG WITH_ASR=0
ARG SHERPA_ONNX_VERSION=1.13.8
RUN if [ "$WITH_ASR" = "1" ]; then \
      apt-get update && apt-get install -y --no-install-recommends python3-pip curl bzip2 \
      && pip3 install --no-cache-dir --break-system-packages "sherpa-onnx==${SHERPA_ONNX_VERSION}" \
      && mkdir -p /opt/asr && cd /opt/asr \
      && curl -fsSL -o turbo.tar.bz2 https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-turbo.tar.bz2 \
      && tar xjf turbo.tar.bz2 && rm turbo.tar.bz2 \
      && find /opt/asr/sherpa-onnx-whisper-turbo -type f ! -name 'turbo-encoder.int8.onnx' ! -name 'turbo-decoder.int8.onnx' ! -name 'turbo-tokens.txt' -delete \
      && curl -fsSL -o silero_vad.onnx https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx \
      && apt-get purge -y curl bzip2 && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*; \
    fi

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

# The Remotion motion project (composition + renderer scripts) and its own deps.
# Chromium comes from the system package above, so Remotion never downloads one.
COPY remotion/package.json remotion/package-lock.json* ./remotion/
RUN cd remotion && npm install --omit=dev --no-audit --no-fund \
  && npm install --no-save react@^18.3.1 react-dom@^18.3.1 && npm cache clean --force
COPY remotion ./remotion
COPY src ./src

ENV NODE_ENV=production PORT=10000 WORK_DIR=/tmp/pov39 REMOTION_CHROME_PATH=/usr/bin/chromium \
    PYTHON_BIN=python3 FFMPEG_THREADS=2 ASR_MODEL_DIR=/opt/asr/sherpa-onnx-whisper-turbo ASR_VAD_MODEL=/opt/asr/silero_vad.onnx
RUN mkdir -p /tmp/pov39 && chown -R node:node /tmp/pov39 /app
USER node

EXPOSE 10000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.js"]
