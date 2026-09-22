const express = require('express');
const puppeteer = require('puppeteer');
const pdfParse = require('pdf-parse');
const { PDFDocument, StandardFonts, rgb, PDFName } = require('pdf-lib');

const app = express();
app.use(express.json({ limit: '50mb' }));

const LANDSCAPE_START = '<!--LANDSCAPE_START-->';
const LANDSCAPE_END = '<!--LANDSCAPE_END-->';
const LOGO_ESQ_START = '<!--LOGO_ESQ-->';
const LOGO_ESQ_END = '<!--/LOGO_ESQ-->';
const LOGO_DIR_START = '<!--LOGO_DIR-->';
const LOGO_DIR_END = '<!--/LOGO_DIR-->';

// =========================================================================
// LOGGER DE PROGRESSO (novo)
//
// Definido no escopo do MODULO (nao dentro do handler) para que a funcao
// renderizarDocumento() tambem consiga chamar o log, mostrando o avanco
// segmento a segmento.
//
// O cronometro (_t0) e reiniciado no inicio de cada requisicao pela
// funcao iniciarCronometro(), chamada dentro do POST /gerar-pdf.
//
// Como usar: no Render, abra o servico -> aba "Logs". As mensagens
// aparecem em tempo real com o tempo decorrido desde o inicio da
// requisicao, permitindo identificar exatamente qual etapa esta lenta.
// =========================================================================
let _t0 = Date.now();

function iniciarCronometro() {
    _t0 = Date.now();
}

