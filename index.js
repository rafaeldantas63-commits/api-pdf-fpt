const express = require('express');
const puppeteer = require('puppeteer');
const pdfParse = require('pdf-parse');
const { PDFDocument, StandardFonts, rgb, PDFName } = require('pdf-lib');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '50mb' }));

const LANDSCAPE_START = '<!--LANDSCAPE_START-->';
const LANDSCAPE_END = '<!--LANDSCAPE_END-->';
const LOGO_ESQ_START = '<!--LOGO_ESQ-->';
const LOGO_ESQ_END = '<!--/LOGO_ESQ-->';
const LOGO_DIR_START = '<!--LOGO_DIR-->';
const LOGO_DIR_END = '<!--/LOGO_DIR-->';

// =========================================================================
// MODO ASSINCRONO (mudanca estrutural desta versao)
//
// PROBLEMA QUE ISSO RESOLVE:
//   O conector HTTP do Power Automate tem um teto RIGIDO de 120 segundos
//   para receber a resposta. Nao existe configuracao que aumente isso - o
//   campo "Action timeout" (PT5M) controla o tempo total da acao, nao a
//   espera pela primeira resposta. Como a geracao completa leva ~118s e
//   encosta no limite, qualquer variacao de carga fazia o fluxo falhar
//   com "the server did not respond within the timeout limit".
//
// COMO FUNCIONA AGORA:
//   1) POST /gerar-pdf     -> responde em ~1s com um jobId e status 202.
//                             O processamento continua em segundo plano.
//   2) GET  /status/:jobId -> diz se ainda esta processando, se concluiu
//                             ou se deu erro. Resposta pequena e rapida.
//   3) GET  /download/:jobId -> devolve o PDF em base64 (so quando pronto).
//
//   O Power Apps ja tem um Timer que faz polling; ele passa a consultar o
//   /status em vez de esperar a resposta do /gerar-pdf. O teto de 120s
//   deixa de importar, porque nenhuma chamada individual demora mais que
//   alguns segundos.
//
// ONDE OS JOBS FICAM:
//   Em arquivos no diretorio temporario do sistema (/tmp), nao em memoria.
//   Guardar PDFs de ~1 MB em RAM enquanto o cliente nao busca acabaria
//   estourando o limite do plano basico do Render se varias geracoes
//   acontecessem em sequencia.
// =========================================================================
const DIR_JOBS = path.join(os.tmpdir(), 'jobs_pdf');
const JOB_VALIDADE_MS = 30 * 60 * 1000; // 30 minutos

// Garante que a pasta de jobs existe assim que o servidor sobe
try {
    if (!fs.existsSync(DIR_JOBS)) {
        fs.mkdirSync(DIR_JOBS, { recursive: true });
    }
} catch (e) {
    console.error('Nao foi possivel criar a pasta de jobs:', e.message);
}

function caminhoStatus(jobId) {
    return path.join(DIR_JOBS, jobId + '.json');
}

function caminhoPdf(jobId) {
    return path.join(DIR_JOBS, jobId + '.pdf');
}

async function gravarStatus(jobId, dados) {
    const registro = Object.assign({ jobId: jobId, atualizadoEm: Date.now() }, dados);
    await fs.promises.writeFile(caminhoStatus(jobId), JSON.stringify(registro), 'utf8');
}

async function lerStatus(jobId) {
    try {
        const texto = await fs.promises.readFile(caminhoStatus(jobId), 'utf8');
        return JSON.parse(texto);
    } catch (e) {
        return null;
    }
}

// Remove jobs antigos para nao encher o disco. Roda a cada nova
// requisicao de geracao (barato, poucos arquivos).
async function limparJobsAntigos() {
    try {
        const arquivos = await fs.promises.readdir(DIR_JOBS);
        const agora = Date.now();
        for (const nome of arquivos) {
            const completo = path.join(DIR_JOBS, nome);
            try {
                const info = await fs.promises.stat(completo);
                if (agora - info.mtimeMs > JOB_VALIDADE_MS) {
                    await fs.promises.unlink(completo).catch(function () { });
                }
            } catch (e) {
                // ignora arquivo problematico
            }
        }
    } catch (e) {
        // pasta pode nao existir ainda - sem problema
    }
}

