const express = require('express');
const puppeteer = require('puppeteer');
const pdfParse = require('pdf-parse');
const { PDFDocument, degrees } = require('pdf-lib');

const app = express();
app.use(express.json({ limit: '50mb' }));

// =========================================================================
// CONFIGURACAO: quais ancoras devem ter sua pagina final rotacionada
// no PDF (rotacao nativa via pdf-lib, aplicada DEPOIS de gerado o PDF).
// Para adicionar um novo capitulo em paisagem no futuro, basta incluir
// uma nova linha aqui - nao precisa mexer em mais nada.
// =========================================================================
const ANCORAS_PARA_ROTACIONAR = {
    '#ANC_CAP_3_2_11#': 90
};

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
// Mantem letras, numeros e o "#". O "#" final funciona como DELIMITADOR:
// "#ANCCAP21#" deixa de casar dentro de "#ANCCAP211#"
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
        // -----------------------------------------------------------------
        if (!req.body || typeof req.body.html !== 'string' || req.body.html.trim() === '') {
            console.error("⚠️ Requisição inválida: campo 'html' ausente ou vazio.");
            return res.status(400).json({
                erro: "O campo 'html' é obrigatório e deve ser um texto não vazio."
            });
        }

        // -----------------------------------------------------------------
        // PARAMETROS (todos com fallback = retrocompatibilidade total)
        // -----------------------------------------------------------------
        let htmlContent = req.body.html;
        const headerRaw = req.body.cabecalho || '<div></div>';
        const footerRaw = req.body.rodape || '<div></div>';

        const mTop = req.body.margemTop || '10mm';
        const mBottom = req.body.margemBottom || '55mm';
        const mLateral = req.body.margemLateral || '15mm';
        const tamanhoPapel = req.body.tamanhoPapel || 'A4';

        console.log(`⚙️ Config: papel=${tamanhoPapel} | top=${mTop} | bottom=${mBottom} | lateral=${mLateral}`);

        // -----------------------------------------------------------------
        // SUBSTITUICAO DE PLACEHOLDERS NO CABECALHO E RODAPE
        // -----------------------------------------------------------------
        const headerHtml = headerRaw.split('[MARGEM_LATERAL]').join(mLateral);
        const footerHtml = footerRaw.split('[MARGEM_LATERAL]').join(mLateral);

        // -----------------------------------------------------------------
        // BLOCO DE GEOMETRIA + CONTENCAO DE LARGURA
        // -----------------------------------------------------------------
        const blocoGeometria = `
<style id="geometria-pagina-api">
    @page {
        size: ${tamanhoPapel} portrait;
        margin: ${mTop} ${mLateral} ${mBottom} ${mLateral};
    }

    html, body {
        margin: 0;
        padding: 0;
        width: 100%;
    }

    .wrapper-table {
        table-layout: fixed !important;
        width: 100% !important;
        max-width: 100% !important;
    }

    table {
        max-width: 100% !important;
    }

    th, td {
        overflow-wrap: break-word;
        word-wrap: break-word;
    }
</style>
`;

        htmlContent = blocoGeometria + htmlContent;

        // -----------------------------------------------------------------
        // OPCOES DO PUPPETEER
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

        // Guarda o numero de pagina de cada ancora marcada para rotacao
        const paginasParaRotacionar = {}; // { anchorString: numeroDaPagina, ... }

        // =================================================================
        // MOTOR DE INDICE INTELIGENTE (TWO-PASS RENDERING)
        // =================================================================
        if (htmlContent.includes('#ANC_')) {
            console.log("🔍 Âncoras detectadas! Iniciando motor de índice...");

            await page.setContent(htmlContent, { waitUntil: 'networkidle0', timeout: 120000 });
            const ghostPdfBuffer = await page.pdf(pdfOptions);
            console.log("👻 PDF Fantasma gerado.");

            const pdfData = await pdfParse(ghostPdfBuffer, { pagerender: render_page });
            const pages = pdfData.text.split('\n---PAGE_BREAK---\n');
            console.log(`📄 PDF Fantasma tem ${pages.length - 1} páginas válidas.`);

            const pagesNormalizadas = pages.map(p => normalizarAncora(p));

            const anchors = htmlContent.match(/#ANC_[A-Za-z0-9_]+#/g);

            if (anchors) {
                const uniqueAnchors = [...new Set(anchors)];
                console.log(`🎯 Âncoras detectadas no HTML:`, uniqueAnchors);

                uniqueAnchors.forEach(anchor => {
                    const pureAnchor = normalizarAncora(anchor);

                    const pageNum = pagesNormalizadas.findIndex(pText =>
                        pText.includes(pureAnchor)
                    ) + 1;

                    const placeholder = anchor.replace('#ANC_', '{{PAG_').replace('#', '}}');

                    if (pageNum > 0) {
                        console.log(`✅ Âncora ${anchor} -> Página ${pageNum}`);
                        htmlContent = htmlContent.split(placeholder).join(pageNum);

                        // Se esta ancora estiver na lista de rotacao, guarda a pagina
                        if (ANCORAS_PARA_ROTACIONAR.hasOwnProperty(anchor)) {
                            paginasParaRotacionar[anchor] = pageNum;
                            console.log(`🔄 Página ${pageNum} marcada para rotação (${ANCORAS_PARA_ROTACIONAR[anchor]}°) por causa de ${anchor}`);
                        }
                    } else {
                        console.log(`❌ Âncora ${anchor} não encontrada. Placeholder será limpo.`);
                    }

                    htmlContent = htmlContent.split(anchor).join('');
                });
            }

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
        let finalPdfBuffer = await page.pdf(pdfOptions);

        // =================================================================
        // ROTACAO NATIVA DE PAGINAS (via pdf-lib)
        //
        // Aplica a propriedade /Rotate do PDF na(s) p