function log(etapa) {
    const seg = ((Date.now() - _t0) / 1000).toFixed(1);
    console.log('[' + seg + 's] ' + etapa);
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

async function renderizarDocumento(page, htmlContent, blocoGeometria, pdfOptionsRetrato, pdfOptionsPaisagem, ehTemplateSiemens) {
    let temSegmentosPaisagem = false;
    let bufferFinal;

    if (!htmlContent.includes(LANDSCAPE_START)) {
        log('    documento unico (sem paisagem) - carregando HTML no navegador...');
        const htmlLimpo = removerMarcadoresDeLogo(htmlContent);
        await page.setContent(blocoGeometria + htmlLimpo, { waitUntil: 'networkidle0', timeout: 120000 });
        log('    HTML carregado - imprimindo PDF...');
        bufferFinal = await page.pdf(pdfOptionsRetrato);
        log('    PDF impresso');
    } else {
        temSegmentosPaisagem = true;
        const segmentos = dividirEmSegmentos(htmlContent);
        log('    documento com ' + segmentos.length + ' segmento(s) (retrato/paisagem)');
        const buffersGerados = [];
        for (let i = 0; i < segmentos.length; i++) {
            const seg = segmentos[i];
            if (seg.tipo === 'retrato') {
                if (seg.html.trim() === '') continue;
                log('    segmento ' + (i + 1) + '/' + segmentos.length + ' (retrato) - carregando...');
                const htmlRetratoLimpo = removerMarcadoresDeLogo(seg.html);
                await page.setContent(blocoGeometria + htmlRetratoLimpo, { waitUntil: 'networkidle0', timeout: 120000 });
                log('    segmento ' + (i + 1) + '/' + segmentos.length + ' (retrato) - imprimindo...');
                buffersGerados.push(await page.pdf(pdfOptionsRetrato));
                log('    segmento ' + (i + 1) + '/' + segmentos.length + ' (retrato) OK');
            } else {
                log('    segmento ' + (i + 1) + '/' + segmentos.length + ' (paisagem) - carregando...');
                const conteudoComCabecalho = ehTemplateSiemens ? injetarCabecalhoPaisagem(seg.html) : removerMarcadoresDeLogo(seg.html);
                let docPaisagem = '<!DOCTYPE html><html><head><meta charset="utf-8"><style>html, body { margin: 0; padding: 0; } table { max-width: 100% !important; } th, td { overflow-wrap: break-word; word-wrap: break-word; }</style></head><body>' + conteudoComCabecalho + '</body></html>';
                await page.setContent(docPaisagem, { waitUntil: 'networkidle0', timeout: 120000 });
                log('    segmento ' + (i + 1) + '/' + segmentos.length + ' (paisagem) - imprimindo...');
                buffersGerados.push(await page.pdf(pdfOptionsPaisagem));
                log('    segmento ' + (i + 1) + '/' + segmentos.length + ' (paisagem) OK');
            }
        }
        log('    juntando ' + buffersGerados.length + ' buffer(s) em um PDF unico...');
        const pdfFinal = await PDFDocument.create();
        for (const buf of buffersGerados) {
            const src = await PDFDocument.load(buf);
            const paginasCopiadas = await pdfFinal.copyPages(src, src.getPageIndices());
            paginasCopiadas.forEach(function (p) { pdfFinal.addPage(p); });
        }
        bufferFinal = Buffer.from(await pdfFinal.save());
        log('    PDF unico montado');
    }
    return { buffer: bufferFinal, temSegmentosPaisagem: temSegmentosPaisagem };
}

async function corrigirNumeracaoRodape(pdfBuffer) {
    const pagesItems = [];
    function custom_render_page(pageData) {
        return pageData.getTextContent().then(function (textContent) {
            pagesItems.push(textContent.items.map(function (item) {
                return { str: item.str, x: item.transform[4], y: item.transform[5], width: item.width, fontHeight: Math.hypot(item.transform[2], item.transform[3]) || 8.5 };
            }));
            return '';
        });
    }
    await pdfParse(pdfBuffer, { pagerender: custom_render_page });
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const totalPaginas = pdfDoc.getPageCount();
    const fonteCorrecao = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    for (let i = 0; i < pagesItems.length; i++) {
        const items = pagesItems[i];
        const idxMarcador = items.findIndex(function (it) { return /FOLHA\s*:?/i.test(it.str); });
        if (idxMarcador === -1) continue;
        const baseY = items[idxMarcador].y;
        const baseX = items[idxMarcador].x;
        const itensDaLinha = items.filter(function (it) { return Math.abs(it.y - baseY) < 2 && it.x >= baseX - 2; });
        if (itensDaLinha.length === 0) continue;
        const minX = Math.min.apply(null, itensDaLinha.map(function (it) { return it.x; }));
        const maxX = Math.max.apply(null, itensDaLinha.map(function (it) { return it.x + it.width; }));
        const fontSize = items[idxMarcador].fontHeight;
        const alturaCaixa = fontSize * 1.5;
        const yCaixa = baseY - alturaCaixa * 0.3;
        const pagina = pdfDoc.getPage(i);
        pagina.drawRectangle({ x: minX - 3, y: yCaixa, width: (maxX - minX) + 6, height: alturaCaixa, color: rgb(1, 1, 1) });
        pagina.drawText('FOLHA: ' + (i + 1) + ' de ' + totalPaginas, { x: minX, y: baseY, size: fontSize, font: fonteCorrecao, color: rgb(0, 0, 0) });
    }
    return Buffer.from(await pdfDoc.save());
}

// =========================================================================
// REALINHA numeros do indice a margem real + redesenha a linha pontilhada
// INTEIRA (titulo->numero) num unico estilo + cria os links.
//
// FIX APLICADO NESTA VERSAO: a busca do "fim do titulo" (titleEndX) so
// olhava itens na MESMA altura Y do numero (tolerancia de 2pt) - mas o
// titulo principal (negrito, MAIOR) fica na linha de CIMA, e a traducao
// (menor, italico) fica na linha de BAIXO, na mesma altura do numero.
// Isso fazia o codigo enxergar so o fim da traducao (mais curta) e
// comecar a apagar/redesenhar ANTES do fim do texto em negrito - cortando
// visualmente o final das palavras do titulo principal.
//
// CORRECAO: a tolerancia de busca de "itens na mesma linha logica" foi
// ampliada de 2pt para 16pt - suficiente para cobrir tanto a linha do
// titulo principal quanto a linha da traducao logo abaixo, garantindo
// que titleEndX reflita o fim do texto MAIS LONGO entre as duas linhas.
// =========================================================================
async function processarIndice(pdfBuffer, mapaDestinos, mLateralPt) {
    const pagesItems = [];
    function custom_render_page(pageData) {
        return pageData.getTextContent().then(function (textContent) {
            pagesItems.push(textContent.items.map(function (item) {
                return { str: item.str, x: item.transform[4], y: item.transform[5], width: item.width, fontHeight: Math.hypot(item.transform[2], item.transform[3]) || 9 };
            }));
            return '';
        });
    }
    await pdfParse(pdfBuffer, { pagerender: custom_render_page });

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
                // CORRIGIDO: tolerancia de 16pt (era 2pt) para tambem
                // enxergar a linha do titulo principal (negrito, maior,
                // uma linha acima da traducao) na mesma "linha logica".
                if (Math.abs(it.y - rowY) > 16) return;
                if (it === numItem || it === item) return;
                if (it.x >= limiteX) return;
                const rightEdge = it.x + it.width;
                if (titleEndX === null || rightEdge > titleEndX) titleEndX = rightEdge;
            });

            ocorrencias.push({ codigo: codigo, pageIndex: p, markerX: item.x, markerY: item.y, numItem: numItem, titleEndX: titleEndX });
        }
    }

    if (ocorrencias.length === 0) return pdfBuffer;

    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const pages = pdfDoc.getPages();
    const context = pdfDoc.context;
    const fonteNormal = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fonteBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    const BUFFER_MARGEM = 2;
    const LARGURA_LINK_PADRAO = 34;
    const DOT_RADIUS = 0.4;
    const DOT_PERIOD = 2.5;

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
            const novoX = targetRightX - numItem.width;

            const numUnderscores = (oc.codigo.match(/_/g) || []).length;
            const fonteEscolhida = (numUnderscores === 1) ? fonteBold : fonteNormal;

            // A area apagada/redesenhada cobre SOMENTE a altura da linha
            // do NUMERO (nao a linha do titulo em negrito acima) - so a
            // deteccao do fim do texto usa a tolerancia ampliada; o
            // desenho continua restrito a linha correta.
            //
            // CORRIGIDO: margem vertical ampliada de 3pt para 6pt. O
            // pontilhado original (CSS border-bottom) pode nao estar
            // exatamente alinhado com o y do texto - com margem pequena,
            // uma tira fina do pontilhado antigo sobrava sem ser apagada,
            // aparecendo ao lado do pontilhado novo (dois estilos juntos).
            const rowTop = numItem.y - 6;
            const rowBottom = numItem.y + numItem.fontHeight + 6;
            const rowHeight = rowBottom - rowTop;

            // Apaga do fim do titulo ATE A BORDA FISICA DA PAGINA - nao
            // ha calculo de "onde parar", entao nao sobra nenhum resquicio
            // do numero/pontilhado antigo, seja qual for o valor de delta.
            const whiteFromX = oc.titleEndX + 2;
            paginaOrigem.drawRectangle({
                x: whiteFromX,
                y: rowTop,
                width: Math.max(0, pageWidth - whiteFromX),
                height: rowHeight,
                color: rgb(1, 1, 1)
            });

            // Redesenha o pontilhado INTEIRO, de um so estilo, do fim do
            // titulo ate pouco antes do numero (posicao final).
            const dotY = numItem.y - 1.5;
            const dotsFromX = oc.titleEndX + 4;
            const dotsToX = novoX - 3;
            for (let px = dotsFromX; px < dotsToX; px += DOT_PERIOD) {
                paginaOrigem.drawCircle({ x: px, y: dotY, size: DOT_RADIUS, color: rgb(0, 0, 0) });
            }

            // Redesenha o numero na posicao final, rente a margem real
            paginaOrigem.drawText(numItem.str, {
                x: novoX,
                y: numItem.y,
                size: numItem.fontHeight,
                font: fonteEscolhida,
                color: rgb(0, 0, 0)
            });

            rectX0 = Math.max(0, novoX - 2);
            rectX1 = novoX + numItem.width + 2;
            rectY0 = numItem.y - 2;
            rectY1 = numItem.y + numItem.fontHeight + 2;
        } else if (oc.numItem) {
            rectX0 = Math.max(0, oc.numItem.x - 2);
            rectX1 = oc.numItem.x + oc.numItem.width + 2;
            rectY0 = oc.numItem.y - 2;
            rectY1 = oc.numItem.y + oc.numItem.fontHeight + 2;
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
    });

    return Buffer.from(await pdfDoc.save());
}

