FROM apify/actor-node:20

COPY package*.json ./
RUN npm install --include=dev

COPY . ./
RUN npm run build
RUN npm prune --omit=dev

CMD ["node", "dist/main.js"]
