FROM node:22-alpine

ENV NODE_ENV=production \
    DEV_MODE=false \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/data

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY core/ ./core/
COPY server/ ./server/
COPY web/ ./web/
RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 8787
CMD ["node", "server/index.js"]