// =========================================================================
// LOGGER DE PROGRESSO + MEDIDOR DE MEMORIA
//
// Agora o log inclui o jobId, porque varias geracoes podem estar
// acontecendo ao mesmo tempo e sem isso as linhas ficariam embaralhadas.
// =========================================================================
const _cronometros = {};

function iniciarCronometro(jobId) {
    _cronometros[jobId] = Date.now();
}

function encerrarCronometro(jobId) {
    delete _cronometros[jobId];
}

function mem() {
    return (process.memoryUsage().rss / 1024 / 1024).toFixed(0);
}

function log(jobId, etapa) {
    const inicio = _cronometros[jobId] || Date.now();
    const seg = ((Date.now() - inicio) / 1000).toFixed(1);
    const curto = jobId ? jobId.substring(0, 8) : '--------';
    console.log('[' + curto + ' | ' + seg + 's | ' + mem() + 'MB] ' + etapa);
}

// Sugere coleta de lixo (so funciona se o Node rodar com --expose-gc).
// Sem a flag, a chamada e ignorada silenciosamente - nao quebra nada.
function liberarMemoria() {
    if (global.gc) {
        global.gc();
    }
}

// =========================================================================
// OTIMIZACAO DE TEMPO - ESTRATEGIA DE ESPERA DO PUPPETEER
//
// O HTML gerado pelo Power Apps e 100% AUTOCONTIDO (imagens em base64
// inline, nenhuma requisicao externa). Por isso 'domcontentloaded' basta:
// o 'networkidle0' anterior apenas cobrava ~500ms a 2s por chamada
// esperando uma rede que nunca teve atividade.
// =========================================================================
const ESPERA_RENDER = 'domcontentloaded';

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
// 2) BUFFERS GRAVADOS EM DISCO (/tmp), NAO ACUMULADOS EM RAM.
// 3) waitUntil: 'domcontentloaded' em vez de 'networkidle0'.
// =========================================================================
async function renderizarDocumento(jobId, browser, htmlContent, blocoGeometria, pdfOptionsRetrato, pdfOptionsPaisagem, ehTemplateSiemens, prefixoTmp) {
    let temSegmentosPaisagem = false;
    let bufferFinal;

    if (!htmlContent.includes(LANDSCAPE_START)) {
        log(jobId, '    documento unico (sem paisagem) - abrindo aba...');
        const page = await browser.newPage();
        try {
            const htmlLimpo = removerMarcadoresDeLogo(htmlContent);
            await page.setContent(blocoGeometria + htmlLimpo, { waitUntil: ESPERA_RENDER, timeout: 120000 });
            log(jobId, '    HTML carregado - imprimindo PDF...');
            bufferFinal = await page.pdf(pdfOptionsRetrato);
            log(jobId, '    PDF impresso');
        } finally {
            await page.close();
            liberarMemoria();
        }
    } else {
        temSegmentosPaisagem = true;
        const segmentos = dividirEmSegmentos(htmlContent);
        log(jobId, '    documento com ' + segmentos.length + ' segmento(s) (retrato/paisagem)');

        const arquivosTmp = [];

        for (let i = 0; i < segmentos.length; i++) {
            const seg = segmentos[i];
            const rotulo = 'segmento ' + (i + 1) + '/' + segmentos.length + ' (' + seg.tipo + ')';

            if (seg.tipo === 'retrato' && seg.html.trim() === '') {
                continue;
            }

            const page = await browser.newPage();
            let buffer;

            try {
                if (seg.tipo === 'retrato') {
                    log(jobId, '    ' + rotulo + ' - carregando...');
                    const htmlRetratoLimpo = removerMarcadoresDeLogo(seg.html);
                    await page.setContent(blocoGeometria + htmlRetratoLimpo, { waitUntil: ESPERA_RENDER, timeout: 120000 });
                    log(jobId, '    ' + rotulo + ' - imprimindo...');
                    buffer = await page.pdf(pdfOptionsRetrato);
                } else {
                    log(jobId, '    ' + rotulo + ' - carregando...');
                    const conteudoComCabecalho = ehTemplateSiemens ? injetarCabecalhoPaisagem(seg.html) : removerMarcadoresDeLogo(seg.html);
                    let docPaisagem = '<!DOCTYPE html><html><head><meta charset="utf-8"><style>html, body { margin: 0; padding: 0; } table { max-width: 100% !important; } th, td { overflow-wrap: break-word; word-wrap: break-word; }</style></head><body>' + conteudoComCabecalho + '</body></html>';
                    await page.setContent(docPaisagem, { waitUntil: ESPERA_RENDER, timeout: 120000 });
                    log(jobId, '    ' + rotulo + ' - imprimindo...');
                    buffer = await page.pdf(pdfOptionsPaisagem);
                }
            } finally {
                // Fecha a aba ANTES de qualquer outra coisa, devolvendo
                // ao sistema a memoria que o Chromium usou neste segmento
                await page.close();
            }

            const caminho = path.join(os.tmpdir(), prefixoTmp + '_seg' + i + '.pdf');
            await fs.promises.writeFile(caminho, buffer);
            arquivosTmp.push(caminho);
            buffer = null;
            liberarMemoria();

            log(jobId, '    ' + rotulo + ' OK (salvo em disco)');
        }

        log(jobId, '    juntando ' + arquivosTmp.length + ' arquivo(s) em um PDF unico...');
        const pdfFinal = await PDFDocument.create();
        for (const caminho of arquivosTmp) {
            const buf = await fs.promises.readFile(caminho);
            const src = await PDFDocument.load(buf);
            const paginasCopiadas = await pdfFinal.copyPages(src, src.getPageIndices());
            paginasCopiadas.forEach(function (p) { pdfFinal.addPage(p); });
            await fs.promises.unlink(caminho).catch(function () { });
            liberarMemoria();
        }
        bufferFinal = Buffer.from(await pdfFinal.save());
        log(jobId, '    PDF unico montado');
        liberarMemoria();
    }

    return { buffer: bufferFinal, temSegmentosPaisagem: temSegmentosPaisagem };
}

