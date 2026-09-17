const express = require('express');
const puppeteer = require('puppeteer');
const pdfParse = require('pdf-parse');
const { PDFDocument, degrees } = require('pdf-lib');

const app = express();
app.use(express.json({ limit: '50mb' }));

// =========================================================================
// CONFIGURACAO: quais ancoras devem ter sua pagina final rotacionada.
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
// =========================================================================
function normalizarAncora(texto) {
    return texto.replace(/[^a-zA-Z0-9#]/g, '');
}

// =========================================================================
// HELPER: dado um buffer de PDF, retorna um array com o texto normalizado
// de cada pagina (para busca de ancoras).
// =========================================================================
async function getPaginasNormalizadas(pdfBuffer) {
    const pdfData = await pdfParse(pdfBuffer, { pagerender: render_page });
    const pages = pdfData.text.split('\n---PAGE_BREAK---\n');
    return pages.map(p => normalizarAncora(p));
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

        // =================================================================
        // MOTOR DE INDICE INTELIGENTE (TWO-PASS RENDERING)
        // =================================================================
        if (htmlContent.includes('#ANC_')) {
            console.log("🔍 Âncoras detectadas! Iniciando motor de índice...");

            // 1o PASSO: gera o "PDF Fantasma" apenas na memoria
            await page.setContent(htmlContent, { waitUntil: 'networkidle0', timeout: 120000 });
            const ghostPdfBuffer = await page.pdf(pdfOptions);
            console.log("👻 PDF Fantasma gerado.");

            const pagesNormalizadas = await getPaginasNormalizadas(ghostPdfBuffer);
            console.log(`📄 PDF Fantasma tem ${pagesNormalizadas.length - 1} páginas válidas.`);

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
                        console.log(`✅ Âncora ${anchor} -> Página ${pageNum} (estimativa via PDF fantasma)`);
                        htmlContent = htmlContent.split(placeholder).join(pageNum);
                    } else {
                        console.log(`❌ Âncora ${anchor} não encontrada. Placeholder será limpo.`);
                    }

                    // -----------------------------------------------------
                    // IMPORTANTE: as ancoras marcadas para ROTACAO NAO sao
                    // removidas agora. Elas precisam sobreviver ate o PDF
                    // FINAL, para que possamos reconferir a pagina real
                    // depois (o PDF fantasma pode ter uma paginacao
                    // ligeiramente diferente do PDF final, por causa da
                    // diferenca de largura entre o placeholder longo e o
                    // numero curto no indice - isso pode deslocar a
                    // contagem de TODAS as paginas seguintes).
                    // Como a ancora e invisivel (opacity:0.02), mante-la
                    // nao tem nenhum efeito visual no PDF.
                    // -----------------------------------------------------
                    if (!ANCORAS_PARA_ROTACIONAR.hasOwnProperty(anchor)) {
                        htmlContent = htmlContent.split(anchor).join('');
                    }
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
        let finalPdfBuffer = await page.pdf(pdfOptions);

        // =================================================================
        // ROTACAO NATIVA DE PAGINAS (via pdf-lib) - COM RECONFERENCIA REAL
        //
        // Em vez de confiar no numero de pagina calculado no PDF FANTASMA
        // (que pode estar deslocado por causa do reflow do indice), a API
        // agora RE-ABRE o PDF FINAL ja gerado e procura a ancora ali dentro,
        // descobrindo a pagina REAL onde o capitulo caiu de verdade.
        // Isso elimina qualquer erro de deslocamento entre as duas passagens.
        // =================================================================
        const chavesRotacao = Object.keys(ANCORAS_PARA_ROTACIONAR);
        const rotacoesEncontradas = {};

        if (chavesRotacao.length > 0) {
            console.log("🔎 Reconferindo página real das âncoras de rotação no PDF final...");
            const paginasFinaisNormalizadas = await getPaginasNormalizadas(finalPdfBuffer);

            chavesRotacao.forEach(anchor => {
                const pureAnchor = normalizarAncora(anchor);
                const paginaReal = paginasFinaisNormalizadas.findIndex(pText =>
                    pText.includes(pureAnchor)
                ) + 1;

                if (paginaReal > 0) {
                    rotacoesEncontradas[anchor] = paginaReal;
                    console.log(`✅ Página REAL confirmada para ${anchor}: página ${paginaReal} do PDF final.`);
                } else {
                    console.log(`⚠️ Âncora ${anchor} não encontrada no PDF final. Rotação não será aplicada.`);
                }
            });

            // Remove as ancoras de rotacao do HTML (nao sao mais necessarias,
            // mas como sao invisiveis, isso e so uma limpeza de cortesia -
            // nao teria efeito visual mesmo se ficassem).
            chavesRotacao.forEach(anchor => {
                htmlContent = htmlContent.split(anchor).join('');
            });
        }

        // Se alguma ancora de rotacao foi encontrada, re-renderiza o PDF
        // final sem as ancoras (limpeza) e aplica a rotacao nativa.
        if (Object.keys(rotacoesEncontradas).length > 0) {
            await page.setContent(htmlContent, { waitUntil: 'networkidle0', timeout: 120000 });
            finalPdfBuffer = await page.pdf(pdfOptions);

            console.log("🔄 Aplicando rotação nativa de página via pdf-lib...");
            const pdfDoc = await PDFDocument.load(finalPdfBuffer);
            const pdfPages = pdfDoc.getPages();

            Object.keys(rotacoesEncontradas).forEach(anchor => {
                const numeroPagina = rotacoesEncontradas[anchor];
                const graus = ANCORAS_PARA_ROTACIONAR[anchor];

                if (numeroPagina > 0 && numeroPagina <= pdfPages.length) {
                    pdfPages[numeroPagina - 1].setRotation(degrees(graus));
                    console.log(`✅ Página ${numeroPagina} rotacionada em ${graus}°.`);
                } else {
                    console.log(`⚠️ Não foi possível rotacionar: página ${numeroPagina} fora do intervalo (total: ${pdfPages.length}).`);
                }
            });

            finalPdfBuffer = Buffer.from(await pdfDoc.save());
        }

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
