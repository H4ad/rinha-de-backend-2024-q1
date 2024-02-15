FROM node:20-alpine AS builder_deps

# Create app directory
WORKDIR /usr/src/app

COPY package*.json ./
COPY tsconfig.json ./

# Install deps
RUN npm ci

FROM builder_deps AS builder

# Create app directory
WORKDIR /usr/src/app

# Copy all files
COPY src ./src

# Build
RUN npm run build

FROM builder AS deps

# Install deps for production
RUN npm ci --ignore-scripts --production && npm cache clean --force

FROM node:20-alpine AS runner_deps

# Because of health check
RUN apk add --update curl && \
    rm -rf /var/cache/apk/*

FROM runner_deps as runner

# Set Node Env
ENV NODE_ENV=production

# Create app directory
WORKDIR /usr/src/app

# Copy builded API
COPY --from=deps /usr/src/app/node_modules ./node_modules
COPY --from=builder_deps /usr/src/app/package.json ./package.json
COPY --from=builder /usr/src/app/dist ./dist

EXPOSE 3000
CMD [ "node", "dist/index.js" ]