// =========================================================================
// POS-PROCESSAMENTO UNIFICADO (rodape + indice)
//
// Uma unica leitura (pdfParse), um load e um save, com as duas correcoes
// aplicadas no mesmo documento em memoria.
// =========================================================================
async function posProcessarPDF(jobId, pdfBuffer, mapaDestinos, mLateralPt, corrigirRodape) {
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
    log(jobId, '    texto do PDF final extraido (' + pagesItems.length + ' paginas)');

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
        log(jobId, '    rodape corrigido em ' + corrigidas + ' pagina(s)');
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
                // (border-bottom do CSS) seja totalmente coberto.
                const rowTop = numItem.y - 6;
                const rowBottom = numItem.y + alturaFonte + 6;
                const rowHeight = rowBottom - rowTop;

                const whiteFromX = oc.titleEndX + 2;
                paginaOrigem.drawRectangle({
                    x: whiteFromX,
                    y: rowTop,
                    width: Math.max(0, pageWidth - whiteFromX),
                    height: rowHeight,
                    color: rgb(1, 1, 1)
                });

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

        log(jobId, '    indice: ' + linksCriados + ' link(s) criado(s)');
    }

    pagesItems.length = 0;
    liberarMemoria();

    return Buffer.from(await pdfDoc.save());
}

