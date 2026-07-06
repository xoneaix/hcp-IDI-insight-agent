FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=10000 \
    DATA_DIR=/app/data \
    PYTHON_BIN=/opt/venv/bin/python3

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv ca-certificates \
    && python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir python-docx==1.2.0 pypdf==6.1.1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm@11.7.0 \
    && pnpm install --frozen-lockfile --prod

COPY . .
RUN mkdir -p /app/data/jobs && chown -R node:node /app
USER node

EXPOSE 10000
CMD ["node", "server.js"]
