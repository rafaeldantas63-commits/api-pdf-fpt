const express = require('express');
const puppeteer = require('puppeteer');
const pdfParse = require('pdf-parse');
const { PDFDocument, StandardFonts, rgb, PDFName } = require('pdf-lib');
const fs = require('fs');
const os = require('os');
const path = require('path');

const app = express();
app.use(express.json({ limit: '50mb' }));

const LANDSCAPE_START = '<!--LANDSCAPE_START-->';
const LANDSCAPE_END = '<!--LANDSCAPE_END-->';
const LOGO_ESQ_START = '<!--LOGO_ESQ-->';
const LOGO_ESQ_END = '<!--/LOGO_ESQ-->';
const LOGO_DIR_START = '<!--LOGO_DIR-->';
const LOGO_DIR_END = '<!--/LOGO_DIR-->';

// =========================================================================
// OTIMIZACAO DE TEMPO - ESTRATEGIA DE ESPERA DO PUPPETEER
//
// ANTES: waitUntil: 'networkidle0'
//   Essa opcao faz o Puppeteer esperar a rede ficar COMPLETAMENTE ociosa
//   (zero conexoes ativas) por 500ms ANTES de considerar a pagina pronta.
//   Faz sentido em paginas que baixam imagens, fontes ou dados via AJAX.
//
// AGORA: waitUntil: 'domcontentloaded'
//   O HTML gerado pelo Power Apps e 100% AUTOCONTIDO: todo o conteudo vem
//   embutido na string (inclusive as imagens, que sao base64 inline). Nao
//   ha NENHUMA requisicao de rede a ser aguardada. Portanto, o
//   'networkidle0' estava apenas cobrando um pedagio de ~500ms a 2s por
//   chamada, sem beneficio algum.
//
//   Como sao 6 chamadas por requisicao (3 segmentos no PDF fantasma + 3
//   no PDF final), a economia estimada fica entre 3 e 12 segundos - o
//   suficiente para tentar trazer o total abaixo do teto de 120s imposto
//   pelo conector HTTP do Power Automate.
// =========================================================================
const ESPERA_RENDER = 'domcontentloaded';

// =========================================================================
// LOGGER DE PROGRESSO + MEDIDOR DE MEMORIA
// =========================================================================
let _t0 = Date.now();

function iniciarCronometro() {
    _t0 = Date.now();
}

function mem() {
    return (process.memoryUsage().rss / 1024 / 1024).toFixed(0);
}

function log(etapa) {
    const seg = ((Date.now() - _t0) / 1000).toFixed(1);
    console.log('[' + seg + 's | ' + mem() + 'MB] ' + etapa);
}

// Sugere coleta de lixo (so funciona se o Node rodar com --expose-gc).
// Sem a flag, a chamada e ignorada silenciosamente - nao quebra nada.
function liberarMemoria() {
    if (global.gc) {
        global.gc();
    }
}

function mmParaPt(valorStr) {
    if (!valorStr) return 0;
    const numero = parseFloat(String(valorStr).replace(',', '.'));
    if (isNaN(numero)) return 0;
    return numero * 2.83465;
}

function render_page(pageData) {
    return pageData.getTextContent().then(function (textContent) {
        let text = '';
        for (let item of textContent.items) {
            text += item.str + ' ';
        }
        return text + '\n---PAGE_BREAK---\n';
    });
}