// =========================================================================
// PROCESSAMENTO EM SEGUNDO PLANO
//
// Esta funcao NAO e aguardada (sem await) pelo endpoint POST /gerar-pdf.
// Ela roda por conta propria e vai atualizando o arquivo de status do job.
// Por isso, todo o corpo precisa estar dentro de try/catch: um erro nao
// tratado aqui derrubaria o processo inteiro do Node, ja que nao existe
// ninguem "acima" para capturar a excecao.
// =========================================================================
async function processarJob(jobId, parametros) {
    let browser;
    const prefixoTmp = 'fpt_' + jobId;

    try {
        let htmlContent = parametros.html;
        log(jobId, 'HTML recebido: ' + (htmlContent.length / 1024).toFixed(0) + ' KB');

        const headerRaw = parametros.cabecalho || '<div></div>';
        const footerRaw = parametros.rodape || '<div></div>';
        const mTop = parametros.margemTop || '10mm';
        const mBottom = parametros.margemBottom || '55mm';
        const mLateral = parametros.margemLateral || '15mm';
        const tamanhoPapel = parametros.tamanhoPapel || 'A4';

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

        await gravarStatus(jobId, { status: 'PROCESSANDO', etapa: 'Iniciando navegador' });
        log(jobId, 'Iniciando navegador (Puppeteer)...');

        browser = await puppeteer.launch({
            headless: 'new',
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-zygote',
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
        log(jobId, 'Navegador iniciado');

        const mapaDestinos = {};

        if (htmlContent.includes('#ANC_')) {
            await gravarStatus(jobId, { status: 'PROCESSANDO', etapa: 'Calculando paginas do indice (1/4)' });
            log(jobId, 'ETAPA 1/4 - Renderizando PDF fantasma (para calcular as paginas do indice)...');

            const htmlFantasma = htmlContent.replace(/\{\{PAG_CAP_[A-Za-z0-9_]+\}\}/g, '000');
            const resultadoFantasma = await renderizarDocumento(jobId, browser, htmlFantasma, blocoGeometria, pdfOptionsRetrato, pdfOptionsPaisagem, ehTemplateSiemens, prefixoTmp + '_ghost');
            log(jobId, 'ETAPA 1/4 - PDF fantasma pronto');

            await gravarStatus(jobId, { status: 'PROCESSANDO', etapa: 'Lendo estrutura do documento (2/4)' });
            log(jobId, 'ETAPA 2/4 - Extraindo texto do PDF fantasma (pdf-parse)...');
            const pdfData = await pdfParse(resultadoFantasma.buffer, { pagerender: render_page });

            resultadoFantasma.buffer = null;
            liberarMemoria();

            const pages = pdfData.text.split('\n---PAGE_BREAK---\n');
            log(jobId, 'ETAPA 2/4 - Texto extraido de ' + pages.length + ' pagina(s)');

            const pagesNormalizadas = pages.map(function (p) { return normalizarAncora(p); });
            const anchors = htmlContent.match(/#ANC_[A-Za-z0-9_]+#/g);

            if (anchors) {
                const uniqueAnchors = [...new Set(anchors)];
                log(jobId, 'Mapeando ' + uniqueAnchors.length + ' ancora(s) unica(s)...');
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
                        log(jobId, '  AVISO: ancora ' + codigo + ' NAO encontrada no PDF (vai sair como ---)');
                    }
                    htmlContent = htmlContent.split(anchor).join('');
                });
                log(jobId, 'Ancoras mapeadas: ' + Object.keys(mapaDestinos).length + ' de ' + uniqueAnchors.length);
            }

            const orfaos = htmlContent.match(/\{\{PAG_[A-Za-z0-9_]+\}\}/g);
            if (orfaos) {
                const listaOrfaos = [...new Set(orfaos)];
                log(jobId, 'Substituindo ' + listaOrfaos.length + ' placeholder(s) orfao(s) por "---"');
                listaOrfaos.forEach(function (o) { htmlContent = htmlContent.split(o).join('---'); });
            }

            pages.length = 0;
            pagesNormalizadas.length = 0;
            pdfData.text = '';
            liberarMemoria();
        }

        await gravarStatus(jobId, { status: 'PROCESSANDO', etapa: 'Montando o documento final (3/4)' });
        log(jobId, 'ETAPA 3/4 - Renderizando PDF final...');

        const resultadoFinal = await renderizarDocumento(jobId, browser, htmlContent, blocoGeometria, pdfOptionsRetrato, pdfOptionsPaisagem, ehTemplateSiemens, prefixoTmp + '_final');
        let finalPdfBuffer = resultadoFinal.buffer;
        log(jobId, 'ETAPA 3/4 - PDF final pronto (' + (finalPdfBuffer.length / 1024 / 1024).toFixed(1) + ' MB)');

        log(jobId, 'Fechando navegador (nao e mais necessario)...');
        await browser.close();
        browser = null;
        liberarMemoria();

        const precisaRodape = resultadoFinal.temSegmentosPaisagem;
        const precisaIndice = Object.keys(mapaDestinos).length > 0;

        if (precisaRodape || precisaIndice) {
            await gravarStatus(jobId, { status: 'PROCESSANDO', etapa: 'Ajustando indice e numeracao (4/4)' });
            log(jobId, 'ETAPA 4/4 - Pos-processamento (rodape + indice em uma unica passagem)...');
            const mLateralPt = mmParaPt(mLateral);
            finalPdfBuffer = await posProcessarPDF(jobId, finalPdfBuffer, precisaIndice ? mapaDestinos : null, mLateralPt, precisaRodape);
            log(jobId, 'ETAPA 4/4 - Pos-processamento concluido');
        } else {
            log(jobId, 'ETAPA 4/4 - Pulada (nada a corrigir)');
        }

        // Grava o PDF pronto em disco e marca o job como concluido
        await fs.promises.writeFile(caminhoPdf(jobId), finalPdfBuffer);
        const tamanhoMb = (finalPdfBuffer.length / 1024 / 1024).toFixed(2);
        finalPdfBuffer = null;
        liberarMemoria();

        await gravarStatus(jobId, {
            status: 'CONCLUIDO',
            etapa: 'Pronto para download',
            tamanhoMB: tamanhoMb
        });
        log(jobId, '===== CONCLUIDO COM SUCESSO (' + tamanhoMb + ' MB) =====');

    } catch (error) {
        log(jobId, '===== ERRO FATAL =====');
        console.error('🚨 Erro no job ' + jobId + ':', error);
        await gravarStatus(jobId, {
            status: 'ERRO',
            etapa: 'Falhou',
            erro: String(error && error.message ? error.message : error)
        }).catch(function () { });
    } finally {
        if (browser) {
            await browser.close().catch(function () { });
        }
        // Remove os arquivos temporarios de segmento deste job
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
        encerrarCronometro(jobId);
        liberarMemoria();
    }
}

