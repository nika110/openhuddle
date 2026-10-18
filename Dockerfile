FROM node:24-alpine

WORKDIR /app
COPY package.json LICENSE ./
COPY bin ./bin
COPY src ./src

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8787/health || exit 1

# Set OPENHUDDLE_PUBLIC_URL to the address people use to reach this hub (used in invite links).
CMD ["node", "bin/openhuddle.js", "hub", "--port", "8787", "--db", "/data/hub.db"]
