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
// FUNCAO: cria os links de navegacao internos do indice DIRETO no PDF
// final, via pdf-lib.
//
// DIAGNOSTICO DO PROBLEMA ANTERIOR (confirmado analisando o texto extraido
// do PDF real): todos os marcadores @@LNK_CAP_X@@ apareciam AGRUPADOS no
// final do texto da pagina, em vez de cada um proximo ao seu respectivo
// capitulo - mesmo com o indice aparecendo visualmente correto no PDF.
//
// CAUSA: o marcador usava "opacity:0.02". Elementos com opacity != 1
// exigem que o Chromium desenhe usando um ExtGState de transparencia no
// PDF. Para economizar trocas de estado grafico, o Chromium AGRUPA todo
// o texto que usa a MESMA opacidade e o escreve de uma vez no stream do
// PDF - fora da ordem/posicao visual real. Isso nao quebrava a tecnica
// das ancoras #ANC_CAP_X# (que so precisa saber EM QUAL PAGINA o texto
// aparece), mas quebrava esta tecnica de link (que precisa da posicao
// x/y EXATA de cada marcador individualmente).
//
// CORRECAO: o marcador passa a usar uma cor solida IGUAL AO FUNDO DA
// PAGINA (branco) em vez de opacity. Isso continua invisivel a olho nu,
// mas NAO aciona nenhum ExtGState de transparencia - o Chromium escreve
// o texto na ordem/posicao normal do fluxo, preservando o x/y correto.
// =========================================================================
async function adicionarLinksInternosDoIndice(pdfBuffer, mapaDestinos) {
    const ocorrencias = [];
    let contadorPagina = 0;

    function custom_render_page(pageData) {
        const paginaAtual = contadorPagina;
        contadorPagina++;
        return pageData.getTextContent().then(function (textContent) {
            textContent.items.forEach(function (item) {
                const match = item.str.match(/@@LNK_([A-Za-z0-9_]+)@@/);
                if (match) {
                    ocorrencias.push({
                        codigo: match[1],
                        pageIndex: paginaAtual,
                        x: item.transform[4],
                        y: item.transform[5],
                        fontHeight: Math.hypot(item.transform[2], item.transform[3]) || 9
                    });
                }
            });
            return '';
        });
    }

    await pdfParse(pdfBuffer, { pagerender: custom_render_page });

    console.log('🔎 Marcadores de link encontrados no texto: ' + ocorrencias.length);
    ocorrencias.forEach(function (oc) {
        console.log('   - ' + oc.codigo + ' | página ' + (oc.pageIndex + 1) + ' | x=' + oc.x.toFixed(1) + ' y=' + oc.y.toFixed(1));
    });

    if (ocorrencias.length === 0) {
        console.log('⚠️ Nenhum marcador de link encontrado no PDF final. Links não foram criados.');
        return pdfBuffer;
    }

    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const pages = pdfDoc.getPages();
    const context = pdfDoc.context;

    const LARGURA_LINK = 56; // pt
    const ALTURA_LINK_EXTRA = 4; // pt de folga acima/abaixo

    let criados = 0;

    ocorrencias.forEach(function (oc) {
        const destPageNum = mapaDestinos[oc.codigo];
        if (!destPageNum || destPageNum < 1 || destPageNum > pages.length) {
            console.log('⚠️ Marcador ' + oc.codigo + ': destino inválido ou fora do intervalo.');
            return;
        }
        if (oc.pageIndex < 0 || oc.pageIndex >= pages.length) return;

        const paginaOrigem = pages[oc.pageIndex];
        const paginaDestino = pages[destPageNum - 1];

        const alturaLink = oc.fontHeight + ALTURA_LINK_EXTRA;

        const linkDict = context.obj({});
        linkDict.set(PDFName.of('Type'), PDFName.of('Annot'));
        linkDict.set(PDFName.of('Subtype'), PDFName.of('Link'));
        linkDict.set(PDFName.of('Rect'), context.obj([
            oc.x,
            oc.y - 2,
            oc.x + LARGURA_LINK,
            oc.y + alturaLink
        ]));
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
        criados++;

        console.log('🔗 Link criado: ' + oc.codigo + ' (página origem ' + (oc.pageIndex + 1) + ') -> página destino ' + destPageNum);
    });

    console.log('🔗 Total: ' + criados + ' link(s) de navegação criado(s) no índice.');

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

        // Guarda, para cada codigo de ancora (ex.: "CAP_3_1"), a pagina de
        // destino real - usado depois para criar os links de navegacao.
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

                        // -----------------------------------------------------
                        // Marcador invisivel + numero formatado.
                        //
                        // CORRIGIDO: usa cor SOLIDA branca (igual ao fundo da
                        // pagina) em vez de opacity. Isso evita que o Chromium
                        // agrupe este texto em um ExtGState de transparencia
                        // separado, o que estava fazendo TODOS os marcadores
                        // da pagina serem escritos fora de ordem/posicao no
                        // stream do PDF (confirmado analisando o texto extraido
                        // do PDF real - todos os marcadores apareciam juntos no
                        // final da pagina, em vez de proximos aos seus titulos).
                        // -----------------------------------------------------
                        const marcador = '@@LNK_' + codigo + '@@';
                        const marcadorHtml = '<span style="color:#ffffff;font-size:9pt;">' + marcador + '</span>';

                        htmlContent = htmlContent.split(placeholder).join(marcadorHtml + pageNumFormatado);
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
        // CORRECAO DA NUMERACAO GLOBAL DO RODAPE
        // =================================================================
        if (resultadoFinal.temSegmentosPaisagem) {
            console.log("🔢 Corrigindo numeração global de páginas no rodapé...");
            finalPdfBuffer = await corrigirNumeracaoRodape(finalPdfBuffer);
        }

        // =================================================================
        // CRIACAO DOS LINKS DE NAVEGACAO INTERNOS DO INDICE
        // =================================================================
        if (Object.keys(mapaDestinos).length > 0) {
            console.log("🔗 Criando links de navegação internos no índice...");
            finalPdfBuffer = await adicionarLinksInternosDoIndice(finalPdfBuffer, mapaDestinos);
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