// =========================================================================
// ENDPOINT 1 - INICIAR A GERACAO
//
// Responde IMEDIATAMENTE (202 Accepted) com o jobId. O trabalho pesado
// acontece depois, em segundo plano. E isso que elimina o teto de 120s
// do conector HTTP do Power Automate.
// =========================================================================
app.post('/gerar-pdf', async (req, res) => {
    if (!req.body || typeof req.body.html !== 'string' || req.body.html.trim() === '') {
        return res.status(400).json({ erro: "O campo 'html' é obrigatório e deve ser um texto não vazio." });
    }

    const jobId = crypto.randomUUID();
    iniciarCronometro(jobId);
    log(jobId, '===== NOVO JOB RECEBIDO =====');

    // Faxina de jobs vencidos (nao bloqueia a resposta)
    limparJobsAntigos().catch(function () { });

    try {
        await gravarStatus(jobId, { status: 'PROCESSANDO', etapa: 'Na fila' });
    } catch (e) {
        log(jobId, 'ERRO ao criar o arquivo de status: ' + e.message);
        return res.status(500).json({ erro: 'Nao foi possivel registrar o job: ' + e.message });
    }

    // Copia os parametros ANTES de responder, porque o objeto req pode
    // ser reciclado pelo Express depois que a resposta e enviada.
    const parametros = {
        html: req.body.html,
        cabecalho: req.body.cabecalho,
        rodape: req.body.rodape,
        margemTop: req.body.margemTop,
        margemBottom: req.body.margemBottom,
        margemLateral: req.body.margemLateral,
        tamanhoPapel: req.body.tamanhoPapel
    };

    // Responde na hora - o Power Automate segue a vida
    res.status(202).json({ jobId: jobId, status: 'PROCESSANDO' });

    // Dispara o trabalho pesado SEM await (proposital).
    // O .catch e uma rede de seguranca extra: processarJob ja trata os
    // proprios erros internamente, mas se algo escapar, isso impede que
    // uma "unhandled rejection" derrube o processo do Node.
    processarJob(jobId, parametros).catch(function (err) {
        console.error('Falha nao tratada no job ' + jobId + ':', err);
    });
});

