FROM node:18-alpine

# Instala o Chromium e todas as dependências nativas para rodar sem travar
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    nodejs \
    npm

WORKDIR /app

COPY package*.json ./

# Proíbe o Puppeteer de baixar o Chrome quebrado e aponta para o que acabamos de instalar
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

RUN npm install

COPY . .

EXPOSE 3000

CMD ["node", "index.js"]
