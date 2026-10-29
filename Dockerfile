# Stage 1: Build static SPA bundle
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies from public npm registry (workstation package-lock.json contains internal airlock-proxy URLs)
COPY package.json ./
RUN npm install --registry=https://registry.npmjs.org --no-audit --no-fund

# Copy application source and root config files referenced by TypeScript build
COPY index.html postcss.config.js tailwind.config.js tsconfig.json vite.config.ts README.md Dockerfile nginx.conf .dockerignore ./
COPY src ./src
COPY google-sheets-addon ./google-sheets-addon

# Explicitly ensure no default OAuth token or tenant overrides are baked into the public bundle
ENV VITE_DEFAULT_ACCESS_TOKEN="" \
    VITE_DEFAULT_DOMAIN="" \
    VITE_DEFAULT_GCP_PROJECT=""

RUN npm run build

# Stage 2: Hardened static file server for Google Cloud Run
FROM nginx:1.27-alpine AS production

# Remove default Nginx config and install hardened Cloud Run config (port 8080)
RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy compiled static SPA assets
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]
