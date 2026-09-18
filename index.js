const express = require('express');
const puppeteer = require('puppeteer');
const pdfParse = require('pdf-parse');
const { PDFDocument, StandardFonts, rgb, PDFName } = require('pdf-lib');

const app = express();
app.use(express.json({ limit: '50mb' }));

// =========================================================================
// MARCADORES DE SECAO EM PAISAGEM
// =========================================================================
const LANDSCAPE_START = '<!--LANDSCAPE_START-->';
const LANDSCAPE_END = '<!--LANDSCAPE_END-->';

// =========================================================================
// MARCADORES DE LOGO
// =========================================================================
const LOGO_ESQ_START = '<!--LOGO_ESQ-->';
const LOGO_ESQ_END = '<!--/LOGO_ESQ-->';
const LOGO_DIR_START = '<!--LOGO_DIR-->';
const LOGO_DIR_END = '<!--/LOGO_DIR-->';

// =========================================================================
// HELPER: converte string tipo "15mm" em pontos PDF (1mm = 2.83465pt)
// =========================================================================
function mmParaPt(valorStr) {
    if (!valorStr) return 0;
    const numero = parseFloat(String(valorStr).replace(',', '.'));
    if (isNaN(numero)) return 0;
    return numero * 2.83465;
}

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
// =========================================================================
function dividirEmSegmentos(html) {
    const segmentos = [];
    let restante = html;

    while (restante.includes(LANDSCAPE_START)) {
        const partesInicio = restante.split(LANDSCAPE_START);
        const antes = partesInicio[0];
        const depoisDoInicio = partesInicio[1];
        segmentos.push({ tipo: 'retrato', html: antes });

        const partesFim = depoisDoInicio.split(LANDSCAPE_END);
        const conteudoPaisagem = partesFim[0];
        const depoisDoFim = partesFim[1];
        segmentos.push({ tipo: 'paisagem', html: conteudoPaisagem });

        restante = depoisDoFim;
    }
    segmentos.push({ tipo: 'retrato', html: restante });

    return segmentos;
}

// =========================================================================
// HELPER: extrai o conteudo entre dois marcadores
// =========================================================================
function extrairEntreMarcadores(html, marcadorInicio, marcadorFim) {
    if (!html.includes(marcadorInicio)) {
        return { conteudo: '', htmlRestante: html };
    }
    const partesA = html.split(marcadorInicio);
    const antes = partesA[0];
    const resto = partesA[1];
    const partesB = resto.split(marcadorFim);
    const conteudo = partesB[0];
    const depois = partesB[1];
    return { conteudo: conteudo.trim(), htmlRestante: antes + depois };
}

// =========================================================================
// FUNCAO: injeta o cabecalho (logos) no topo de um segmento em paisagem.
// =========================================================================
function injetarCabecalhoPaisagem(htmlSegmento) {
    let html = htmlSegmento;

    const logoEsq = extrairEntreMarcadores(html, LOGO_ESQ_START, LOGO_ESQ_END);
    html = logoEsq.htmlRestante;

    const logoDir = extrairEntreMarcadores(html, LOGO_DIR_START, LOGO_DIR_END);
    html = logoDir.htmlRestante;

    const base64Esq = logoEsq.conteudo;
    const base64Dir = logoDir.conteudo;

    if (!base64Esq && !base64Dir) {
        return html;
    }

    let imgEsq = '';
    if (base64Esq) {
        imgEsq = '<img src="' + base64Esq + '" height="45" />';
    }

    let imgDir = '';
    if (base64Dir) {
        imgDir = '<img src="' + base64Dir + '" height="45" />';
    }

    let cabecalhoHtml = '';
    cabecalhoHtml += '<table width="100%" cellspacing="0" cellpadding="0" ';
    cabecalhoHtml += 'style="border:none;border-bottom:2px solid #003366;margin-bottom:15px;padding-bottom:10px;">';
    cabecalhoHtml += '<tr>';
    cabecalhoHtml += '<td align="left" style="border:none;padding:0;vertical-align:middle;">' + imgEsq + '</td>';
    cabecalhoHtml += '<td align="right" style="border:none;padding:0;vertical-align:middle;">' + imgDir + '</td>';
    cabecalhoHtml += '</tr>';
    cabecalhoHtml += '</table>';

    return cabecalhoHtml + html;
}

