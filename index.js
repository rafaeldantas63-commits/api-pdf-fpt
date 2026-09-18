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
            // AUMENTAMOS O RESPIRO PARA +15 PIXELS (Antes era +4)
            // Isso garante que os pontinhos comecem bem depois da
            // ultima letra do titulo, sem encavalar de jeito nenhum.
            // ---------------------------------------------------------
            const whiteFromX = oc.titleEndX + 15; 
            
            paginaOrigem.drawRectangle({
                x: whiteFromX,
                y: rowTop,
                width: Math.max(0, pageWidth - whiteFromX),
                height: rowHeight,
                color: rgb(1, 1, 1)
            });

            // Redesenha o pontilhado INTEIRO a partir da margem segura (+4 pixels a partir do branco)
            const dotY = numItem.y - 1.5;
            const dotsFromX = whiteFromX + 4;
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
