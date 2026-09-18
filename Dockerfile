FROM node:18-alpine

# Instala o Chromium e todas as dependências nativas para rodar sem travar.
#
# CORRIGIDO (auditoria item #7): removidas as entradas "nodejs" e "npm"
# desta lista. A imagem base "node:18-alpine" JA vem com Node.js e npm
# instalados na versão correta (18.x). Reinstalar "nodejs"/"npm" via apk
# (gerenciador de pacotes do Alpine) baixava a versão que o repositório
# Alpine tiver disponível no momento - que pode ser DIFERENTE (mais nova
# ou mais antiga) da versão 18 da imagem base, sobrescrevendo-a. Isso é
# redundante na melhor hipótese, e uma fonte de inconsistência de versão
# na pior hipótese (ex.: build funcionando num dia e quebrando no outro,
# por causa de uma atualização silenciosa do pacote "nodejs" do Alpine).
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont

WORKDIR /app

COPY package*.json ./

# Proíbe o Puppeteer de baixar o Chrome quebrado e aponta para o que
# acabamos de instalar.
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

RUN npm install

COPY . .

EXPOSE 3000

CMD ["node", "index.js"]
