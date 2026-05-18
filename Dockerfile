# Stage 1: Build & install dependencies
FROM node:20-alpine AS builder

WORKDIR /usr/src/app

# Copy package descriptors first to cache NPM dependencies layers
COPY package*.json ./

# Install only production dependencies (clean install)
RUN npm ci --only=production

# Stage 2: Minimal runtime image
FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /usr/src/app

# Copy only installed node_modules and metadata from the builder
COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY --from=builder /usr/src/app/package*.json ./

# Copy application source code
COPY . .

# Run under a non-root system user for container security hardening
USER node

# Expose internal service port
EXPOSE 3445

# Define container entrypoint command
CMD ["npm", "start"]
