FROM node:24-trixie-slim@sha256:389d8378d70ee3fbd97d75f1e9dbf89c5fcd19e7da8c0e27997512df77db4fef AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:24-trixie-slim@sha256:389d8378d70ee3fbd97d75f1e9dbf89c5fcd19e7da8c0e27997512df77db4fef AS runtime
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates ffmpeg tini \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /usr/local/lib/node_modules /opt/yarn-* \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
        /usr/local/bin/yarn /usr/local/bin/yarnpkg \
    && mkdir /data && chown node:node /data && chmod 0700 /data
WORKDIR /app
ENV NODE_ENV=production PORT=7000 LOG_FILE=off FFPROBE_PATH=ffprobe
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist/src ./dist/src
COPY --chown=node:node package.json LICENSE ./
COPY --chown=node:node docker/healthcheck.cjs ./docker/healthcheck.cjs
USER node
EXPOSE 7000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["node", "docker/healthcheck.cjs"]
ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
CMD ["node", "dist/src/index.js"]
