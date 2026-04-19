FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
RUN npm run build:dashboard

FROM node:20-alpine
WORKDIR /app
RUN addgroup -S ccmux && adduser -S -G ccmux ccmux
COPY --from=build --chown=ccmux:ccmux /app/dist ./dist
COPY --from=build --chown=ccmux:ccmux /app/src/dashboard/frontend/dist ./src/dashboard/frontend/dist
COPY --from=build --chown=ccmux:ccmux /app/src/policy/recipes ./src/policy/recipes
COPY --from=build --chown=ccmux:ccmux /app/package.json ./
COPY --from=build --chown=ccmux:ccmux /app/package-lock.json ./
COPY --from=build --chown=ccmux:ccmux /app/bin ./bin
RUN npm ci --omit=dev
USER ccmux
EXPOSE 8787
ENTRYPOINT ["node", "bin/ccmux.js"]
CMD ["start", "--foreground"]
