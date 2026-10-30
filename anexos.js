// =========================================================================
// ANEXOS (Capitulo 9) - certificados e outros PDFs que entram NO FIM do documento
//
// COMO FUNCIONA
//   1) Antes de gerar o PDF, o fluxo envia cada anexo para a API:
//        POST /anexos/:lote   { nome, equipamento, ordem, base64 }
//      A API guarda o arquivo em /tmp e registra num indice (index.json).
//   2) O HTML do capitulo traz o marcador <!--ANEXOS:lote--> e, na tabela 9.1,
//      os marcadores {{PAG_ANX_<equipamento>}} (folha onde o certificado comeca).
//   3) Na geracao, a API le o marcador, descobre quantas paginas o corpo tem,
//      troca os {{PAG_ANX_...}} pelos numeros de folha e cola os anexos no fim,
//      COMPLETOS e SEM ALTERACAO (o certificado diz que a reproducao so pode ser total).
//
// REGRAS
//   - Anexos com o mesmo conteudo (mesmo texto em todas as paginas) entram UMA vez so.
//     Cada equipamento continua apontando para a folha do certificado.
//   - Sem o marcador no HTML, nada disso e usado e os demais capitulos nao mudam.
// =========================================================================
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { PDFDocument } = require('pdf-lib');

// pdf-parse e usado so para reconhecer anexos repetidos. Se nao existir, compara os bytes.
let pdfParse = null;
try {
    pdfParse = require('pdf-parse');
} catch (e) {
    pdfParse = null;
}

const MARCADOR_RE = /<!--ANEXOS:([A-Za-z0-9_-]{1,40})-->/;
const DIR_BASE = path.join(os.tmpdir(), 'anexos_pdf');
const VALIDADE_MS = 2 * 60 * 60 * 1000;   // 2 horas
const MAX_BYTES = 35 * 1024 * 1024;       // 35 MB por arquivo (em base64 cabe nos 50 MB do express)

try {
    fs.mkdirSync(DIR_BASE, { recursive: true });
} catch (e) {
    console.error('Nao foi possivel criar a pasta de anexos:', e.message);
}

function erro(status, mensagem) {
    const e = new Error(mensagem);
    e.status = status;
    return e;
}

function lotePermitido(lote) {
    return typeof lote === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(lote);
}

function dirLote(lote) {
    return path.join(DIR_BASE, lote);
}

function caminhoIndice(lote) {
    return path.join(dirLote(lote), 'index.json');
}

// Fila por lote: dois envios ao mesmo tempo nao podem gravar o indice juntos
const _filas = {};
function emFila(lote, tarefa) {
    const anterior = _filas[lote] || Promise.resolve();
    const atual = anterior.catch(function () { }).then(tarefa);
    _filas[lote] = atual.catch(function () { });
    return atual;
}

async function lerIndice(lote) {
    try {
        return JSON.parse(await fs.promises.readFile(caminhoIndice(lote), 'utf8'));
    } catch (e) {
        return { lote: lote, proximaSeq: 1, itens: [] };
    }
}

async function gravarIndice(lote, indice) {
    await fs.promises.writeFile(caminhoIndice(lote), JSON.stringify(indice), 'utf8');
}

function decodificarBase64(texto) {
    let limpo = String(texto).trim();
    const posVirgula = limpo.indexOf(',');
    if (limpo.startsWith('data:') && posVirgula !== -1) {
        limpo = limpo.substring(posVirgula + 1);
    }
    return Buffer.from(limpo, 'base64');
}

// Assinatura do conteudo: mesmo texto em todas as paginas = mesmo certificado.
// Arquivo sem texto (escaneado) nao pode ser comparado pelo texto: compara os bytes.
async function assinaturaConteudo(buffer) {
    if (pdfParse) {
        try {
            const dados = await pdfParse(buffer);
            const texto = String(dados.text || '').replace(/\s+/g, '').toLowerCase();
            if (texto.length >= 200) {
                return 'txt:' + crypto.createHash('sha256').update(texto).update('|' + dados.numpages).digest('hex');
            }
        } catch (e) {
            // cai para a comparacao por bytes
        }
    }
    return 'bin:' + crypto.createHash('sha256').update(buffer).digest('hex');
}

// Extrai o marcador <!--ANEXOS:lote--> do HTML
function extrairMarcador(html) {
    const m = MARCADOR_RE.exec(html);
    if (!m) return { lote: null, htmlSemMarcador: html };
    return { lote: m[1], htmlSemMarcador: html.replace(MARCADOR_RE, '') };
}