// =========================================================================
// HELPER: remove marcadores de logo sem inserir nada no lugar
// =========================================================================
function removerMarcadoresDeLogo(html) {
    let resultado = html;
    const logoEsq = extrairEntreMarcadores(resultado, LOGO_ESQ_START, LOGO_ESQ_END);
    resultado = logoEsq.htmlRestante;
    const logoDir = extrairEntreMarcadores(resultado, LOGO_DIR_START, LOGO_DIR_END);
    resultado = logoDir.htmlRestante;
    return resultado;
}

// =========================================================================
// HELPER: detecta se o cabecalho recebido do Power Apps esta "vazio"
// =========================================================================
function cabecalhoEstaVazio(headerHtmlProcessado) {
    const semEspacos = headerHtmlProcessado.replace(/\s+/g, '').toLowerCase();
    return semEspacos === '<div></div>' || semEspacos === '';
}

// =========================================================================
// FUNCAO CENTRAL: renderiza um HTML completo em PDF, usando A MESMA logica
// de segmentacao (retrato/paisagem) tanto para o PDF FANTASMA quanto para
// o PDF FINAL.
// =========================================================================
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
                const buf = await page.pdf(pdfOptionsRetrato);
                buffersGerados.push(buf);

            } else {
                const conteudoComCabecalho = ehTemplateSiemens
                    ? injetarCabecalhoPaisagem(seg.html)
                    : removerMarcadoresDeLogo(seg.html);

                let docPaisagem = '<!DOCTYPE html><html><head><meta charset="utf-8">';
                docPaisagem += '<style>';
                docPaisagem += 'html, body { margin: 0; padding: 0; }';
                docPaisagem += 'table { max-width: 100% !important; }';
                docPaisagem += 'th, td { overflow-wrap: break-word; word-wrap: break-word; }';
                docPaisagem += '</style>';
                docPaisagem += '</head><body>' + conteudoComCabecalho + '</body></html>';

                await page.setContent(docPaisagem, { waitUntil: 'networkidle0', timeout: 120000 });
                const buf = await page.pdf(pdfOptionsPaisagem);
                buffersGerados.push(buf);
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

// =========================================================================
// CORRECAO DA NUMERACAO GLOBAL "FOLHA: X de Y"
// =========================================================================
async function corrigirNumeracaoRodape(pdfBuffer) {
    const pagesItems = [];

    function custom_render_page(pageData) {
        return pageData.getTextContent().then(function (textContent) {
            const items = textContent.items.map(function (item) {
                return {
                    str: item.str,
                    x: item.transform[4],
                    y: item.transform[5],
                    width: item.width,
                    fontHeight: Math.hypot(item.transform[2], item.transform[3]) || 8.5
                };
            });
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

        const idxMarcador = items.findIndex(function (it) {
            return /FOLHA\s*:?/i.test(it.str);
        });
        if (idxMarcador === -1) {
            console.log('⚠️ Página ' + (i + 1) + ': marcador "FOLHA" não encontrado, numeração não corrigida nesta página.');
            continue;
        }

        const baseY = items[idxMarcador].y;
        const baseX = items[idxMarcador].x;

        const itensDaLinha = items.filter(function (it) {
            return Math.abs(it.y - baseY) < 2 && it.x >= baseX - 2;
        });

        if (itensDaLinha.length === 0) continue;

        const minX = Math.min.apply(null, itensDaLinha.map(function (it) { return it.x; }));
        const maxX = Math.max.apply(null, itensDaLinha.map(function (it) { return it.x + it.width; }));
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

        pagina.drawText('FOLHA: ' + (i + 1) + ' de ' + totalPaginas, {
            x: minX,
            y: baseY,
            size: fontSize,
            font: fonteCorrecao,
            color: rgb(0, 0, 0)
        });

        console.log('✅ Página ' + (i + 1) + ': numeração corrigida para "FOLHA: ' + (i + 1) + ' de ' + totalPaginas + '".');
    }

    return Buffer.from(await pdfDoc.save());
}

// =========================================================================
// FUNCAO UNIFICADA: realinha os numeros do indice a margem REAL da pagina,
// ESTENDE o pontilhado ate a nova posicao (fecha o gap deixado pelo
// deslocamento) e cria os links de navegacao internos - tudo numa unica
// passagem sobre o PDF final.
//
// NOVO NESTA VERSAO: apos mover o numero para a margem real, o pontilhado
// (.toc-dots) desenhado pelo Chromium ainda termina na posicao ANTIGA do
// numero (calculada com base no contentor externo desconhecido). Isso
// deixava um vao vazio entre o fim dos pontinhos e o numero reposicionado.
// Agora a API desenha pontinhos ADICIONAIS cobrindo exatamente esse vao,
// na mesma altura da linha pontilhada original, fechando o gap.
// =========================================================================
async function processarIndice(pdfBuffer, mapaDestinos, mLateralPt) {
    const pagesItems = [];

    function custom_render_page(pageData) {
        return pageData.getTextContent().then(function (textContent) {
            const items = textContent.items.map(function (item) {
                return {
                    str: item.str,
                    x: item.transform[4],
                    y: item.transform[5],
                    width: item.width,
                    fontHeight: Math.hypot(item.transform[2], item.transform[3]) || 9
                };
            });
            pagesItems.push(items);
            return '';
        });
    }

    await pdfParse(pdfBuffer, { pagerender: custom_render_page });

    // Localiza todas as ocorrencias de marcador "@@LNK_codigo@@" e, para
    // cada uma, o item do NUMERO (3 digitos) imediatamente anterior na
    // MESMA linha - esse e o texto visivel que sera realinhado.
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
                if (Math.abs(cand.y - item.y) > 2) break; // saiu da linha
                if (/^\d{3}$/.test(cand.str.trim())) {
                    numItem = cand;
                    break;
                }
            }

            ocorrencias.push({
                codigo: codigo,
                pageIndex: p,
                markerX: item.x,
                markerY: item.y,
                numItem: numItem
            });
        }
    }

    console.log('🔎 Marcadores de link encontrados no texto: ' + ocorrencias.length);

    if (ocorrencias.length === 0) {
        console.log('⚠️ Nenhum marcador de link encontrado no PDF final. Nada a processar.');
        return pdfBuffer;
    }

    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const pages = pdfDoc.getPages();
    const context = pdfDoc.context;
    const fonteNormal = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fonteBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    const BUFFER_MARGEM = 2; // pt de folga entre o numero e a margem real
    const LARGURA_LINK_PADRAO = 34; // usado como fallback se nao achar o numero

    // Parametros da extensao do pontilhado (para fechar o gap)
    const DOT_RAIO = 0.6; // pt - raio de cada pontinho desenhado
    const DOT_ESPACAMENTO = 4; // pt - distancia entre centros dos pontinhos
    const DOT_COR = rgb(0, 0, 0);

    let realinhados = 0;
    let linksCriados = 0;
    let pontosEstendidos = 0;

    ocorrencias.forEach(function (oc) {
        const destPageNum = mapaDestinos[oc.codigo];
        if (!destPageNum || destPageNum < 1 || destPageNum > pages.length) {
            console.log('⚠️ Marcador ' + oc.codigo + ': destino inválido ou fora do intervalo.');
            return;
        }
        if (oc.pageIndex < 0 || oc.pageIndex >= pages.length) return;

        const paginaOrigem = pages[oc.pageIndex];
        const paginaDestino = pages[destPageNum - 1];
        const pageWidth = paginaOrigem.getWidth();
        const targetRightX = pageWidth - mLateralPt - BUFFER_MARGEM;

        let rectX0, rectX1, rectY0, rectY1;

        if (oc.numItem) {
            const numItem = oc.numItem;
            const currentRightX = numItem.x + numItem.width;
            const delta = targetRightX - currentRightX;

            // So redesenha se o desvio for perceptivel (>0.5pt)
            if (Math.abs(delta) > 0.5) {
                // Deteccao de negrito: capitulos principais (ex: "2_1",
                // "3_1") tem 1 underscore no codigo; subitens (ex: "2_1_1",
                // "3_2_2_1") tem 2 ou mais - mesmo padrao usado na montagem
                // visual do indice (linhas principais em negrito).
                const numUnderscores = (oc.codigo.match(/_/g) || []).length;
                const ehNegrito = numUnderscores === 1;
                const fonteEscolhida = ehNegrito ? fonteBold : fonteNormal;

                // Apaga o numero antigo
                paginaOrigem.drawRectangle({
                    x: numItem.x - 2,
                    y: numItem.y - 2,
                    width: numItem.width + 4,
                    height: numItem.fontHeight + 4,
                    color: rgb(1, 1, 1)
                });

                // Redesenha na posicao correta, rente a margem real
                paginaOrigem.drawText(numItem.str, {
                    x: numItem.x + delta,
                    y: numItem.y,
                    size: numItem.fontHeight,
                    font: fonteEscolhida,
                    color: rgb(0, 0, 0)
                });

                realinhados++;

                // ---------------------------------------------------------
                // NOVO: ESTENDE O PONTILHADO ate a nova posicao do numero,
                // fechando o gap deixado pelo deslocamento. Os pontinhos do
                // Chromium (.toc-dots) terminavam na posicao ANTIGA do
                // numero (numItem.x); desenhamos pontinhos adicionais desse
                // ponto ate a nova posicao (numItem.x + delta), na mesma
                // altura aproximada da linha pontilhada original (um pouco
                // abaixo da base do texto, imitando um border-bottom).
                // ---------------------------------------------------------
                if (delta > 0) {
                    const dotY = numItem.y - 1.5; // logo abaixo da base do texto
                    const inicioGap = numItem.x - 2; // onde os pontinhos originais paravam
                    const fimGap = numItem.x + delta - 2; // um pouco antes do numero novo

                    for (let px = inicioGap; px < fimGap; px += DOT_ESPACAMENTO) {
                        paginaOrigem.drawCircle({
                            x: px,
                            y: dotY,
                            size: DOT_RAIO,
                            color: DOT_COR
                        });
                        pontosEstendidos++;
                    }
                }
            }

            // Area do link cobre EXATAMENTE a caixa do numero na posicao
            // NOVA (ja deslocada). IMPORTANTE: nao usar a posicao do
            // marcador antigo aqui - como o numero pode se deslocar bastante
            // para alcancar a margem real, o marcador (que nao se move)
            // pode ficar a ESQUERDA do numero reposicionado, gerando um
            // retangulo invertido (x0>x1) e um link invalido.
            const novoX = numItem.x + delta;
            rectX0 = Math.max(0, novoX - 2);
            rectX1 = novoX + numItem.width + 2;
            rectY0 = numItem.y - 2;
            rectY1 = numItem.y + numItem.fontHeight + 2;
        } else {
            // Fallback: nao achou o numero (nao deveria acontecer) - cria
            // o link na posicao antiga do marcador, como antes.
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

        console.log('🔗 ' + oc.codigo + ' -> página ' + destPageNum + (oc.numItem ? ' (número realinhado)' : ' (número não localizado, fallback aplicado)'));
    });

    console.log('📐 ' + realinhados + ' número(s) de índice realinhado(s) à margem real da página.');
    console.log('⋯ ' + pontosEstendidos + ' pontinho(s) desenhado(s) para fechar o gap do pontilhado.');
    console.log('🔗 Total: ' + linksCriados + ' link(s) de navegação criado(s) no índice.');

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
        // PARAMETROS
        // -----------------------------------------------------------------
        let htmlContent = req.body.html;
        const headerRaw = req.body.cabecalho || '<div></div>';
        const footerRaw = req.body.rodape || '<div></div>';

        const mTop = req.body.margemTop || '10mm';
        const mBottom = req.body.margemBottom || '55mm';
        const mLateral = req.body.margemLateral || '15mm';
        const tamanhoPapel = req.body.tamanhoPapel || 'A4';

        console.log('⚙️ Config: papel=' + tamanhoPapel + ' | top=' + mTop + ' | bottom=' + mBottom + ' | lateral=' + mLateral);

        const headerHtml = headerRaw.split('[MARGEM_LATERAL]').join(mLateral);
        const footerHtml = footerRaw.split('[MARGEM_LATERAL]').join(mLateral);

        const ehTemplateSiemens = cabecalhoEstaVazio(headerHtml);
        console.log('🏷️ Template detectado: ' + (ehTemplateSiemens ? 'Siemens-Energy' : 'Outro template'));

        let blocoGeometria = '';
        blocoGeometria += '<style id="geometria-pagina-api">';
        blocoGeometria += '@page { size: ' + tamanhoPapel + ' portrait; margin: ' + mTop + ' ' + mLateral + ' ' + mBottom + ' ' + mLateral + '; }';
        blocoGeometria += 'html, body { margin: 0; padding: 0; width: 100%; }';
        blocoGeometria += '.wrapper-table { table-layout: fixed !important; width: 100% !important; max-width: 100% !important; }';
        blocoGeometria += 'table { max-width: 100% !important; }';
        blocoGeometria += 'th, td { overflow-wrap: break-word; word-wrap: break-word; }';
        blocoGeometria += '</style>';

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

        const mapaDestinos = {};

        // =================================================================
        // MOTOR DE INDICE INTELIGENTE (TWO-PASS RENDERING)
        // =================================================================
        if (htmlContent.includes('#ANC_')) {
            console.log("🔍 Âncoras detectadas! Iniciando motor de índice...");

            const htmlFantasma = htmlContent.replace(/\{\{PAG_CAP_[A-Za-z0-9_]+\}\}/g, '000');

            const resultadoFantasma = await renderizarDocumento(page, htmlFantasma, blocoGeometria, pdfOptionsRetrato, pdfOptionsPaisagem, ehTemplateSiemens);
            const ghostPdfBuffer = resultadoFantasma.buffer;
            console.log("👻 PDF Fantasma gerado.");

            const pdfData = await pdfParse(ghostPdfBuffer, { pagerender: render_page });
            const pages = pdfData.text.split('\n---PAGE_BREAK---\n');
            console.log('📄 PDF Fantasma tem ' + (pages.length - 1) + ' páginas válidas.');

            const pagesNormalizadas = pages.map(function (p) { return normalizarAncora(p); });

            const anchors = htmlContent.match(/#ANC_[A-Za-z0-9_]+#/g);

            if (anchors) {
                const uniqueAnchors = [...new Set(anchors)];
                console.log('🎯 Âncoras detectadas no HTML:', uniqueAnchors);

                uniqueAnchors.forEach(function (anchor) {
                    const pureAnchor = normalizarAncora(anchor);

                    const pageNum = pagesNormalizadas.findIndex(function (pText) {
                        return pText.includes(pureAnchor);
                    }) + 1;

                    const placeholder = anchor.replace('#ANC_', '{{PAG_').replace('#', '}}');
                    const codigo = anchor.replace(/^#ANC_/, '').replace(/#$/, '');

                    if (pageNum > 0) {
                        const pageNumFormatado = String(pageNum).padStart(3, '0');
                        console.log('✅ Âncora ' + anchor + ' -> Página ' + pageNum + ' (exibido como "' + pageNumFormatado + '")');

                        const marcador = '@@LNK_' + codigo + '@@';
                        const marcadorHtml = '<span style="color:#ffffff;font-size:9pt;">' + marcador + '</span>';

                        htmlContent = htmlContent.split(placeholder).join(pageNumFormatado + marcadorHtml);
                        mapaDestinos[codigo] = pageNum;
                    } else {
                        console.log('❌ Âncora ' + anchor + ' não encontrada. Placeholder será limpo.');
                    }

                    htmlContent = htmlContent.split(anchor).join('');
                });
            }

            const orfaos = htmlContent.match(/\{\{PAG_[A-Za-z0-9_]+\}\}/g);
            if (orfaos) {
                const orfaosUnicos = [...new Set(orfaos)];
                console.log('🧹 Limpando ' + orfaosUnicos.length + ' placeholder(s) órfão(s):', orfaosUnicos);
                orfaosUnicos.forEach(function (o) {
                    htmlContent = htmlContent.split(o).join('---');
                });
            }

        } else {
            console.log("⏩ Nenhuma âncora encontrada, gerando direto.");
        }

        // =================================================================
        // IMPRESSAO FINAL
        // =================================================================
        console.log("🖨️ Imprimindo PDF Final...");
        const resultadoFinal = await renderizarDocumento(page, htmlContent, blocoGeometria, pdfOptionsRetrato, pdfOptionsPaisagem, ehTemplateSiemens);
        let finalPdfBuffer = resultadoFinal.buffer;

        // =================================================================
        // CORRECAO DA NUMERACAO GLOBAL DO RODAPE (so quando ha costura de
        // segmentos em paisagem, que e quando a contagem nativa desvia)
        // =================================================================
        if (resultadoFinal.temSegmentosPaisagem) {
            console.log("🔢 Corrigindo numeração global de páginas no rodapé...");
            finalPdfBuffer = await corrigirNumeracaoRodape(finalPdfBuffer);
        }

        // =================================================================
        // REALINHAMENTO DOS NUMEROS DO INDICE + EXTENSAO DO PONTILHADO +
        // CRIACAO DOS LINKS INTERNOS (roda sempre que houver indice com
        // marcadores, independente de haver secao em paisagem ou nao)
        // =================================================================
        if (Object.keys(mapaDestinos).length > 0) {
            console.log("📐 Processando índice (realinhamento + pontilhado + links)...");
            const mLateralPt = mmParaPt(mLateral);
            finalPdfBuffer = await processarIndice(finalPdfBuffer, mapaDestinos, mLateralPt);
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
app.listen(PORT, () => console.log('Ativo na porta ' + PORT));
