const express = require('express');
const puppeteer = require('puppeteer');
const pdfParse = require('pdf-parse');

const app = express();
app.use(express.json({ limit: '50mb' }));

// =========================================================================
// HELPER: ensina o pdf-parse a marcar a quebra de paginas
// =========================================================================
function render_page(pageData) {
    return pageData.getTextContent().then(function (textContent) {
        let text = '';
        for (let item of textContent.items) {
            text += item.str + ' ';
        }
        return text + '\n---PAGE_BREAK---\n';
    });
}

// =========================================================================
// HELPER: normaliza texto para busca de ancora
// Mantem letras, numeros e o "#".
// O "#" final funciona como DELIMITADOR e elimina a colisao de substring:
//   "#ANCCAP21#" deixa de casar dentro de "#ANCCAP211#"
// =========================================================================
function normalizarAncora(texto) {
    return texto.replace(/[^a-zA-Z0-9#]/g, '');
}

app.post('/gerar-pdf', async (req, res) => {
    console.log("🚀 Nova requisição de PDF recebida.");
    let browser;

    try {
        // -----------------------------------------------------------------
        // VALIDACAO DE ENTRADA
        // Sem isso, um payload malformado gera TypeError e vira 500 generico.
        // -----------------------------------------------------------------
        if (!req.body || typeof req.body.html !== 'string' || req.body.html.trim() === '') {
            console.error("⚠️ Requisição inválida: campo 'html' ausente ou vazio.");
            return res.status(400).json({
                erro: "O campo 'html' é obrigatório e deve ser um texto não vazio."
            });
        }

        // -----------------------------------------------------------------
        // PARAMETROS (todos com fallback = retrocompatibilidade total)
        // Se o botao/fluxo ainda nao enviarem os campos novos,
        // a API continua funcionando exatamente como antes.
        // -----------------------------------------------------------------
        let htmlContent = req.body.html;
        const headerRaw = req.body.cabecalho || '<div></div>';
        const footerRaw = req.body.rodape || '<div></div>';

        const mTop = req.body.margemTop || '10mm';
        const mBottom = req.body.margemBottom || '55mm';
        const mLateral = req.body.margemLateral || '15mm';   // NOVO
        const tamanhoPapel = req.body.tamanhoPapel || 'A4';  // NOVO

        // PermiteLandscape: aceita booleano, "true"/"false", "Sim"/"Não"
        const permiteLandscapeRaw = req.body.permiteLandscape;
        const permiteLandscape =
            permiteLandscapeRaw === true ||
            String(permiteLandscapeRaw).toLowerCase() === 'true' ||
            String(permiteLandscapeRaw).toLowerCase() === 'sim';

        console.log(`⚙️ Config: papel=${tamanhoPapel} | top=${mTop} | bottom=${mBottom} | lateral=${mLateral} | landscape=${permiteLandscape}`);

        // -----------------------------------------------------------------
        // SUBSTITUICAO DE PLACEHOLDERS NO CABECALHO E RODAPE
        // O template no SharePoint usa [MARGEM_LATERAL] no padding.
        // Assim cabecalho, rodape e corpo ficam sempre alinhados.
        // -----------------------------------------------------------------
        const headerHtml = headerRaw.split('[MARGEM_LATERAL]').join(mLateral);
        const footerHtml = footerRaw.split('[MARGEM_LATERAL]').join(mLateral);

        // -----------------------------------------------------------------
        // BLOCO @page GERADO PELA API
        // Fonte unica da verdade da geometria da pagina.
        // Os valores sao IDENTICOS aos de pdfOptions, para que ligar
        // preferCSSPageSize nao altere o layout atual.
        //
        // A pagina nomeada "paisagem" so e emitida se o cliente permitir.
        // Para usar: basta a div do capitulo receber class='pagina-paisagem'
        // -----------------------------------------------------------------
        const cssPaisagem = permiteLandscape
            ? `
    @page paisagem {
        size: ${tamanhoPapel} landscape;
        margin: ${mTop} ${mLateral} ${mBottom} ${mLateral};
    }
    .pagina-paisagem { page: paisagem; }
`
            : `
    /* Landscape desabilitado para este template (PermiteLandscape = Nao).
       A classe existe mas nao troca a orientacao. */
    .pagina-paisagem { page: auto; }
`;

        const blocoGeometria = `
<style id="geometria-pagina-api">
    @page {
        size: ${tamanhoPapel} portrait;
        margin: ${mTop} ${mLateral} ${mBottom} ${mLateral};
    }
${cssPaisagem}
</style>
`;

        // Injeta a geometria no INICIO do HTML, antes de qualquer outro estilo.
        htmlContent = blocoGeometria + htmlContent;

        // -----------------------------------------------------------------
        // OPCOES DO PUPPETEER
        // preferCSSPageSize: true faz o Chromium respeitar o @page acima.
        // E o que habilita a pagina nomeada (landscape) funcionar.
        // -----------------------------------------------------------------
        const pdfOptions = {
            format: tamanhoPapel,
            printBackground: true,
            displayHeaderFooter: true,
            headerTemplate: headerHtml,
            footerTemplate: footerHtml,
            margin: { top: mTop, bottom: mBottom, right: mLateral, left: mLateral },
            preferCSSPageSize: true,
            timeout: 120000
        };

        browser = await puppeteer.launch({
            headless: 'new',
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote']
        });

        const page = await browser.newPage();

        // =================================================================
        // MOTOR DE INDICE INTELIGENTE (TWO-PASS RENDERING)
        // =================================================================
        if (htmlContent.includes('#ANC_')) {
            console.log("🔍 Âncoras detectadas! Iniciando motor de índice...");

            // 1o PASSO: gera o "PDF Fantasma" apenas na memoria
            await page.setContent(htmlContent, { waitUntil: 'networkidle0', timeout: 120000 });
            const ghostPdfBuffer = await page.pdf(pdfOptions);
            console.log("👻 PDF Fantasma gerado.");

            // 2o PASSO: le o texto pagina a pagina
            const pdfData = await pdfParse(ghostPdfBuffer, { pagerender: render_page });
            const pages = pdfData.text.split('\n---PAGE_BREAK---\n');
            console.log(`📄 PDF Fantasma tem ${pages.length - 1} páginas válidas.`);

            // Normaliza as paginas UMA unica vez (evita reprocessar por ancora)
            const pagesNormalizadas = pages.map(p => normalizarAncora(p));

            // 3o PASSO: troca os placeholders {{PAG_...}} pelo numero real
            const anchors = htmlContent.match(/#ANC_[A-Za-z0-9_]+#/g);

            if (anchors) {
                const uniqueAnchors = [...new Set(anchors)];
                console.log(`🎯 Âncoras detectadas no HTML:`, uniqueAnchors);

                uniqueAnchors.forEach(anchor => {
                    // Mantem o "#" nas pontas -> delimitador -> sem colisao
                    const pureAnchor = normalizarAncora(anchor);

                    const pageNum = pagesNormalizadas.findIndex(pText =>
                        pText.includes(pureAnchor)
                    ) + 1;

                    const placeholder = anchor.replace('#ANC_', '{{PAG_').replace('#', '}}');

                    if (pageNum > 0) {
                        console.log(`✅ Âncora ${anchor} -> Página ${pageNum}`);
                        htmlContent = htmlContent.split(placeholder).join(pageNum);
                    } else {
                        console.log(`❌ Âncora ${anchor} não encontrada. Placeholder será limpo.`);
                    }

                    // A ancora invisivel sai do HTML final em qualquer cenario
                    htmlContent = htmlContent.split(anchor).join('');
                });
            }

            // -------------------------------------------------------------
            // FALLBACK: limpa qualquer {{PAG_...}} que tenha sobrado.
            // Sem isso, uma ancora nao encontrada deixaria texto cru no indice.
            // -------------------------------------------------------------
            const orfaos = htmlContent.match(/\{\{PAG_[A-Za-z0-9_]+\}\}/g);
            if (orfaos) {
                const orfaosUnicos = [...new Set(orfaos)];
                console.log(`🧹 Limpando ${orfaosUnicos.length} placeholder(s) órfão(s):`, orfaosUnicos);
                orfaosUnicos.forEach(o => {
                    htmlContent = htmlContent.split(o).join('-');
                });
            }

        } else {
            console.log("⏩ Nenhuma âncora encontrada, gerando direto.");
        }

        // =================================================================
        // IMPRESSAO FINAL
        // =================================================================
        console.log("🖨️ Imprimindo PDF Final...");
        await page.setContent(htmlContent, { waitUntil: 'networkidle0', timeout: 120000 });
        const finalPdfBuffer = await page.pdf(pdfOptions);

        console.log("🎉 PDF Finalizado e enviado ao Power Automate!");
        res.json({ pdfBase64: finalPdfBuffer.toString('base64') });

    } catch (error) {
        console.error("🚨 Erro Fatal:", error);
        res.status(500).json({ erro: error.toString() });
    } finally {
        if (browser) await browser.close();
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Ativo na porta ${PORT}`));
