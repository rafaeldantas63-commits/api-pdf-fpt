FROM node:18-alpine

# Instala o Chromium e todas as dependências nativas para rodar sem travar.
#
# CORRIGIDO (auditoria item #7): removidas as entradas "nodejs" e "npm"
# desta lista. A imagem base "node:18-alpine" JA vem com Node.js e npm
# instalados na versão correta (18.x). Reinstalar "nodejs"/"npm" via apk
# baixava a versão do repositório Alpine, que pode ser diferente da
# versão 18 da imagem base, sobrescrevendo-a.
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

# =========================================================================
# AJUSTE DE MEMÓRIA (novo)
#
# --expose-gc     : habilita global.gc(), usado pela função liberarMemoria()
#                   do index.js para devolver memória ao sistema logo após
#                   cada segmento renderizado, em vez de esperar o coletor
#                   automático decidir sozinho. Sem esta flag, a função
#                   simplesmente não faz nada (há uma guarda no código).
#
# --max-old-space-size=460 : limita o heap do Node a ~460 MB. No plano
#                   básico do Render a instância tem pouca RAM e precisa
#                   dividi-la com o Chromium. Sem o teto, o Node tenta
#                   crescer até estourar o limite do container e o processo
#                   é morto de fora, sem log de erro (exatamente o sintoma
#                   observado: "Ativo na porta 10000" reaparecendo no meio
#                   da renderização). Com o teto, o Node passa a coletar
#                   lixo antes de chegar nesse ponto.
# =========================================================================
ENV NODE_OPTIONS="--expose-gc --max-old-space-size=460"

RUN npm install

COPY . .

EXPOSE 3000

CMD ["node", "index.js"]