function normalizarAncora(texto) {
    return texto.replace(/[^a-zA-Z0-9#]/g, '');
}

function dividirEmSegmentos(html) {
    const segmentos = [];
    let restante = html;
    while (restante.includes(LANDSCAPE_START)) {
        const partesInicio = restante.split(LANDSCAPE_START);
        segmentos.push({ tipo: 'retrato', html: partesInicio[0] });
        const partesFim = partesInicio[1].split(LANDSCAPE_END);
        segmentos.push({ tipo: 'paisagem', html: partesFim[0] });
        restante = partesFim[1];
    }
    segmentos.push({ tipo: 'retrato', html: restante });
    return segmentos;
}

function extrairEntreMarcadores(html, marcadorInicio, marcadorFim) {
    if (!html.includes(marcadorInicio)) return { conteudo: '', htmlRestante: html };
    const partesA = html.split(marcadorInicio);
    const partesB = partesA[1].split(marcadorFim);
    return { conteudo: partesB[0].trim(), htmlRestante: partesA[0] + partesB[1] };
}

function injetarCabecalhoPaisagem(htmlSegmento) {
    let html = htmlSegmento;
    const logoEsq = extrairEntreMarcadores(html, LOGO_ESQ_START, LOGO_ESQ_END);
    html = logoEsq.htmlRestante;
    const logoDir = extrairEntreMarcadores(html, LOGO_DIR_START, LOGO_DIR_END);
    html = logoDir.htmlRestante;
    const base64Esq = logoEsq.conteudo;
    const base64Dir = logoDir.conteudo;
    if (!base64Esq && !base64Dir) return html;
    let imgEsq = base64Esq ? '<img src="' + base64Esq + '" height="45" />' : '';
    let imgDir = base64Dir ? '<img src="' + base64Dir + '" height="45" />' : '';
    let cabecalhoHtml = '<table width="100%" cellspacing="0" cellpadding="0" style="border:none;border-bottom:2px solid #003366;margin-bottom:15px;padding-bottom:10px;"><tr>';
    cabecalhoHtml += '<td align="left" style="border:none;padding:0;vertical-align:middle;">' + imgEsq + '</td>';
    cabecalhoHtml += '<td align="right" style="border:none;padding:0;vertical-align:middle;">' + imgDir + '</td>';
    cabecalhoHtml += '</tr></table>';
    return cabecalhoHtml + html;
}

function removerMarcadoresDeLogo(html) {
    let resultado = html;
    resultado = extrairEntreMarcadores(resultado, LOGO_ESQ_START, LOGO_ESQ_END).htmlRestante;
    resultado = extrairEntreMarcadores(resultado, LOGO_DIR_START, LOGO_DIR_END).htmlRestante;
    return resultado;
}

function cabecalhoEstaVazio(headerHtmlProcessado) {
    const semEspacos = headerHtmlProcessado.replace(/\s+/g, '').toLowerCase();
    return semEspacos === '<div></div>' || semEspacos === '';
}

// =========================================================================
// RENDERIZACAO - OTIMIZADA PARA BAIXO CONSUMO DE MEMORIA E TEMPO
//
// 1) UMA ABA (page) POR SEGMENTO, FECHADA LOGO APOS O USO.
//    O Chromium mantem em memoria o layout da pagina anterior; fechando
//    a aba, esse espaco e devolvido ao SO.
//
// 2) BUFFERS GRAVADOS EM DISCO (/tmp), NAO ACUMULADOS EM RAM.
//
// 3) waitUntil: ESPERA_RENDER ('domcontentloaded') em vez de
//    'networkidle0' - ver explicacao no topo do arquivo.
// =========================================================================
async function renderizarDocumento(browser, htmlContent, blocoGeometria, pdfOptionsRetrato, pdfOptionsPaisagem, ehTemplateSiemens, prefixoTmp) {
    let temSegmentosPaisagem = false;
    let bufferFinal;

    if (!htmlContent.includes(LANDSCAPE_START)) {
        log('    documento unico (sem paisagem) - abrindo aba...');
        const page = await browser.newPage();
        try {
            const htmlLimpo = removerMarcadoresDeLogo(htmlContent);
            await page.setContent(blocoGeometria + htmlLimpo, { waitUntil: ESPERA_RENDER, timeout: 120000 });
            log('    HTML carregado - imprimindo PDF...');
            bufferFinal = await page.pdf(pdfOptionsRetrato);
            log('    PDF impresso');
        } finally {
            await page.close();
            liberarMemoria();
        }
    } else {
        temSegmentosPaisagem = true;
        const segmentos = dividirEmSegmentos(htmlContent);
        log('    documento com ' + segmentos.length + ' segmento(s) (retrato/paisagem)');

        const arquivosTmp = [];

        for (let i = 0; i < segmentos.length; i++) {
            const seg = segmentos[i];
            const rotulo = 'segmento ' + (i + 1) + '/' + segmentos.length + ' (' + seg.tipo + ')';

            if (seg.tipo === 'retrato' && seg.html.trim() === '') {
                continue;
            }

            // Aba nova e exclusiva para este segmento
            const page = await browser.newPage();
            let buffer;

            try {
                if (seg.tipo === 'retrato') {
                    log('    ' + rotulo + ' - carregando...');
                    const htmlRetratoLimpo = removerMarcadoresDeLogo(seg.html);
                    await page.setContent(blocoGeometria + htmlRetratoLimpo, { waitUntil: ESPERA_RENDER, timeout: 120000 });
                    log('    ' + rotulo + ' - imprimindo...');
                    buffer = await page.pdf(pdfOptionsRetrato);
                } else {
                    log('    ' + rotulo + ' - carregando...');
                    const conteudoComCabecalho = ehTemplateSiemens ? injetarCabecalhoPaisagem(seg.html) : removerMarcadoresDeLogo(seg.html);
                    let docPaisagem = '<!DOCTYPE html><html><head><meta charset="utf-8"><style>html, body { margin: 0; padding: 0; } table { max-width: 100% !important; } th, td { overflow-wrap: break-word; word-wrap: break-word; }</style></head><body>' + conteudoComCabecalho + '</body></html>';
                    await page.setContent(docPaisagem, { waitUntil: ESPERA_RENDER, timeout: 120000 });
                    log('    ' + rotulo + ' - imprimindo...');
                    buffer = await page.pdf(pdfOptionsPaisagem);
                }
            } finally {
                // Fecha a aba ANTES de qualquer outra coisa, devolvendo
                // ao sistema a memoria que o Chromium usou neste segmento
                await page.close();
            }

            // Grava em disco e solta a referencia da RAM
            const caminho = path.join(os.tmpdir(), prefixoTmp + '_seg' + i + '.pdf');
            await fs.promises.writeFile(caminho, buffer);
            arquivosTmp.push(caminho);
            buffer = null;
            liberarMemoria();

            log('    ' + rotulo + ' OK (salvo em disco)');
        }

        log('    juntando ' + arquivosTmp.length + ' arquivo(s) em um PDF unico...');
        const pdfFinal = await PDFDocument.create();
        for (const caminho of arquivosTmp) {
            const buf = await fs.promises.readFile(caminho);
            const src = await PDFDocument.load(buf);
            const paginasCopiadas = await pdfFinal.copyPages(src, src.getPageIndices());
            paginasCopiadas.forEach(function (p) { pdfFinal.addPage(p); });
            // Remove o temporario assim que ele ja foi absorvido
            await fs.promises.unlink(caminho).catch(function () { });
            liberarMemoria();
        }
        bufferFinal = Buffer.from(await pdfFinal.save());
        log('    PDF unico montado');
        liberarMemoria();
    }

    return { buffer: bufferFinal, temSegmentosPaisagem: temSegmentosPaisagem };
}

// =========================================================================
// POS-PROCESSAMENTO UNIFICADO (rodape + indice)
//
// Uma unica leitura (pdfParse), um load e um save, com as duas correcoes
// aplicadas no mesmo documento em memoria. A ordem das operacoes de
// desenho e identica a anterior (rodape primeiro, indice depois).
// =========================================================================
async function posProcessarPDF(pdfBuffer, mapaDestinos, mLateralPt, corrigirRodape) {
    const pagesItems = [];

    function custom_render_page(pageData) {
        return pageData.getTextContent().then(function (textContent) {
            pagesItems.push(textContent.items.map(function (item) {
                return {
                    str: item.str,
                    x: item.transform[4],
                    y: item.transform[5],
                    width: item.width,
                    fontHeight: Math.hypot(item.transform[2], item.transform[3])
                };
            }));
            return '';
        });
    }

    await pdfParse(pdfBuffer, { pagerender: custom_render_page });
    log('    texto do PDF final extraido (' + pagesItems.length + ' paginas)');

    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const pages = pdfDoc.getPages();
    const context = pdfDoc.context;
    const fonteNormal = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fonteBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    // ---------------------------------------------------------------
    // PARTE 1 - NUMERACAO DO RODAPE ("FOLHA: X de Y")
    // ---------------------------------------------------------------
    if (corrigirRodape) {
        const totalPaginas = pdfDoc.getPageCount();
        let corrigidas = 0;

        for (let i = 0; i < pagesItems.length && i < pages.length; i++) {
            const items = pagesItems[i];
            const idxMarcador = items.findIndex(function (it) { return /FOLHA\s*:?/i.test(it.str); });
            if (idxMarcador === -1) continue;

            const baseY = items[idxMarcador].y;
            const baseX = items[idxMarcador].x;
            const itensDaLinha = items.filter(function (it) { return Math.abs(it.y - baseY) < 2 && it.x >= baseX - 2; });
            if (itensDaLinha.length === 0) continue;

            const minX = Math.min.apply(null, itensDaLinha.map(function (it) { return it.x; }));
            const maxX = Math.max.apply(null, itensDaLinha.map(function (it) { return it.x + it.width; }));
            const fontSize = items[idxMarcador].fontHeight || 8.5;
            const alturaCaixa = fontSize * 1.5;
            const yCaixa = baseY - alturaCaixa * 0.3;
            const pagina = pages[i];

            pagina.drawRectangle({ x: minX - 3, y: yCaixa, width: (maxX - minX) + 6, height: alturaCaixa, color: rgb(1, 1, 1) });
            pagina.drawText('FOLHA: ' + (i + 1) + ' de ' + totalPaginas, { x: minX, y: baseY, size: fontSize, font: fonteBold, color: rgb(0, 0, 0) });
            corrigidas++;
        }
        log('    rodape corrigido em ' + corrigidas + ' pagina(s)');
    }

    // ---------------------------------------------------------------
    // PARTE 2 - INDICE (alinhamento do numero, pontilhado e links)
    // ---------------------------------------------------------------
    if (mapaDestinos && Object.keys(mapaDestinos).length > 0) {
        const ocorrencias = [];

        for (let p = 0; p < pagesItems.length; p++) {
            const items = pagesItems[p];
            for (let idx = 0; idx < items.length; idx++) {
                const item = items[idx];
                const match = item.str.match(/@@LNK_([A-Za-z0-9_]+)@@/);
                if (!match) continue;
                const codigo = match[1];

                let numItem = null;
                for (let k = idx - 1; k >= 0; k--) {
                    const cand = items[k];
                    if (Math.abs(cand.y - item.y) > 2) break;
                    if (/^\d{3}$/.test(cand.str.trim())) { numItem = cand; break; }
                }

                const rowY = numItem ? numItem.y : item.y;
                let titleEndX = null;
                const limiteX = numItem ? numItem.x : item.x;
                items.forEach(function (it) {
                    // Tolerancia de 16pt: enxerga tanto a linha do titulo
                    // principal (negrito, acima) quanto a da traducao.
                    if (Math.abs(it.y - rowY) > 16) return;
                    if (it === numItem || it === item) return;
                    if (it.x >= limiteX) return;
                    const rightEdge = it.x + it.width;
                    if (titleEndX === null || rightEdge > titleEndX) titleEndX = rightEdge;
                });

                ocorrencias.push({ codigo: codigo, pageIndex: p, markerX: item.x, markerY: item.y, numItem: numItem, titleEndX: titleEndX });
            }
        }

        const BUFFER_MARGEM = 2;
        const LARGURA_LINK_PADRAO = 34;
        const DOT_RADIUS = 0.4;
        const DOT_PERIOD = 2.5;
        let linksCriados = 0;

        ocorrencias.forEach(function (oc) {
            const destPageNum = mapaDestinos[oc.codigo];
            if (!destPageNum || destPageNum < 1 || destPageNum > pages.length) return;
            if (oc.pageIndex < 0 || oc.pageIndex >= pages.length) return;

            const paginaOrigem = pages[oc.pageIndex];
            const paginaDestino = pages[destPageNum - 1];
            const pageWidth = paginaOrigem.getWidth();
            const targetRightX = pageWidth - mLateralPt - BUFFER_MARGEM;

            let rectX0, rectX1, rectY0, rectY1;

            if (oc.numItem && oc.titleEndX !== null) {
                const numItem = oc.numItem;
                const alturaFonte = numItem.fontHeight || 9;
                const novoX = targetRightX - numItem.width;

                const numUnderscores = (oc.codigo.match(/_/g) || []).length;
                const fonteEscolhida = (numUnderscores === 1) ? fonteBold : fonteNormal;

                // Margem vertical de 6pt garante que o pontilhado original
                // (border-bottom do CSS) seja totalmente coberto - com
                // margem menor sobrava uma tira fina do estilo antigo.
                const rowTop = numItem.y - 6;
                const rowBottom = numItem.y + alturaFonte + 6;
                const rowHeight = rowBottom - rowTop;

                // Apaga do fim do titulo ate a borda fisica da pagina
                const whiteFromX = oc.titleEndX + 2;
                paginaOrigem.drawRectangle({
                    x: whiteFromX,
                    y: rowTop,
                    width: Math.max(0, pageWidth - whiteFromX),
                    height: rowHeight,
                    color: rgb(1, 1, 1)
                });

                // Redesenha o pontilhado inteiro, de um so estilo
                const dotY = numItem.y - 1.5;
                const dotsFromX = oc.titleEndX + 4;
                const dotsToX = novoX - 3;
                for (let px = dotsFromX; px < dotsToX; px += DOT_PERIOD) {
                    paginaOrigem.drawCircle({ x: px, y: dotY, size: DOT_RADIUS, color: rgb(0, 0, 0) });
                }

                paginaOrigem.drawText(numItem.str, {
                    x: novoX,
                    y: numItem.y,
                    size: alturaFonte,
                    font: fonteEscolhida,
                    color: rgb(0, 0, 0)
                });

                rectX0 = Math.max(0, novoX - 2);
                rectX1 = novoX + numItem.width + 2;
                rectY0 = numItem.y - 2;
                rectY1 = numItem.y + alturaFonte + 2;
            } else if (oc.numItem) {
                const alturaFonte = oc.numItem.fontHeight || 9;
                rectX0 = Math.max(0, oc.numItem.x - 2);
                rectX1 = oc.numItem.x + oc.numItem.width + 2;
                rectY0 = oc.numItem.y - 2;
                rectY1 = oc.numItem.y + alturaFonte + 2;
            } else {
                rectX0 = Math.max(0, oc.markerX - LARGURA_LINK_PADRAO);
                rectX1 = oc.markerX + 2;
                rectY0 = oc.markerY - 2;
                rectY1 = oc.markerY + 12;
            }

            const linkDict = context.obj({});
            linkDict.set(PDFName.of('Type'), PDFName.of('Annot'));
            linkDict.set(PDFName.of('Subtype'), PDFName.of('Link'));
            linkDict.set(PDFName.of('Rect'), context.obj([rectX0, rectY0, rectX1, rectY1]));
            linkDict.set(PDFName.of('Border'), context.obj([0, 0, 0]));
            linkDict.set(PDFName.of('Dest'), context.obj([paginaDestino.ref, PDFName.of('Fit')]));
            const linkRef = context.register(linkDict);

            const existentesRef = paginaOrigem.node.get(PDFName.of('Annots'));
            let annotsArray;
            if (existentesRef) {
                annotsArray = context.lookup(existentesRef);
                if (!annotsArray || typeof annotsArray.push !== 'function') {
                    annotsArray = context.obj([]);
                    paginaOrigem.node.set(PDFName.of('Annots'), annotsArray);
                }
            } else {
                annotsArray = context.obj([]);
                paginaOrigem.node.set(PDFName.of('Annots'), annotsArray);
            }
            annotsArray.push(linkRef);
            linksCriados++;
        });

        log('    indice: ' + linksCriados + ' link(s) criado(s)');
    }

    // Libera a lista de posicoes antes de serializar o PDF
    pagesItems.length = 0;
    liberarMemoria();

    return Buffer.from(await pdfDoc.save());
}

app.post('/gerar-pdf', async (req, res) => {
    let browser;

    iniciarCronometro();
    log('===== NOVA REQUISICAO RECEBIDA =====');

    // Prefixo unico para os arquivos temporarios desta requisicao,
    // evitando colisao caso duas execucoes rodem ao mesmo tempo
    const prefixoTmp = 'fpt_' + Date.now() + '_' + Math.floor(Math.random() * 10000);

    try {
        if (!req.body || typeof req.body.html !== 'string' || req.body.html.trim() === '') {
            log('ERRO: campo html ausente ou vazio');
            return res.status(400).json({ erro: "O campo 'html' é obrigatório e deve ser um texto não vazio." });
        }

        let htmlContent = req.body.html;
        log('HTML recebido: ' + (htmlContent.length / 1024).toFixed(0) + ' KB');

        const headerRaw = req.body.cabecalho || '<div></div>';
        const footerRaw = req.body.rodape || '<div></div>';
        const mTop = req.body.margemTop || '10mm';
        const mBottom = req.body.margemBottom || '55mm';
        const mLateral = req.body.margemLateral || '15mm';
        const tamanhoPapel = req.body.tamanhoPapel || 'A4';

        const headerHtml = headerRaw.split('[MARGEM_LATERAL]').join(mLateral);
        const footerHtml = footerRaw.split('[MARGEM_LATERAL]').join(mLateral);
        const ehTemplateSiemens = cabecalhoEstaVazio(headerHtml);

        let blocoGeometria = '<style id="geometria-pagina-api">';
        blocoGeometria += '@page { size: ' + tamanhoPapel + ' portrait; margin: ' + mTop + ' ' + mLateral + ' ' + mBottom + ' ' + mLateral + '; }';
        blocoGeometria += 'html, body { margin: 0; padding: 0; width: 100%; }';
        blocoGeometria += '.wrapper-table { table-layout: fixed !important; width: 100% !important; max-width: 100% !important; }';
        blocoGeometria += 'table { max-width: 100% !important; }';
        blocoGeometria += 'th, td { overflow-wrap: break-word; word-wrap: break-word; }';
        blocoGeometria += '</style>';

        const pdfOptionsRetrato = {
            format: tamanhoPapel, printBackground: true, displayHeaderFooter: true,
            headerTemplate: headerHtml, footerTemplate: footerHtml,
            margin: { top: mTop, bottom: mBottom, right: mLateral, left: mLateral },
            preferCSSPageSize: true, timeout: 120000
        };
        const pdfOptionsPaisagem = {
            format: tamanhoPapel, landscape: true, printBackground: true, displayHeaderFooter: true,
            headerTemplate: headerHtml, footerTemplate: footerHtml,
            margin: { top: mTop, bottom: mBottom, right: mLateral, left: mLateral },
            timeout: 120000
        };

        log('Iniciando navegador (Puppeteer)...');
        browser = await puppeteer.launch({
            headless: 'new',
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-zygote',
                // Flags adicionais para reduzir o consumo de RAM do Chromium
                '--disable-extensions',
                '--disable-background-networking',
                '--disable-background-timer-throttling',
                '--disable-client-side-phishing-detection',
                '--disable-default-apps',
                '--disable-sync',
                '--disable-translate',
                '--mute-audio',
                '--no-first-run',
                '--hide-scrollbars',
                '--metrics-recording-only',
                '--disable-features=site-per-process,TranslateUI'
            ]
        });
        log('Navegador iniciado');

        const mapaDestinos = {};

        if (htmlContent.includes('#ANC_')) {
            log('ETAPA 1/4 - Renderizando PDF fantasma (para calcular as paginas do indice)...');
            const htmlFantasma = htmlContent.replace(/\{\{PAG_CAP_[A-Za-z0-9_]+\}\}/g, '000');
            const resultadoFantasma = await renderizarDocumento(browser, htmlFantasma, blocoGeometria, pdfOptionsRetrato, pdfOptionsPaisagem, ehTemplateSiemens, prefixoTmp + '_ghost');
            log('ETAPA 1/4 - PDF fantasma pronto');

            log('ETAPA 2/4 - Extraindo texto do PDF fantasma (pdf-parse)...');
            const pdfData = await pdfParse(resultadoFantasma.buffer, { pagerender: render_page });

            // Solta o PDF fantasma da memoria IMEDIATAMENTE apos extrair o
            // texto - ele nao e mais necessario.
            resultadoFantasma.buffer = null;
            liberarMemoria();

            const pages = pdfData.text.split('\n---PAGE_BREAK---\n');
            log('ETAPA 2/4 - Texto extraido de ' + pages.length + ' pagina(s)');

            const pagesNormalizadas = pages.map(function (p) { return normalizarAncora(p); });
            const anchors = htmlContent.match(/#ANC_[A-Za-z0-9_]+#/g);

            if (anchors) {
                const uniqueAnchors = [...new Set(anchors)];
                log('Mapeando ' + uniqueAnchors.length + ' ancora(s) unica(s)...');
                uniqueAnchors.forEach(function (anchor) {
                    const pureAnchor = normalizarAncora(anchor);
                    const pageNum = pagesNormalizadas.findIndex(function (pText) { return pText.includes(pureAnchor); }) + 1;
                    const placeholder = anchor.replace('#ANC_', '{{PAG_').replace('#', '}}');
                    const codigo = anchor.replace(/^#ANC_/, '').replace(/#$/, '');

                    if (pageNum > 0) {
                        const pageNumFormatado = String(pageNum).padStart(3, '0');
                        const marcador = '@@LNK_' + codigo + '@@';
                        const marcadorHtml = '<span style="color:#ffffff;font-size:9pt;">' + marcador + '</span>';
                        htmlContent = htmlContent.split(placeholder).join(pageNumFormatado + marcadorHtml);
                        mapaDestinos[codigo] = pageNum;
                    } else {
                        log('  AVISO: ancora ' + codigo + ' NAO encontrada no PDF (vai sair como ---)');
                    }
                    htmlContent = htmlContent.split(anchor).join('');
                });
                log('Ancoras mapeadas: ' + Object.keys(mapaDestinos).length + ' de ' + uniqueAnchors.length);
            }

            const orfaos = htmlContent.match(/\{\{PAG_[A-Za-z0-9_]+\}\}/g);
            if (orfaos) {
                const listaOrfaos = [...new Set(orfaos)];
                log('Substituindo ' + listaOrfaos.length + ' placeholder(s) orfao(s) por "---"');
                listaOrfaos.forEach(function (o) { htmlContent = htmlContent.split(o).join('---'); });
            }

            // Libera os textos extraidos (podem somar varios MB em
            // documentos de ~100 paginas) antes da renderizacao final
            pages.length = 0;
            pagesNormalizadas.length = 0;
            pdfData.text = '';
            liberarMemoria();
        }

        log('ETAPA 3/4 - Renderizando PDF final...');
        const resultadoFinal = await renderizarDocumento(browser, htmlContent, blocoGeometria, pdfOptionsRetrato, pdfOptionsPaisagem, ehTemplateSiemens, prefixoTmp + '_final');
        let finalPdfBuffer = resultadoFinal.buffer;
        log('ETAPA 3/4 - PDF final pronto (' + (finalPdfBuffer.length / 1024 / 1024).toFixed(1) + ' MB)');

        // Fecha o navegador ANTES do pos-processamento: a partir daqui so
        // se trabalha com pdf-lib, e manter o Chromium vivo seria puro
        // desperdicio de memoria no momento mais critico.
        log('Fechando navegador (nao e mais necessario)...');
        await browser.close();
        browser = null;
        liberarMemoria();

        const precisaRodape = resultadoFinal.temSegmentosPaisagem;
        const precisaIndice = Object.keys(mapaDestinos).length > 0;

        if (precisaRodape || precisaIndice) {
            log('ETAPA 4/4 - Pos-processamento (rodape + indice em uma unica passagem)...');
            const mLateralPt = mmParaPt(mLateral);
            finalPdfBuffer = await posProcessarPDF(finalPdfBuffer, precisaIndice ? mapaDestinos : null, mLateralPt, precisaRodape);
            log('ETAPA 4/4 - Pos-processamento concluido');
        } else {
            log('ETAPA 4/4 - Pulada (nada a corrigir)');
        }

        log('Convertendo para base64 e enviando resposta...');
        const base64 = finalPdfBuffer.toString('base64');
        finalPdfBuffer = null;
        liberarMemoria();

        res.json({ pdfBase64: base64 });
        log('===== CONCLUIDO COM SUCESSO =====');

    } catch (error) {
        log('===== ERRO FATAL =====');
        console.error("🚨 Erro Fatal:", error);
        res.status(500).json({ erro: error.toString() });
    } finally {
        if (browser) {
            await browser.close();
            log('Navegador fechado');
        }
        // Limpeza de seguranca: remove qualquer temporario que tenha
        // sobrado (por exemplo, se a requisicao falhou no meio)
        try {
            const arquivos = await fs.promises.readdir(os.tmpdir());
            for (const nome of arquivos) {
                if (nome.startsWith(prefixoTmp)) {
                    await fs.promises.unlink(path.join(os.tmpdir(), nome)).catch(function () { });
                }
            }
        } catch (e) {
            // silencioso - limpeza e best-effort
        }
        liberarMemoria();
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Ativo na porta ' + PORT));
