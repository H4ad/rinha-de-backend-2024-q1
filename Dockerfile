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
COPY commands ./commands

# Build
RUN npm run build

FROM builder AS deps

# Install deps for production
RUN npm ci --ignore-scripts --production && npm cache clean --force

FROM node:20-alpine AS runner

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