// =========================================================================
// ENDPOINT 2 - CONSULTAR O ANDAMENTO
//
// Resposta pequena e rapida (JSON de poucos bytes). E este endpoint que o
// Power Apps consulta em loop, a cada 10 segundos.
// =========================================================================
app.get('/status/:jobId', async (req, res) => {
    const jobId = req.params.jobId;
    const registro = await lerStatus(jobId);

    if (!registro) {
        return res.status(404).json({
            status: 'NAO_ENCONTRADO',
            erro: 'Job inexistente ou ja expirado (os jobs sao mantidos por 30 minutos).'
        });
    }

    res.json(registro);
});

// =========================================================================
// ENDPOINT 3 - BAIXAR O PDF PRONTO
//
// Devolve o arquivo em base64, no mesmo formato que a versao anterior
// retornava - assim o "Create file" do Power Automate continua usando
// base64ToBinary(body('HTTP')?['pdfBase64']) sem alteracao.
// =========================================================================
app.get('/download/:jobId', async (req, res) => {
    const jobId = req.params.jobId;
    const registro = await lerStatus(jobId);

    if (!registro) {
        return res.status(404).json({ erro: 'Job inexistente ou ja expirado.' });
    }
    if (registro.status === 'ERRO') {
        return res.status(500).json({ erro: registro.erro || 'O job terminou com erro.' });
    }
    if (registro.status !== 'CONCLUIDO') {
        return res.status(409).json({
            status: registro.status,
            etapa: registro.etapa,
            erro: 'O PDF ainda nao esta pronto.'
        });
    }

    try {
        const buffer = await fs.promises.readFile(caminhoPdf(jobId));
        res.json({ pdfBase64: buffer.toString('base64') });
    } catch (e) {
        res.status(500).json({ erro: 'Arquivo do PDF nao encontrado no servidor: ' + e.message });
    }
});

// =========================================================================
// ENDPOINT 4 - LIBERAR O JOB (opcional)
//
// Chamado pelo fluxo depois de salvar o PDF no SharePoint, para devolver
// o espaco em disco sem esperar os 30 minutos de validade.
// =========================================================================
app.delete('/job/:jobId', async (req, res) => {
    const jobId = req.params.jobId;
    await fs.promises.unlink(caminhoStatus(jobId)).catch(function () { });
    await fs.promises.unlink(caminhoPdf(jobId)).catch(function () { });
    res.json({ removido: true, jobId: jobId });
});

// Endpoint simples para verificar se o servico esta no ar
app.get('/', (req, res) => {
    res.json({ servico: 'API PDF FPT', modo: 'assincrono', memoriaMB: mem() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Ativo na porta ' + PORT + ' (modo assincrono)'));
