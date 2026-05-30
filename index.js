const express = require('express');
const puppeteer = require('puppeteer');
const app = express();

app.use(express.json({ limit: '50mb' }));

app.post('/gerar-pdf', async (req, res) => {
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: 'new',
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH, // Usa o navegador seguro do Alpine
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                '--disable-dev-shm-usage', // Libera memória para as imagens Base64
                '--disable-gpu'
            ]
        });
        const page = await browser.newPage();
        
        await page.setContent(req.body.html, { waitUntil: 'networkidle0', timeout: 120000 });
        
        const pdfBuffer = await page.pdf({
            format: 'A4',
            printBackground: true,
            displayHeaderFooter: true,
            headerTemplate: '<div></div>',
            footerTemplate: '<div style="font-size:10px; font-family:Arial; width:100%; text-align:right; padding-right:20px;"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
            margin: { top: '20px', bottom: '50px', right: '20px', left: '20px' },
            timeout: 120000
        });
        res.json({ pdfBase64: pdfBuffer.toString('base64') });
    } catch (error) {
        console.error("ERRO GERANDO PDF:", error); 
        res.status(500).send(error.toString());
    } finally {
        if (browser) await browser.close();
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Ativo na porta ${PORT}`));
