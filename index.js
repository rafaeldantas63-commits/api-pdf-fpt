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

        const permiteLandscapeRaw = req.body.permiteLandscape;
        const permiteLandscape =
            permiteLandscapeRaw === true ||
            String(permiteLandscapeRaw).toLowerCase() === 'true' ||
            String(permiteLandscapeRaw).toLowerCase() === 'sim';

        console.log(`⚙️ Config: papel=${tamanhoPapel} | top=${mTop} | bottom=${mBottom} | lateral=${mLateral} | landscape=${permiteLandscape}`);

        // -----------------------------------------------------------------
        // SUBSTITUICAO DE PLACEHOLDERS NO CABECALHO E RODAPE
        // -----------------------------------------------------------------
        const headerHtml = headerRaw.split('[MARGEM_LATERAL]').join(mLateral);
        const footerHtml = footerRaw.split('[MARGEM_LATERAL]').join(mLateral);

        // -----------------------------------------------------------------
        // CSS DE PAISAGEM (so emitido se o cliente permitir)
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
    /* Landscape desabilitado para este template (PermiteLandscape = Nao). */
    .pagina-paisagem { page: auto; }
`;

        // -----------------------------------------------------------------
        // BLOCO DE GEOMETRIA + CONTENCAO DE LARGURA
        //
        // A CORRECAO PRINCIPAL ESTA AQUI:
        // O documento inteiro fica dentro de uma unica <table class='wrapper-table'>.
        // Com table-layout:auto o navegador calcula UMA largura para a tabela
        // toda, baseada no conteudo MAIS LARGO (ex.: tabela de IPs com 11 colunas).
        // Essa largura vale para TODAS as linhas -> TODAS as paginas ficam largas
        // demais e sao cortadas na margem.
        //
        // table-layout:fixed obriga a wrapper a respeitar width:100%,
        // eliminando o efeito domino.
        // -----------------------------------------------------------------
        const blocoGeometria = `
<style id="geometria-pagina-api">
    @page {
        size: ${tamanhoPapel} portrait;
        margin: ${mTop} ${mLateral} ${mBottom} ${mLateral};
    }
${cssPaisagem}

    /* --- CONTENCAO DE LARGURA --- */

    html, body {
        margin: 0;
        padding: 0;
        width: 100%;
    }

    /* A tabela "casca" que envolve o documento inteiro */
    .wrapper-table {
        table-layout: fixed !important;
        width: 100% !important;
        max-width: 100% !important;
    }

    /* Nenhuma tabela interna pode ultrapassar a largura util */
    table {
        max-width: 100% !important;
    }

    /* Permite quebrar palavras longas em vez de estourar a celula */
    th, td {
        overflow-wrap: break-word;
        word-wrap: break-word;
    }
</style>
`;

        // Injeta a geometria no INICIO do HTML, antes de qualquer outro estilo.
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

            // Normaliza as paginas UMA unica vez
            const pagesNormalizadas = pages.map(p => normalizarAncora(p));

            // 3o PASSO: troca os placeholders {{PAG_...}} pelo numero real
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
                    } else {
                        console.log(`❌ Âncora ${anchor} não encontrada. Placeholder será limpo.`);
                    }

                    // A ancora invisivel sai do HTML final em qualquer cenario
                    htmlContent = htmlContent.split(anchor).join('');
                });
            }

            // -------------------------------------------------------------
            // FALLBACK: limpa qualquer {{PAG_...}} que tenha sobrado
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
