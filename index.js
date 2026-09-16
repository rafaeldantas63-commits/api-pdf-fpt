const express = require('express');
const puppeteer = require('puppeteer');
const pdfParse = require('pdf-parse');
const app = express();

app.use(express.json({ limit: '50mb' }));

// Função que ensina o pdf-parse a quebrar as páginas corretamente
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
    console.log("🚀 Nova requisição de PDF recebida.");
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
            console.log("🔍 Âncoras detectadas! Iniciando motor de índice...");
            
            // 1º PASSO: Gera PDF Fantasma na memória
            await page.setContent(htmlContent, { waitUntil: 'networkidle0', timeout: 120000 });
            const ghostPdfBuffer = await page.pdf(pdfOptions);
            console.log("👻 PDF Fantasma gerado.");

            // 2º PASSO: Lê o texto
            const pdfData = await pdfParse(ghostPdfBuffer, { pagerender: render_page });
            const pages = pdfData.text.split('\n---PAGE_BREAK---\n');
            console.log(`📄 PDF Fantasma tem ${pages.length - 1} páginas válidas.`);

            // 3º PASSO: Substitui as variáveis
            const anchors = htmlContent.match(/#ANC_[A-Za-z0-9_]+#/g);
            if (anchors) {
                const uniqueAnchors = [...new Set(anchors)];
                console.log(`🎯 Âncoras detectadas no HTML:`, uniqueAnchors);
                
                uniqueAnchors.forEach(anchor => {
                    // Remove todos os caracteres especiais e espaços para a busca ser cega e perfeita
                    let pureAnchor = anchor.replace(/[^a-zA-Z0-9]/g, '');
                    let pageNum = pages.findIndex(pText => pText.replace(/[^a-zA-Z0-9]/g, '').includes(pureAnchor)) + 1;
                    
                    if (pageNum > 0) {
                        console.log(`✅ Âncora ${anchor} -> Página ${pageNum}`);
                        let placeholder = anchor.replace('#ANC_', '{{PAG_').replace('#', '}}');
                        
                        // Troca de forma segura evitando conflitos de Regex com o símbolo {{
                        htmlContent = htmlContent.split(placeholder).join(pageNum);
                        htmlContent = htmlContent.split(anchor).join('');
                    } else {
                        console.log(`❌ Âncora ${anchor} não foi encontrada na leitura do PDF!`);
                    }
                });
            }
        } else {
            console.log("⏩ Nenhuma âncora encontrada, gerando direto.");
        }

        console.log("🖨️ Imprimindo PDF Final...");
        await page.setContent(htmlContent, { waitUntil: 'networkidle0', timeout: 120000 });
        const finalPdfBuffer = await page.pdf(pdfOptions);
        console.log("🎉 PDF Finalizado e enviado ao Power Automate!");

        res.json({ pdfBase64: finalPdfBuffer.toString('base64') });
    } catch (error) {
        console.error("🚨 Erro Fatal:", error);
        res.status(500).send(error.toString());
    } finally {
        if (browser) await browser.close();
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Ativo na porta ${PORT}`));
