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
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-zygote'
            ]
        });
        const page = await browser.newPage();
        
        await page.setContent(req.body.html, { waitUntil: 'networkidle0', timeout: 120000 });
        
        const footerHtml = req.body.rodape || '<div></div>';
        // Aqui a API pega a margem dinâmica que vem do seu Power Automate (ou usa 55mm por segurança)
        const margemInferior = req.body.margemBottom || '55mm'; 

        const pdfBuffer = await page.pdf({
            format: 'A4',
            printBackground: true,
            displayHeaderFooter: true,
            headerTemplate: '<div></div>',
            footerTemplate: footerHtml,
            // Aplicando a margem que veio do banco de dados:
            margin: { top: '10mm', bottom: margemInferior, right: '15mm', left: '15mm' },
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
