FROM node:26-alpine
# ffmpeg brings ffprobe with it: converting .m4b and .ogg books to MP3 needs both,
# and the alpine package is the build for whatever architecture this image is.
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
ENV DATA_DIR=/data PORT=8523
VOLUME /data
EXPOSE 8523

# Unraid reads these off the image, so the WebUI link, the icon and Force update
# work even for a container that was not created from the template. Unraid fetches
# the icon over HTTP, so this URL has to stay publicly reachable: anything it
# cannot fetch is retried on every page refresh and the icon blinks.
LABEL net.unraid.docker.managed="dockerman" \
      net.unraid.docker.webui="http://[IP]:[PORT:8523]/" \
      net.unraid.docker.icon="https://raw.githubusercontent.com/Starf0x/my-audiobook-collection/main/public/icon-128.png" \
      org.opencontainers.image.title="My Audiobook Collection" \
      org.opencontainers.image.description="Browse and play an audiobook collection organised as Genre / Author / (Series) / Book" \
      org.opencontainers.image.source="https://github.com/Starf0x/my-audiobook-collection"

CMD ["node", "server/index.js"]
