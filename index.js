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
        const htmlLimpo = removerMarcadoresDeLogo(htmlContent);
        await page.setContent(blocoGeometria + htmlLimpo, { waitUntil: 'networkidle0', timeout: 120000 });
        bufferFinal = await page.pdf(pdfOptionsRetrato);
    } else {
        temSegmentosPaisagem = true;
        const segmentos = dividirEmSegmentos(htmlContent);
        const buffersGerados = [];
        for (let i = 0; i < segmentos.length; i++) {
            const seg = segmentos[i];
            if (seg.tipo === 'retrato') {
                if (seg.html.trim() === '') continue;
                const htmlRetratoLimpo = removerMarcadoresDeLogo(seg.html);
                await page.setContent(blocoGeometria + htmlRetratoLimpo, { waitUntil: 'networkidle0', timeout: 120000 });
                buffersGerados.push(await page.pdf(pdfOptionsRetrato));
            } else {
                const conteudoComCabecalho = ehTemplateSiemens ? injetarCabecalhoPaisagem(seg.html) : removerMarcadoresDeLogo(seg.html);
                let docPaisagem = '<!DOCTYPE html><html><head><meta charset="utf-8"><style>html, body { margin: 0; padding: 0; } table { max-width: 100% !important; } th, td { overflow-wrap: break-word; word-wrap: break-word; }</style></head><body>' + conteudoComCabecalho + '</body></html>';
                await page.setContent(docPaisagem, { waitUntil: 'networkidle0', timeout: 120000 });
                buffersGerados.push(await page.pdf(pdfOptionsPaisagem));
            }
        }
        const pdfFinal = await PDFDocument.create();
        for (const buf of buffersGerados) {
            const src = await PDFDocument.load(buf);
            const paginasCopiadas = await pdfFinal.copyPages(src, src.getPageIndices());
            paginasCopiadas.forEach(function (p) { pdfFinal.addPage(p); });
        }
        bufferFinal = Buffer.from(await pdfFinal.save());
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
// INTEIRA (title->numero) num unico estilo + cria os links.
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
            // Busca o numero (ex: "002") antes da marca invisivel
            for (let k = idx - 1; k >= 0; k--) {
                const cand = items[k];
                if (Math.abs(cand.y - item.y) > 2) break;
                if (/^\d{3}$/.test(cand.str.trim())) { numItem = cand; break; }
            }

            const rowY = numItem ? numItem.y : item.y;
            
            // NOVO CALCULO DA LARGURA DO TITULO
            // Ao inves de varrer a linha inteira (que quebra se houver residuos longos),
            // varremos da esquerda ate bater nos primeiros pontos do indice ou espacos vazios grandes.
            let titleEndX = 0;
            let temTituloNaLinha = false;
            
            // Ordena os itens da linha da esquerda para a direita
            const itensLinha = items.filter(it => Math.abs(it.y - rowY) <= 2).sort((a,b) => a.x - b.x);
            
            for (let cand of itensLinha) {
                // Se chegou no numero da pagina ou marcador invisivel, para.
                if (cand === numItem || cand === item) break;
                
                // Se bateu nos pontinhos gerados nativamente pelo navegador, para.
                if (cand.str.includes('......')) break; 
                
                const rightEdge = cand.x + cand.width;
                if (rightEdge > titleEndX) {
                    titleEndX = rightEdge;
                    temTituloNaLinha = true;
                }
            }

            // Se nao achou nada, cai pra um fallback defensivo
            if (!temTituloNaLinha && numItem) {
                titleEndX = numItem.x - 50; 
            }

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

            const rowTop = numItem.y - 3;
            const rowBottom = numItem.y + numItem.fontHeight + 3;
            const rowHeight = rowBottom - rowTop;

            // ---------------------------------------------------------
            // APAGA TUDO A PARTIR DA MARGEM SEGURA.
            // Recuamos um pouco menos para garantir que a ultima letra
            // do titulo nao seja comida pela caixa branca.
            // ---------------------------------------------------------
            // Adicionamos +4 pixels de respiro apos a ultima letra
            const whiteFromX = oc.titleEndX + 4; 
            
            paginaOrigem.drawRectangle({
                x: whiteFromX,
                y: rowTop,
                width: Math.max(0, pageWidth - whiteFromX),
                height: rowHeight,
                color: rgb(1, 1, 1)
            });

            // Redesenha o pontilhado INTEIRO a partir da margem segura
            const dotY = numItem.y - 1.5;
            const dotsFromX = whiteFromX + 2;
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
    try {
        if (!req.body || typeof req.body.html !== 'string' || req.body.html.trim() === '') {
            return res.status(400).json({ erro: "O campo 'html' é obrigatório e deve ser um texto não vazio." });
        }

        let htmlContent = req.body.html;
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

        browser = await puppeteer.launch({
            headless: 'new',
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote']
        });

        const page = await browser.newPage();
        const mapaDestinos = {};

        if (htmlContent.includes('#ANC_')) {
            const htmlFantasma = htmlContent.replace(/\{\{PAG_CAP_[A-Za-z0-9_]+\}\}/g, '000');
            const resultadoFantasma = await renderizarDocumento(page, htmlFantasma, blocoGeometria, pdfOptionsRetrato, pdfOptionsPaisagem, ehTemplateSiemens);
            const pdfData = await pdfParse(resultadoFantasma.buffer, { pagerender: render_page });
            const pages = pdfData.text.split('\n---PAGE_BREAK---\n');
            const pagesNormalizadas = pages.map(function (p) { return normalizarAncora(p); });
            const anchors = htmlContent.match(/#ANC_[A-Za-z0-9_]+#/g);

            if (anchors) {
                const uniqueAnchors = [...new Set(anchors)];
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
                    }
                    htmlContent = htmlContent.split(anchor).join('');
                });
            }

            const orfaos = htmlContent.match(/\{\{PAG_[A-Za-z0-9_]+\}\}/g);
            if (orfaos) {
                [...new Set(orfaos)].forEach(function (o) { htmlContent = htmlContent.split(o).join('---'); });
            }
        }

        const resultadoFinal = await renderizarDocumento(page, htmlContent, blocoGeometria, pdfOptionsRetrato, pdfOptionsPaisagem, ehTemplateSiemens);
        let finalPdfBuffer = resultadoFinal.buffer;

        if (resultadoFinal.temSegmentosPaisagem) {
            finalPdfBuffer = await corrigirNumeracaoRodape(finalPdfBuffer);
        }

        if (Object.keys(mapaDestinos).length > 0) {
            const mLateralPt = mmParaPt(mLateral);
            finalPdfBuffer = await processarIndice(finalPdfBuffer, mapaDestinos, mLateralPt);
        }

        res.json({ pdfBase64: finalPdfBuffer.toString('base64') });

    } catch (error) {
        console.error("🚨 Erro Fatal:", error);
        res.status(500).json({ erro: error.toString() });
    } finally {
        if (browser) await browser.close();
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Ativo na porta ' + PORT));
