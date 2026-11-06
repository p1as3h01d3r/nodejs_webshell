FROM node:24-alpine

RUN apk add --no-cache tini

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

WORKDIR /app
COPY package.json server.js ./
RUN node --check server.js

USER 1000:1000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["/sbin/tini", "-s", "--"]
CMD ["node", "server.js"]
