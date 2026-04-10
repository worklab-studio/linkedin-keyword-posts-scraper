# Lightweight Node.js image (no browser needed)
FROM apify/actor-node:20

COPY package*.json ./
RUN npm install --include=dev

COPY . ./
RUN npm run build

# Remove dev dependencies to slim the image
RUN npm prune --omit=dev

CMD ["node", "dist/main.js"]
