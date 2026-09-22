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

RUN npm install

COPY . .

EXPOSE 3000

# =========================================================================
# FLAGS DE MEMÓRIA DO NODE
#
# As duas flags ficam AQUI no CMD, e não em ENV NODE_OPTIONS, por dois
# motivos:
#
# 1) --expose-gc é REJEITADA pelo Node quando vem por NODE_OPTIONS
#    ("--expose-gc is not allowed in NODE_OPTIONS"). Isso quebra até o
#    "npm install" durante o build da imagem.
#
# 2) Flags passadas na linha de comando SOBRESCREVEM o NODE_OPTIONS
#    inteiro. Se o limite de heap ficasse no ENV e o --expose-gc no CMD,
#    o limite seria ignorado silenciosamente. Mantendo as duas juntas
#    aqui, ambas são efetivamente aplicadas.
#
# O que cada uma faz:
#   --expose-gc  : habilita global.gc(), usado pela função
#                  liberarMemoria() do index.js para devolver memória ao
#                  sistema logo após cada segmento renderizado. Se esta
#                  flag for removida, o código continua funcionando -
#                  há uma guarda "if (global.gc)" que ignora a chamada.
#
#   --max-old-space-size=460 : limita o heap do Node a ~460 MB. No plano
#                  básico do Render a instância tem pouca RAM e precisa
#                  dividi-la com o Chromium. Sem o teto, o Node cresce
#                  até estourar o limite do container e o processo é
#                  morto de fora, sem log de erro (sintoma observado:
#                  "Ativo na porta 10000" reaparecendo no meio da
#                  renderização). Com o teto, o Node coleta lixo antes
#                  de chegar nesse ponto.
# =========================================================================
CMD ["node", "--expose-gc", "--max-old-space-size=460", "index.js"]