// Recebe um anexo (chamado pelo fluxo, um PDF por vez)
async function receberAnexo(lote, dados) {
    if (!lotePermitido(lote)) {
        throw erro(400, 'Nome de lote invalido (use letras, numeros, _ e -, ate 40 caracteres).');
    }
    if (!dados || typeof dados.base64 !== 'string' || dados.base64.trim() === '') {
        throw erro(400, "O campo 'base64' e obrigatorio.");
    }

    const buffer = decodificarBase64(dados.base64);
    if (buffer.length === 0) {
        throw erro(400, 'Arquivo vazio.');
    }
    if (buffer.length > MAX_BYTES) {
        throw erro(413, 'Arquivo maior que ' + (MAX_BYTES / 1024 / 1024).toFixed(0) + ' MB.');
    }
    if (buffer.slice(0, 1024).toString('latin1').indexOf('%PDF-') === -1) {
        throw erro(400, 'O arquivo recebido nao e um PDF.');
    }

    let paginas;
    try {
        const doc = await PDFDocument.load(buffer);
        paginas = doc.getPageCount();
    } catch (e) {
        throw erro(400, 'PDF invalido ou protegido por senha: ' + e.message);
    }
    if (paginas < 1) {
        throw erro(400, 'PDF sem paginas.');
    }

    const hash = await assinaturaConteudo(buffer);

    return emFila(lote, async function () {
        await fs.promises.mkdir(dirLote(lote), { recursive: true });
        const indice = await lerIndice(lote);
        const seq = indice.proximaSeq;
        indice.proximaSeq = seq + 1;

        // Se ja chegou um arquivo com o mesmo conteudo, reaproveita (nao grava de novo)
        const existente = indice.itens.find(function (i) { return i.hash === hash; });
        let arquivo;
        if (existente) {
            arquivo = existente.arquivo;
        } else {
            arquivo = 'a' + seq + '.pdf';
            await fs.promises.writeFile(path.join(dirLote(lote), arquivo), buffer);
        }

        const ordemNum = Number(dados.ordem);
        const item = {
            seq: seq,
            ordem: Number.isFinite(ordemNum) ? ordemNum : seq,
            nome: String(dados.nome || ('anexo_' + seq)).slice(0, 200),
            equipamento: dados.equipamento == null ? '' : String(dados.equipamento).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40),
            paginas: paginas,
            hash: hash,
            arquivo: arquivo
        };
        indice.itens.push(item);
        await gravarIndice(lote, indice);
        return { ok: true, seq: seq, ordem: item.ordem, paginas: paginas, repetido: !!existente };
    });
}

// Carrega o lote para uma geracao: ordena e separa os anexos unicos dos repetidos
async function carregar(lote) {
    if (!lotePermitido(lote)) return null;
    const indice = await lerIndice(lote);
    if (!indice.itens || indice.itens.length === 0) return null;

    const itens = indice.itens.slice().sort(function (a, b) {
        return (a.ordem - b.ordem) || (a.seq - b.seq);
    });
    const vistos = {};
    const unicos = [];
    itens.forEach(function (it) {
        if (vistos[it.hash]) {
            it.repetidoDe = vistos[it.hash].seq;
        } else {
            vistos[it.hash] = it;
            it.repetidoDe = null;
            unicos.push(it);
        }
    });
    const totalPaginas = unicos.reduce(function (soma, u) { return soma + u.paginas; }, 0);
    return { lote: lote, itens: itens, unicos: unicos, totalPaginas: totalPaginas, dir: dirLote(lote) };
}

// Folha onde comeca o anexo de cada equipamento (paginasAntes = paginas do corpo, e da capa se houver)
function mapaFolhas(info, paginasAntes) {
    const inicio = {};
    let atual = paginasAntes + 1;
    info.unicos.forEach(function (u) {
        inicio[u.seq] = atual;
        atual += u.paginas;
    });
    const porEquip = {};
    info.itens.forEach(function (it) {
        const ref = it.repetidoDe || it.seq;
        if (it.equipamento && porEquip[it.equipamento] === undefined) {
            porEquip[it.equipamento] = inicio[ref];
        }
    });
    return porEquip;
}

// Troca {{PAG_ANX_<equipamento>}} pela folha. O que nao tiver anexo fica para a API trocar por "---"
function preencherFolhas(html, info, paginasAntes) {
    const mapa = mapaFolhas(info, paginasAntes);
    return html.replace(/\{\{PAG_ANX_([A-Za-z0-9_-]+)\}\}/g, function (todo, chave) {
        return mapa[chave] !== undefined ? String(mapa[chave]) : todo;
    });
}

// Cola os anexos no fim do PDF, completos e sem alteracao.
// Carrega o PDF do corpo e ACRESCENTA as paginas (nao copia o corpo), para os links do indice continuarem validos.
async function anexar(pdfBuffer, info) {
    const doc = await PDFDocument.load(pdfBuffer);
    for (const u of info.unicos) {
        const buf = await fs.promises.readFile(path.join(info.dir, u.arquivo));
        const src = await PDFDocument.load(buf);
        const paginas = await doc.copyPages(src, src.getPageIndices());   // uma chamada por arquivo
        paginas.forEach(function (p) { doc.addPage(p); });
    }
    return Buffer.from(await doc.save());
}

async function listar(lote) {
    if (!lotePermitido(lote)) throw erro(400, 'Nome de lote invalido.');
    const info = await carregar(lote);
    if (!info) return { lote: lote, arquivos: [], totalPaginas: 0 };
    return {
        lote: lote,
        arquivos: info.itens.map(function (it) {
            return { seq: it.seq, ordem: it.ordem, nome: it.nome, equipamento: it.equipamento, paginas: it.paginas, repetido: !!it.repetidoDe };
        }),
        totalPaginas: info.totalPaginas
    };
}

async function limpar(lote) {
    if (!lotePermitido(lote)) throw erro(400, 'Nome de lote invalido.');
    return emFila(lote, async function () {
        await fs.promises.rm(dirLote(lote), { recursive: true, force: true });
        return { removido: true, lote: lote };
    });
}

// Faxina: apaga lotes antigos
async function limparAntigos() {
    try {
        const nomes = await fs.promises.readdir(DIR_BASE);
        const agora = Date.now();
        for (const nome of nomes) {
            const completo = path.join(DIR_BASE, nome);
            try {
                const info = await fs.promises.stat(completo);
                if (agora - info.mtimeMs > VALIDADE_MS) {
                    await fs.promises.rm(completo, { recursive: true, force: true });
                }
            } catch (e) {
                // ignora
            }
        }
    } catch (e) {
        // pasta ainda nao existe
    }
}

module.exports = {
    extrairMarcador: extrairMarcador,
    receberAnexo: receberAnexo,
    carregar: carregar,
    preencherFolhas: preencherFolhas,
    anexar: anexar,
    listar: listar,
    limpar: limpar,
    limparAntigos: limparAntigos
};
