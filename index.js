const express = require('express');
const puppeteer = require('puppeteer');
const app = express();

app.use(express.json({ limit: '50mb' }));

app.post('/gerar-pdf', async (req, res) => {
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: 'new',
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote']
        });
        const page = await browser.newPage();
        await page.setContent(req.body.html, { waitUntil: 'networkidle0', timeout: 120000 });
        
        // Variáveis dinâmicas vindas do Power Apps
        const headerHtml = req.body.cabecalho || '<div></div>';
        const footerHtml = req.body.rodape || '<div></div>';
        const mTop = req.body.margemTop || '10mm';
        const mBottom = req.body.margemBottom || '55mm';

        const pdfBuffer = await page.pdf({
            format: 'A4',
            printBackground: true,
            displayHeaderFooter: true,
            headerTemplate: headerHtml, // AGORA O CABEÇALHO É DINÂMICO
            footerTemplate: footerHtml,
            margin: { top: mTop, bottom: mBottom, right: '15mm', left: '15mm' },
            timeout: 120000
        });
        res.json({ pdfBase64: pdfBuffer.toString('base64') });
    } catch (error) {
        res.status(500).send(error.toString());
    } finally {
        if (browser) await browser.close();
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Ativo na porta ${PORT}`));
