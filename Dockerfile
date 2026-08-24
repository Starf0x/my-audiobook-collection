FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
ENV DATA_DIR=/data PORT=8080
VOLUME /data
EXPOSE 8080
CMD ["node", "server/index.js"]
