FROM node:26-alpine
WORKDIR /app
COPY server ./server
COPY web ./web
ENV NODE_ENV=production PORT=8787 SURGE_DATA_DIR=/data
EXPOSE 8787
RUN mkdir /data && chown node:node /data
USER node
CMD ["node", "server/index.mjs"]
