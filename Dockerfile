# Use Apify's official Node.js actor image with Playwright support
FROM apify/actor-node-playwright-chrome:20

# Copy package files and install dependencies (cached layer)
COPY package*.json ./
RUN npm install --include=dev

# Install playwright browsers
RUN npx playwright install chromium

# Copy source and build TypeScript
COPY . ./
RUN npm run build

# Run the actor
CMD ["node", "dist/main.js"]
