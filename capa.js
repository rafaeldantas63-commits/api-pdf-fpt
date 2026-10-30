// ===== capa.js (arquivo NOVO, na mesma pasta do index.js) =====
const { PDFDocument } = require('pdf-lib');

const CAPA_START = '<!--CAPA_START-->';
const CAPA_END = '<!--CAPA_END-->';
const TOKEN_TOTAL = '{{TOTAL_PAGINAS}}';
const CAPA_PAGINAS = 1;

// Separa o HTML da capa do resto do documento.
function extrairCapa(html) {
    const ini = html.indexOf(CAPA_START);
    if (ini === -1) return { capaHtml: '', htmlSemCapa: html };
    const fim = html.indexOf(CAPA_END, ini + CAPA_START.length);
    if (fim === -1) return { capaHtml: '', htmlSemCapa: html };
    const capaHtml = html.substring(ini + CAPA_START.length, fim).trim();
    const htmlSemCapa = html.substring(0, ini) + html.substring(fim + CAPA_END.length);
    return { capaHtml: capaHtml, htmlSemCapa: htmlSemCapa };
}

// Pagina A4 da capa: margem de pagina zero e recuo proprio (esquerda 20 mm, direita 10 mm, topo 8 mm).
function montarDocumentoCapa(capaHtml, totalFolhas) {
    const corpo = capaHtml.split(TOKEN_TOTAL).join(String(totalFolhas));
    return '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
        '@page { size: A4 portrait; margin: 0; }' +
        'html, body { margin: 0; padding: 0; width: 210mm; height: 296mm; }' +
        '* { -webkit-print-color-adjust: exact; print-color-adjust: exact; }' +
        '.capa-pagina { box-sizing: border-box; width: 210mm; height: 296mm; padding: 8mm 10mm 0 20mm; overflow: hidden; page-break-after: avoid; }' +
        '</style></head><body><div class="capa-pagina">' + corpo + '</div></body></html>';
}

// Renderiza a capa em PDF, sem cabecalho, sem rodape e sem margem.
async function renderizarCapa(browser, capaHtml, totalFolhas) {
    const page = await browser.newPage();
    try {
        await page.setContent(montarDocumentoCapa(capaHtml, totalFolhas), { waitUntil: 'domcontentloaded', timeout: 120000 });
        const buffer = await page.pdf({
            format: 'A4',
            printBackground: true,
            displayHeaderFooter: false,
            margin: { top: '0', right: '0', bottom: '0', left: '0' },
            preferCSSPageSize: true,
            timeout: 120000
        });
        return Buffer.from(buffer);
    } finally {
        await page.close();
    }
}

async function contarPaginas(pdfBuffer) {
    const doc = await PDFDocument.load(pdfBuffer);
    return doc.getPageCount();
}

// Junta: capa primeiro, depois o corpo.
async function anexarCapa(corpoBuffer, capaBuffer) {
    const final = await PDFDocument.create();
    const capaDoc = await PDFDocument.load(capaBuffer);
    const corpoDoc = await PDFDocument.load(corpoBuffer);
    const idxCapa = capaDoc.getPageIndices().slice(0, CAPA_PAGINAS);
    const paginasCapa = await final.copyPages(capaDoc, idxCapa);
    paginasCapa.forEach(function (p) { final.addPage(p); });
    const paginasCorpo = await final.copyPages(corpoDoc, corpoDoc.getPageIndices());
    paginasCorpo.forEach(function (p) { final.addPage(p); });
    return Buffer.from(await final.save());
}

module.exports = {
    CAPA_PAGINAS: CAPA_PAGINAS,
    extrairCapa: extrairCapa,
    montarDocumentoCapa: montarDocumentoCapa,
    renderizarCapa: renderizarCapa,
    contarPaginas: contarPaginas,
    anexarCapa: anexarCapa
};
