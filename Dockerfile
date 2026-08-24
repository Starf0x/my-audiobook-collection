FROM node:26-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
ENV DATA_DIR=/data PORT=8080
VOLUME /data
EXPOSE 8080

# Unraid reads these off the image, so the WebUI link, the icon and Force update
# work even for a container that was not created from the template.
LABEL net.unraid.docker.managed="dockerman" \
      net.unraid.docker.webui="http://[IP]:[PORT:8080]/" \
      net.unraid.docker.icon="https://raw.githubusercontent.com/Starf0x/my-audiobook-collection/main/public/icon.png" \
      org.opencontainers.image.title="My Audiobook Collection" \
      org.opencontainers.image.description="Browse and play an audiobook collection organised as Genre / Author / (Series) / Book" \
      org.opencontainers.image.source="https://github.com/Starf0x/my-audiobook-collection"

CMD ["node", "server/index.js"]