app.post('/gerar-pdf', async (req, res) => {
    let browser;

    // Reinicia o cronometro a cada requisicao
    iniciarCronometro();
    log('===== NOVA REQUISICAO RECEBIDA =====');

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
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote']
        });
        log('Navegador iniciado');

        const page = await browser.newPage();
        const mapaDestinos = {};

        if (htmlContent.includes('#ANC_')) {
            log('ETAPA 1/5 - Renderizando PDF fantasma (para calcular as paginas do indice)...');
            const htmlFantasma = htmlContent.replace(/\{\{PAG_CAP_[A-Za-z0-9_]+\}\}/g, '000');
            const resultadoFantasma = await renderizarDocumento(page, htmlFantasma, blocoGeometria, pdfOptionsRetrato, pdfOptionsPaisagem, ehTemplateSiemens);
            log('ETAPA 1/5 - PDF fantasma pronto');

            log('ETAPA 2/5 - Extraindo texto do PDF fantasma (pdf-parse)...');
            const pdfData = await pdfParse(resultadoFantasma.buffer, { pagerender: render_page });
            const pages = pdfData.text.split('\n---PAGE_BREAK---\n');
            log('ETAPA 2/5 - Texto extraido de ' + pages.length + ' pagina(s)');

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
        }

        log('ETAPA 3/5 - Renderizando PDF final...');
        const resultadoFinal = await renderizarDocumento(page, htmlContent, blocoGeometria, pdfOptionsRetrato, pdfOptionsPaisagem, ehTemplateSiemens);
        let finalPdfBuffer = resultadoFinal.buffer;
        log('ETAPA 3/5 - PDF final pronto (' + (finalPdfBuffer.length / 1024 / 1024).toFixed(1) + ' MB)');

        if (resultadoFinal.temSegmentosPaisagem) {
            log('ETAPA 4/5 - Corrigindo numeracao do rodape...');
            finalPdfBuffer = await corrigirNumeracaoRodape(finalPdfBuffer);
            log('ETAPA 4/5 - Numeracao corrigida');
        } else {
            log('ETAPA 4/5 - Pulada (documento sem segmentos em paisagem)');
        }

        if (Object.keys(mapaDestinos).length > 0) {
            log('ETAPA 5/5 - Processando indice (alinhamento, pontilhado e links)...');
            const mLateralPt = mmParaPt(mLateral);
            finalPdfBuffer = await processarIndice(finalPdfBuffer, mapaDestinos, mLateralPt);
            log('ETAPA 5/5 - Indice processado');
        } else {
            log('ETAPA 5/5 - Pulada (nenhuma ancora mapeada)');
        }

        log('Convertendo para base64 e enviando resposta...');
        res.json({ pdfBase64: finalPdfBuffer.toString('base64') });
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
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Ativo na porta ' + PORT));
