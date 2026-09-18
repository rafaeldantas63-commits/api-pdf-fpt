const express = require('express');
const puppeteer = require('puppeteer');
const pdfParse = require('pdf-parse');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const app = express();
app.use(express.json({ limit: '50mb' }));

// =========================================================================
// MARCADORES DE SECAO EM PAISAGEM
// =========================================================================
const LANDSCAPE_START = '<!--LANDSCAPE_START-->';
const LANDSCAPE_END = '<!--LANDSCAPE_END-->';

// =========================================================================
// MARCADORES DE LOGO (novo)
//
// O Power Apps entrega apenas o Base64 CRU envolvido nesses marcadores.
// E a API quem decide: como montar a tag <img>, qual tamanho usar, e
// onde posicionar o cabecalho na pagina em paisagem. Isso elimina os
// varios bugs de truncamento que ocorriam ao montar a tag <img> dentro
// de formulas complexas do Power Apps.
// =========================================================================
const LOGO_ESQ_START = '<!--LOGO_ESQ-->';
const LOGO_ESQ_END = '<!--/LOGO_ESQ-->';
const LOGO_DIR_START = '<!--LOGO_DIR-->';
const LOGO_DIR_END = '<!--/LOGO_DIR-->';

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

// =========================================================================
// HELPER (NOVO): extrai o conteudo entre dois marcadores e retorna o
// texto SEM os marcadores, junto com o texto original SEM aquele trecho.
// =========================================================================
function extrairEntreMarcadores(html, marcadorInicio, marcadorFim) {
    if (!html.includes(marcadorInicio)) {
        return { conteudo: '', htmlRestante: html };
    }
    const [antes, resto] = html.split(marcadorInicio);
    const [conteudo, depois] = resto.split(marcadorFim);
    return { conteudo: conteudo.trim(), htmlRestante: antes + depois };
}

// =========================================================================
// FUNCAO NOVA: injeta o cabecalho (logos) no topo de um segmento em
// paisagem.
//
// A API e quem decide TUDO sobre o cabecalho:
// - a tag <img> e montada aqui, nao no Power Apps
// - o tamanho (height='45') e definido aqui, igual ao padrao usado em
//   todas as demais paginas do relatorio
// - o logo do cliente so aparece se houver Base64 de fato (nao mostra
//   icone de imagem quebrada quando o campo esta vazio)
// - a posicao (tabela no topo, com borda inferior azul) e definida aqui
//
// O Power Apps so precisa fornecer os dois Base64 crus, envolvidos nos
// marcadores <!--LOGO_ESQ--> e <!--LOGO_DIR-->.
// =========================================================================
function injetarCabecalhoPaisagem(htmlSegmento) {
    let html = htmlSegmento;

    const logoEsq = extrairEntreMarcadores(html, LOGO_ESQ_START, LOGO_ESQ_END);
    html = logoEsq.htmlRestante;

    const logoDir = extrairEntreMarcadores(html, LOGO_DIR_START, LOGO_DIR_END);
    html = logoDir.htmlRestante;

    const base64Esq = logoEsq.conteudo;
    const base64Dir = logoDir.conteudo;

    // Se nenhum logo foi fornecido, nao adiciona cabecalho nenhum.
    if (!base64Esq && !base64Dir) {
        return html;
    }

    const imgEsq = base64Esq
        ? `<img src="${base64Esq}" '';

    const imgDir = base64Dir
        ? `<img src="${base64Dir}" height="45"nst cabecalhoHtml = `
        <table width="100%" cellspacing="0" cellpadding="0" style="border:none;border-bottom:2px solid #003366;margin-bottom:15px;padding-bottom:10px;">
            <tr>
                <td align="left" style="border:none;padding:0;vertical-align:middle;">${imgEsq}</td>
                <td align="right" style="border:none;padding:0;vertical-align:middle;">${imgDir}</td>
            </tr>
        </table>
    `;

    return cabecalhoHtml + html;
}

