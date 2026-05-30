FROM ghcr.io/puppeteer/puppeteer:latest
USER root
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3000
CMD ["node", "index.js"]
