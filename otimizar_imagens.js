const sharp = require('sharp');

/**
 * Reduz as fotos (data URI base64) dentro do HTML antes de gerar o PDF.
 *  - O tamanho final acompanha o tamanho em que a foto aparece no HTML:
 *      foto com width:110px  -> 440 px (4x, nitidez de sobra para impressão)
 *      foto sem width        -> 1200 px
 *  - Só mexe em imagem grande (> minBytes) e sem transparência (logos/assinaturas ficam intactas)
 *  - Respeita a rotação EXIF das fotos de celular/tablet
 *  - Se qualquer imagem falhar, mantém a original (nunca quebra a geração do PDF)
 */
async function otimizarImagensHtml(html, opcoes = {}) {
  const { fator = 4, larguraPadrao = 1200, minLargura = 400, maxLargura = 1600,
          qualidade = 78, minBytes = 150 * 1024 } = opcoes;

  const reTag = /<img\b[^>]*>/gi;
  const reSrc = /src\s*=\s*(['"])(data:image\/(?:jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+))\1/i;
  const reLarg = /(?:width\s*:\s*(\d+(?:\.\d+)?)px|width\s*=\s*['"]?(\d+))/i;

  const cache = new Map();           // evita reprocessar a mesma foto
  let antes = 0, depois = 0, trocadas = 0;
  const tags = html.match(reTag) || [];

  for (const tag of tags) {
    const s = tag.match(reSrc);
    if (!s) continue;
    const dataUri = s[2];
    const l = tag.match(reLarg);
    const exibida = l ? parseFloat(l[1] || l[2]) : 0;
    const alvo = exibida
      ? Math.min(maxLargura, Math.max(minLargura, Math.round(exibida * fator)))
      : larguraPadrao;
    const chave = alvo + '|' + dataUri;
    if (cache.has(chave)) continue;

    const buf = Buffer.from(s[3], 'base64');
    antes += buf.length;
    if (buf.length < minBytes) { cache.set(chave, dataUri); depois += buf.length; continue; }
    try {
      const meta = await sharp(buf).metadata();
      if (meta.hasAlpha) { cache.set(chave, dataUri); depois += buf.length; continue; }
      const out = await sharp(buf).rotate()
        .resize({ width: alvo, withoutEnlargement: true })
        .jpeg({ quality: qualidade, mozjpeg: true }).toBuffer();
      if (out.length >= buf.length) { cache.set(chave, dataUri); depois += buf.length; continue; }
      cache.set(chave, 'data:image/jpeg;base64,' + out.toString('base64'));
      depois += out.length; trocadas++;
    } catch (e) {
      cache.set(chave, dataUri); depois += buf.length;
    }
  }

  const novoHtml = html.replace(reTag, (tag) => {
    const s = tag.match(reSrc);
    if (!s) return tag;
    const l = tag.match(reLarg);
    const exibida = l ? parseFloat(l[1] || l[2]) : 0;
    const alvo = exibida
      ? Math.min(maxLargura, Math.max(minLargura, Math.round(exibida * fator)))
      : larguraPadrao;
    const novo = cache.get(alvo + '|' + s[2]);
    return novo && novo !== s[2] ? tag.replace(s[2], novo) : tag;
  });
  return { html: novoHtml, antes, depois, trocadas };
}

module.exports = { otimizarImagensHtml };
