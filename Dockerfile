FROM node:26-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
ENV DATA_DIR=/data PORT=8080
VOLUME /data
EXPOSE 8080

# Unraid reads these off the image, so the WebUI link and Force update work even
# for a container that was not created from the template. No icon label: Unraid
# fetches an icon value over HTTP, so anything it cannot fetch (a private repo
# URL, a data URI) is retried on every page refresh and the icon blinks. Set the
# icon in the container's "Icon URL" field, e.g. http://TOWER-IP:8080/icon.png,
# which this app serves itself.
LABEL net.unraid.docker.managed="dockerman" \
      net.unraid.docker.webui="http://[IP]:[PORT:8080]/" \
      org.opencontainers.image.title="My Audiobook Collection" \
      org.opencontainers.image.description="Browse and play an audiobook collection organised as Genre / Author / (Series) / Book" \
      org.opencontainers.image.source="https://github.com/Starf0x/my-audiobook-collection"

CMD ["node", "server/index.js"]