// =========================================================================
// CORRECAO DA NUMERACAO GLOBAL "FOLHA: X de Y"
// (mantida igual a versao anterior)
// =========================================================================
async function corrigirNumeracaoRodape(pdfBuffer) {
    const pagesItems = [];

    function custom_render_page(pageData) {
        return pageData.getTextContent().then(function (textContent) {
            const items = textContent.items.map(item => ({
                str: item.str,
                x: item.transform[4],
                y: item.transform[5],
                width: item.width,
                fontHeight: Math.hypot(item.transform[2], item.transform[3]) || 8.5
            }));
            pagesItems.push(items);
            return '';
        });
    }

    await pdfParse(pdfBuffer, { pagerender: custom_render_page });

    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const totalPaginas = pdfDoc.getPageCount();
    const fonteCorrecao = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    for (let i = 0; i < pagesItems.length; i++) {
        const items = pagesItems[i];

        const idxMarcador = items.findIndex(it => /FOLHA\s*:?/i.test(it.str));
        if (idxMarcador === -1) {
            console.log(`⚠️ Página ${i + 1}: marcador "FOLHA" não encontrado, numeração não corrigida nesta página.`);
            continue;
        }

        const baseY = items[idxMarcador].y;
        const baseX = items[idxMarcador].x;

        const itensDaLinha = items.filter(it =>
            Math.abs(it.y - baseY) < 2 && it.x >= baseX - 2
        );

        if (itensDaLinha.length === 0) continue;

        const minX = Math.min(...itensDaLinha.map(it => it.x));
        const maxX = Math.max(...itensDaLinha.map(it => it.x + it.width));
        const fontSize = items[idxMarcador].fontHeight;
        const alturaCaixa = fontSize * 1.5;
        const yCaixa = baseY - alturaCaixa * 0.3;

        const pagina = pdfDoc.getPage(i);

        pagina.drawRectangle({
            x: minX - 3,
            y: yCaixa,
            width: (maxX - minX) + 6,
            height: alturaCaixa,
            color: rgb(1, 1, 1)
        });

        pagina.drawText(`FOLHA: ${i + 1} de ${totalPaginas}`, {
            x: minX,
            y: baseY,
            size: fontSize,
            font: fonteCorrecao,
            color: rgb(0, 0, 0)
        });

        console.log(`✅ Página ${i + 1}: numeração corrigida para "FOLHA: ${i + 1} de ${totalPaginas}".`);
    }

    return Buffer.from(await pdfDoc.save());
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
        // =================================================================
        let finalPdfBuffer;
        let temSegmentosPaisagem = false;

        if (!htmlContent.includes(LANDSCAPE_START)) {
            console.log("🖨️ Imprimindo PDF Final (documento único, sem seções em paisagem)...");
            await page.setContent(blocoGeometria + htmlContent, { waitUntil: 'networkidle0', timeout: 120000 });
            finalPdfBuffer = await page.pdf(pdfOptionsRetrato);

        } else {
            temSegmentosPaisagem = true;
            console.log("🖨️ Documento contém seção(ões) em paisagem. Renderizando em partes separadas...");
            const segmentos = dividirEmSegmentos(htmlContent);
            const buffersGerados = [];

            for (let i = 0; i < segmentos.length; i++) {
                const seg = segmentos[i];

                if (seg.tipo === 'retrato') {
                    if (seg.html.trim() === '') continue;

                    console.log(`   📄 Renderizando segmento ${i + 1}/${segmentos.length} (retrato)...`);
                    await page.setContent(blocoGeometria + seg.html, { waitUntil: 'networkidle0', timeout: 120000 });
                    const buf = await page.pdf(pdfOptionsRetrato);
                    buffersGerados.push(buf);

                } else {
                    console.log(`   📄 Renderizando segmento ${i + 1}/${segmentos.length} (PAISAGEM)...`);

                    // NOVO: injeta o cabecalho (logos) automaticamente,
                    // montado 100% aqui na API a partir dos marcadores.
                    const conteudoComCabecalho = injetarCabecalhoPaisagem(seg.html);

                    const docPaisagem = `<!DOCTYPE html><html><head><meta charset="utf-8">
                        <style>
                            html, body { margin: 0; padding: 0; }
                            table { max-width: 100% !important; }
                            th, td { overflow-wrap: break-word; word-wrap: break-word; }
                        </style>
                        </head><body>${conteudoComCabecalho}</body></html>`;

                    await page.setContent(docPaisagem, { waitUntil: 'networkidle0', timeout: 120000 });
                    const buf = await page.pdf(pdfOptionsPaisagem);
                    buffersGerados.push(buf);
                }
            }

            console.log("🔗 Unindo os segmentos em um único PDF final...");
            const pdfFinal = await PDFDocument.create();

            for (const buf of buffersGerados) {
                const src = await PDFDocument.load(buf);
                const paginasCopiadas = await pdfFinal.copyPages(src, src.getPageIndices());
                paginasCopiadas.forEach(p => pdfFinal.addPage(p));
            }

            finalPdfBuffer = Buffer.from(await pdfFinal.save());
        }

        // =================================================================
        // CORRECAO DA NUMERACAO GLOBAL DO RODAPE
        // =================================================================
        if (temSegmentosPaisagem) {
            console.log("🔢 Corrigindo numeração global de páginas no rodapé...");
            finalPdfBuffer = await corrigirNumeracaoRodape(finalPdfBuffer);
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
