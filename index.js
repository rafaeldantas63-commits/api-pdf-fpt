const express = require('express');
const puppeteer = require('puppeteer');
const pdfParse = require('pdf-parse');
const app = express();

app.use(express.json({ limit: '50mb' }));

// Função auxiliar para o pdf-parse extrair texto separado por página
function render_page(pageData) {
    return pageData.getTextContent().then(function(textContent) {
        let text = '';
        for (let item of textContent.items) {
            text += item.str + ' ';
        }
        return text + '\n---PAGE_BREAK---\n';
    });
}

app.post('/gerar-pdf', async (req, res) => {
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: 'new',
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote']
        });
        const page = await browser.newPage();
        
        let htmlContent = req.body.html;
        const headerHtml = req.body.cabecalho || '<div></div>';
        const footerHtml = req.body.rodape || '<div></div>';
        const mTop = req.body.margemTop || '10mm';
        const mBottom = req.body.margemBottom || '55mm';

        const pdfOptions = {
            format: 'A4',
            printBackground: true,
            displayHeaderFooter: true,
            headerTemplate: headerHtml,
            footerTemplate: footerHtml,
            margin: { top: mTop, bottom: mBottom, right: '15mm', left: '15mm' },
            timeout: 120000
        };

        // =========================================================================
        // MOTOR DE ÍNDICE INTELIGENTE (TWO-PASS RENDERING)
        // =========================================================================
        if (htmlContent.includes('#ANC_')) {
            
            // 1º PASSO: Gera PDF Fantasma na memória
            await page.setContent(htmlContent, { waitUntil: 'networkidle0', timeout: 120000 });
            const ghostPdfBuffer = await page.pdf(pdfOptions);

            // 2º PASSO: Lê o texto do PDF Fantasma
            const pdfData = await pdfParse(ghostPdfBuffer, { pagerender: render_page });
            const pages = pdfData.text.split('\n---PAGE_BREAK---\n');

            // 3º PASSO: Encontra as âncoras e substitui as variáveis no Índice do HTML
            const anchors = htmlContent.match(/#ANC_[A-Za-z0-9_]+#/g);
            if (anchors) {
                [...new Set(anchors)].forEach(anchor => {
                    // LIMPEZA: Remove os espaços da âncora e do texto do PDF lido para o Match ser perfeito
                    let cleanAnchor = anchor.replace(/\s+/g, '');
                    let pageNum = pages.findIndex(pText => pText.replace(/\s+/g, '').includes(cleanAnchor)) + 1;
                    
                    if (pageNum > 0) {
                        let placeholder = anchor.replace('#ANC_', '{{PAG_').replace('#', '}}');
                        
                        // SUBSTITUIÇÃO SEGURA: Usa split e join para não dar erro de Sintaxe com o "{{ }}"
                        htmlContent = htmlContent.split(placeholder).join(pageNum);
                        
                        // Apaga a âncora do HTML final
                        htmlContent = htmlContent.split(anchor).join('');
                    }
                });
            }
        }

        // =========================================================================
        // GERAÇÃO DO PDF FINAL
        // =========================================================================
        await page.setContent(htmlContent, { waitUntil: 'networkidle0', timeout: 120000 });
        const finalPdfBuffer = await page.pdf(pdfOptions);

        res.json({ pdfBase64: finalPdfBuffer.toString('base64') });
    } catch (error) {
        console.error(error);
        res.status(500).send(error.toString());
    } finally {
        if (browser) await browser.close();
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Ativo na porta ${PORT}`));
