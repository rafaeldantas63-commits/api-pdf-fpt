const express = require('express');
const puppeteer = require('puppeteer');
const pdfParse = require('pdf-parse');
const { PDFDocument } = require('pdf-lib');

const app = express();
app.use(express.json({ limit: '50mb' }));

// =========================================================================
// MARCADORES USADOS PARA IDENTIFICAR BLOCOS EM PAISAGEM.
// Sao simples comentarios HTML, invisiveis, inseridos pelo Power Apps
// (btn_Controle_14) ao redor de qualquer capitulo que deva sair como
// pagina fisica em paisagem. Para adicionar um novo capitulo em
// paisagem no futuro, basta envolve-lo com os MESMOS marcadores -
// nao precisa mexer em mais nada aqui.
// =========================================================================
const LANDSCAPE_START = '<!--LANDSCAPE_START-->';
const LANDSCAPE_END = '<!--LANDSCAPE_END-->';

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
// HELPER: divide o HTML final em segmentos alternados
// [retrato, paisagem, retrato, paisagem, ..., retrato]
// usando busca de STRING simples (nao depende de leitura de PDF,
// portanto e 100% confiavel e imune a qualquer reflow de paginacao).
// =========================================================================
function dividirEmSegmentos(html) {
    const segmentos = [];
    let restante = html;

    while (restante.includes(LANDSCAPE_START)) {
        const [antes, depoisDoInicio] = restante.split(LANDSCAPE_START);
        segmentos.push({ tipo: 'retrato', html: antes });

        const [conteudoPaisagem, depoisDoFim] = depoisDoInicio.split(LANDSCAPE_END);
        segmentos.push({ tipo: 'paisagem', html: conteudoPaisagem });

        restante = depoisDoFim;
    }
    segmentos.push({ tipo: 'retrato', html: restante });

    return segmentos;
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
        // BLOCO DE GEOMETRIA + CONTENCAO DE LARGURA (para paginas RETRATO)
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

        // Opcoes de PDF para paginas em RETRATO (documento principal)
        const pdfOptionsRetrato = {
            format: tamanhoPapel,
            printBackground: true,
            displayHeaderFooter: true,
            headerTemplate: headerHtml,
            footerTemplate: footerHtml,
            margin: { top: mTop, bottom: mBottom, right: mLateral, left: mLateral },
            preferCSSPageSize: true,
            timeout: 120000
        };

        // Opcoes de PDF para paginas em PAISAGEM (papel fisico deitado).
        // NAO usa preferCSSPageSize, pois nao injetamos nenhum @page custom
        // nesse conteudo - deixamos o Puppeteer controlar o tamanho/orientacao
        // nativamente atraves de "landscape:true", que e o metodo confiavel.
        const pdfOptionsPaisagem = {
            format: tamanhoPapel,
            landscape: true,
            printBackground: true,
            displayHeaderFooter: true,
            headerTemplate: headerHtml,
            footerTemplate: footerHtml,
            margin: { top: mTop, bottom: mBottom, right: mLateral, left: mLateral },
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
        //
        // Este passo usa um PDF "fantasma" de TODO o documento (incluindo
        // os marcadores de paisagem, que aqui sao apenas ignorados/tratados
        // como texto invisivel) apenas para descobrir em que pagina cada
        // ancora cai, e assim resolver os {{PAG_CAP_X}} do indice.
        //
        // NOTA/LIMITACAO CONHECIDA: como o PDF fantasma renderiza tudo em
        // retrato continuo (sem separar a secao em paisagem fisica), a
        // contagem de paginas dele pode nao bater 100% com o PDF final
        // (que tera uma pagina fisica diferente para o trecho em
        // paisagem). Isso pode gerar uma pequena divergencia no numero
        // exibido no indice para capitulos MUITO proximos ao trecho em
        // paisagem - um problema ja identificado e que sera tratado
        // separadamente, sem relacao com a orientacao da tabela.
        // =================================================================
        if (htmlContent.includes('#ANC_')) {
            console.log("🔍 Âncoras detectadas! Iniciando motor de índice...");

            await page.setContent(blocoGeometria + htmlContent, { waitUntil: 'networkidle0', timeout: 120000 });
            const ghostPdfBuffer = await page.pdf(pdfOptionsRetrato);
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
        //
        // Se NAO houver marcador de paisagem, gera um unico PDF (caminho
        // simples, igual ao de sempre). Se houver, divide o HTML em
        // segmentos e renderiza CADA UM com a orientacao correta, depois
        // junta tudo em um unico PDF final usando pdf-lib.
        // =================================================================
        let finalPdfBuffer;

        if (!htmlContent.includes(LANDSCAPE_START)) {
            console.log("🖨️ Imprimindo PDF Final (documento único, sem seções em paisagem)...");
            await page.setContent(blocoGeometria + htmlContent, { waitUntil: 'networkidle0', timeout: 120000 });
            finalPdfBuffer = await page.pdf(pdfOptionsRetrato);

        } else {
            console.log("🖨️ Documento contém seção(ões) em paisagem. Renderizando em partes separadas...");
            const segmentos = dividirEmSegmentos(htmlContent);
            const buffersGerados = [];

            for (let i = 0; i < segmentos.length; i++) {
                const seg = segmentos[i];

                if (seg.tipo === 'retrato') {
                    // Segmentos retrato vazios (ex.: quando a secao em
                    // paisagem esta logo no inicio ou no final) sao pulados.
                    if (seg.html.trim() === '') continue;

                    console.log(`   📄 Renderizando segmento ${i + 1}/${segmentos.length} (retrato)...`);
                    await page.setContent(blocoGeometria + seg.html, { waitUntil: 'networkidle0', timeout: 120000 });
                    const buf = await page.pdf(pdfOptionsRetrato);
                    buffersGerados.push(buf);

                } else {
                    // Segmento em PAISAGEM: monta um documento HTML minimo e
                    // independente, sem a geometria de retrato, e renderiza
                    // com landscape:true (pagina fisica deitada de verdade).
                    console.log(`   📄 Renderizando segmento ${i + 1}/${segmentos.length} (PAISAGEM)...`);
                    const docPaisagem = `<!DOCTYPE html><html><head><meta charset="utf-8">
                        <style>
                            html, body { margin: 0; padding: 0; }
                            table { max-width: 100% !important; }
                            th, td { overflow-wrap: break-word; word-wrap: break-word; }
                        </style>
                        </head><body>${seg.html}</body></html>`;

                    await page.setContent(docPaisagem, { waitUntil: 'networkidle0', timeout: 120000 });
                    const buf = await page.pdf(pdfOptionsPaisagem);
                    buffersGerados.push(buf);
                }
            }

            // -------------------------------------------------------------
            // MERGE: junta todos os PDFs parciais em um unico documento
            // final, preservando a orientacao de cada pagina individual.
            // -------------------------------------------------------------
            console.log("🔗 Unindo os segmentos em um único PDF final...");
            const pdfFinal = await PDFDocument.create();

            for (const buf of buffersGerados) {
                const src = await PDFDocument.load(buf);
                const paginasCopiadas = await pdfFinal.copyPages(src, src.getPageIndices());
                paginasCopiadas.forEach(p => pdfFinal.addPage(p));
            }

            finalPdfBuffer = Buffer.from(await pdfFinal.save());
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
