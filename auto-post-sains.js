/**
 * auto-post-sains.js
 * ---------------------------------------------------------------
 * Auto-posting KONTEN SAINS POPULER ke WordPress (JNews) — gaya
 * "media pengetahuan populer" yang bikin pembaca bilang "Oh, ternyata
 * begitu!", BUKAN gaya "media pelajaran"/buku teks yang kaku.
 *
 * Arsitekturnya meminjam dari auto-post-luna.js (ambil RSS → ekstrak
 * teks lengkap halaman sumber → tulis ulang via GPT-5.6 Luna →
 * posting ke WordPress), tapi dengan systemPrompt yang SAMA SEKALI
 * BEDA — itu inti pembeda modul ini, lihat tulisArtikelSainsDenganLuna().
 *
 * SUMBER RSS default di bawah ini sudah dicek dan SECARA EKSPLISIT
 * mengizinkan pengambilan headline+ringkasan untuk diolah ulang,
 * dengan syarat TIDAK memuat teks penuh dan tetap mencantumkan
 * atribusi + tautan balik ke sumber asli:
 * - ScienceDaily: https://www.sciencedaily.com/rss/all.xml
 * - NASA (konten pemerintah AS, sangat terbuka untuk dipakai ulang):
 *   https://www.nasa.gov/rss/dyn/breaking_news.rss
 * Sumber lain (mis. BRIN/lembaga riset Indonesia) BOLEH ditambahkan,
 * tapi cek dulu sendiri apakah situsnya menyediakan RSS resmi dan apa
 * ketentuan penggunaannya — lihat panduan Bagian 9.2.
 *
 * PENTING:
 * 1) Sumber di atas berbahasa Inggris — skrip ini secara sengaja
 *    meminta AI MENERJEMAHKAN SEKALIGUS mengadaptasi gaya jadi bahasa
 *    Indonesia yang populer, bukan menerjemahkan kaku kata demi kata.
 * 2) Default status DRAFT — tetap review manusia sebelum tayang,
 *    terutama untuk memastikan tidak ada klaim sains yang keliru.
 * 3) Berbagi WP_URL/WP_USER/WP_APP_PASSWORD/OPENAI_API_KEY yang sama
 *    dengan modul-modul lain — tidak perlu akun terpisah.
 * ---------------------------------------------------------------
 */

require('dotenv').config();
const axios = require('axios');
const Parser = require('rss-parser');
const OpenAI = require('openai');
const fs = require('fs');
const cheerio = require('cheerio');

// ---------- KONFIGURASI ----------
const WP_URL = process.env.WP_URL;
const WP_USER = process.env.WP_USER;
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const KATEGORI_SAINS_ID = parseInt(process.env.KATEGORI_SAINS_ID || '1', 10); // ID kategori "Sains"/"Iptek" di WordPress
const POST_STATUS_SAINS = process.env.POST_STATUS_SAINS || 'draft';
const MAKS_SAINS_PER_PROSES = parseInt(process.env.MAKS_SAINS_PER_PROSES || '2', 10);
const AMBIL_ARTIKEL_LENGKAP = (process.env.AMBIL_ARTIKEL_LENGKAP || 'true') === 'true';
const SERTAKAN_FOTO = (process.env.SERTAKAN_FOTO || 'true') === 'true';
const SISIPKAN_FOTO_DI_ARTIKEL = (process.env.SISIPKAN_FOTO_DI_ARTIKEL || 'false') === 'true';
const SERTAKAN_RINGKASAN = (process.env.SERTAKAN_RINGKASAN || 'true') === 'true';
const SERTAKAN_TAG_OTOMATIS = (process.env.SERTAKAN_TAG_OTOMATIS || 'true') === 'true';

// Field "selector" OPSIONAL: CSS selector kontainer isi artikel di halaman
// sumber. Kalau dikosongkan, skrip mencoba selector umum lalu fallback ke
// gabungan semua <p>. Cara menemukannya sama seperti panduan Bagian 5A.4.
const RSS_SOURCES = [
  { name: 'ScienceDaily', url: 'https://www.sciencedaily.com/rss/all.xml', selector: '#text' },
  { name: 'NASA', url: 'https://www.nasa.gov/rss/dyn/breaking_news.rss' },
];

const LOG_FILE = './posted-sains-log.json'; // dedup terpisah dari modul lain
// -----------------------------------

const parser = new Parser({
  customFields: {
    item: [
      ['media:content', 'mediaContent'],
      ['media:thumbnail', 'mediaThumbnail'],
    ],
  },
});
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

function loadPostedLinks() {
  if (!fs.existsSync(LOG_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(LOG_FILE, 'utf-8'));
  } catch {
    return [];
  }
}
function savePostedLink(link) {
  const links = loadPostedLinks();
  links.push(link);
  fs.writeFileSync(LOG_FILE, JSON.stringify(links, null, 2));
}

async function fetchNewItems() {
  const posted = loadPostedLinks();
  const newItems = [];
  for (const source of RSS_SOURCES) {
    try {
      const feed = await parser.parseURL(source.url);
      for (const item of feed.items) {
        if (item.link && !posted.includes(item.link)) {
          newItems.push({ ...item, sourceName: source.name, sourceSelector: source.selector });
        }
      }
    } catch (err) {
      console.error(`Gagal mengambil feed "${source.name}":`, err.message);
    }
  }
  return newItems;
}

function ekstrakUrlGambar(item) {
  if (item.enclosure && item.enclosure.url) {
    const tipe = item.enclosure.type || '';
    if (!tipe || tipe.startsWith('image')) return item.enclosure.url;
  }
  if (item.mediaContent && item.mediaContent.$ && item.mediaContent.$.url) return item.mediaContent.$.url;
  if (item.mediaThumbnail && item.mediaThumbnail.$ && item.mediaThumbnail.$.url) return item.mediaThumbnail.$.url;

  const html = item['content:encoded'] || item.content || item.contentSnippet || '';
  const match = String(html).match(/<img[^>]+src=["']([^"']+)["']/i);
  return match ? match[1] : null;
}

async function ambilTeksArtikelLengkap(url, selectorKustom) {
  try {
    const res = await axios.get(url, {
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (auto-post-sains bot)' },
    });
    const $ = cheerio.load(res.data);
    const daftarSelector = [selectorKustom, '#text', '.entry-content', '.post-content', 'article'].filter(Boolean);
    for (const sel of daftarSelector) {
      const teks = $(sel).first().text().replace(/\s+/g, ' ').trim();
      if (teks && teks.length > 200) return teks.slice(0, 6000);
    }
    const gabunganParagraf = $('p').map((_, el) => $(el).text().trim()).get().filter(Boolean).join('\n');
    return gabunganParagraf ? gabunganParagraf.slice(0, 6000) : null;
  } catch (err) {
    console.warn(`  Gagal mengambil artikel lengkap dari ${url}: ${err.message} — memakai cuplikan RSS saja.`);
    return null;
  }
}

async function dapatkanIdTag(namaTag) {
  const auth = Buffer.from(`${WP_USER}:${WP_APP_PASSWORD}`).toString('base64');
  try {
    const cari = await axios.get(`${WP_URL}/wp-json/wp/v2/tags`, {
      params: { search: namaTag, per_page: 100 },
      headers: { Authorization: `Basic ${auth}` },
    });
    const cocok = cari.data.find((t) => t.name.toLowerCase() === namaTag.toLowerCase());
    if (cocok) return cocok.id;
    const buat = await axios.post(
      `${WP_URL}/wp-json/wp/v2/tags`,
      { name: namaTag },
      { headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' } }
    );
    return buat.data.id;
  } catch (err) {
    console.error(`Gagal memproses tag "${namaTag}":`, err.response?.data || err.message);
    return null;
  }
}
async function dapatkanIdTagBanyak(daftarNama) {
  const ids = [];
  for (const nama of daftarNama) {
    const id = await dapatkanIdTag(nama);
    if (id) ids.push(id);
  }
  return ids;
}

async function unggahFotoDenganKredit(urlGambar, sourceName) {
  if (!urlGambar) return null;
  try {
    const unduhan = await axios.get(urlGambar, {
      responseType: 'arraybuffer',
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (auto-post-sains bot)' },
    });
    const contentType = unduhan.headers['content-type'] || '';
    if (!contentType.startsWith('image/')) return null;

    const ekstensi = contentType.split('/')[1].split('+')[0].split(';')[0] || 'jpg';
    const namaFile = `sains-${Date.now()}.${ekstensi}`;
    const auth = Buffer.from(`${WP_USER}:${WP_APP_PASSWORD}`).toString('base64');

    const unggah = await axios.post(`${WP_URL}/wp-json/wp/v2/media`, unduhan.data, {
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${namaFile}"`,
      },
      maxBodyLength: Infinity,
    });
    const mediaId = unggah.data.id;
    const teksKredit = `Foto: ${sourceName}`;
    await axios.post(
      `${WP_URL}/wp-json/wp/v2/media/${mediaId}`,
      { caption: teksKredit, alt_text: teksKredit, description: teksKredit },
      { headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' } }
    );
    return { mediaId, sourceUrlWp: unggah.data.source_url };
  } catch (err) {
    console.warn('  Gagal mengunggah foto:', err.response?.data || err.message);
    return null;
  }
}

/**
 * INTI PEMBEDA MODUL INI: system prompt bergaya "sains populer" —
 * dirancang supaya hasilnya terasa seperti media pengetahuan populer
 * yang bikin pembaca penasaran lalu ber-"oh", BUKAN seperti buku
 * pelajaran/modul yang formal dan menggurui.
 */
async function tulisArtikelSainsDenganLuna(item) {
  const systemPrompt = `Anda adalah penulis sains populer untuk portal Probaca.com. Gaya tulisan Anda seperti media pengetahuan populer yang bikin pembaca berkata "Oh, ternyata begitu!" — BUKAN seperti buku pelajaran, modul sekolah, atau artikel ensiklopedia yang kaku dan menggurui.

Tugas Anda: mengubah materi sumber (berita/temuan sains) di bawah menjadi
artikel sains populer berbahasa Indonesia yang seru dibaca orang awam,
TETAP akurat berdasarkan sumber. Kalau materi sumber berbahasa Inggris,
TERJEMAHKAN SEKALIGUS ADAPTASI gayanya ke gaya populer Indonesia — jangan
menerjemahkan kaku kata demi kata.

Prinsip gaya penulisan yang WAJIB dipatuhi:
1. JANGAN dibuka dengan definisi formal (mis. "X adalah..."). Buka dengan
   PERTANYAAN, skenario sehari-hari, atau fakta mengejutkan yang memancing
   rasa penasaran — seperti membuka obrolan santai, bukan kuliah.
2. Bangun sedikit rasa penasaran dulu SEBELUM menjelaskan jawabannya —
   jangan langsung membocorkan inti jawaban di kalimat pertama.
3. Gunakan ANALOGI dari kehidupan sehari-hari yang akrab bagi orang
   Indonesia untuk menjelaskan konsep yang rumit/abstrak.
4. Tulis dengan nada ngobrol — boleh menyapa "kamu"/"kita", kalimat
   pendek-pendek, hindari nada menggurui atau berjarak seperti guru ke
   murid.
5. Kalau perlu istilah teknis, JELASKAN LANGSUNG dengan bahasa sederhana
   saat pertama kali disebut — jangan biarkan pembaca mencari sendiri.
6. TUTUP artikel dengan momen "aha" — satu-dua kalimat pamungkas yang
   merangkum insight utamanya secara berkesan, seolah pembaca baru saja
   "ngeh".
7. HINDARI struktur ala buku pelajaran: JANGAN pakai heading seperti
   "Pengertian"/"Ciri-ciri"/"Kesimpulan", JANGAN membuat poin-poin
   bernomor formal, JANGAN memakai nada menginstruksikan pembaca untuk
   "mempelajari" atau "memahami" sesuatu.
8. Tetap 100% berdasarkan fakta dari materi sumber — boleh dijelaskan
   dengan gaya santai, TAPI JANGAN mengarang data, angka, atau klaim
   ilmiah yang tidak ada di sumber.
9. Kalau materi sumber menyebut nama peneliti/institusi/jurnal, sebutkan
   juga di artikel Anda (dengan gaya santai, bukan sitasi akademis kaku)
   supaya tetap kredibel meski dibawakan santai.
10. Tambahkan teks "PROBACA.ID -" di awal artikel dan tutup dengan tanda "***" di akhir artikel.
11. Tambahkan teks "DISCLAIMER: Sebagian proses pengolahan artikel ini dibantu oleh teknologi AI. Pembaca disarankan memverifikasi kembali data dan informasi melalui sumber resmi atau sumber primer" di akhir artikel di bawah teks "***".

Keluarkan jawaban PERSIS dalam format berikut, tanpa teks tambahan lain:
JUDUL: <judul yang memancing rasa penasaran, gaya menarik tapi TIDAK clickbait/menyesatkan, maksimal 12 kata>
RINGKASAN: <SATU kalimat penggoda/hook (bukan ringkasan formal), akan tampil sebagai teaser di awal artikel, satu baris tanpa enter>
TAG: <PERSIS 4 kata kunci/frasa pendek dipisah koma, mewakili topik utama>
ISI: <isi artikel dalam HTML sederhana, tag <p> per paragraf, sekitar 300-500 kata, mengikuti SEMUA prinsip gaya di atas>`;

  let materiSumber = null;
  if (AMBIL_ARTIKEL_LENGKAP) {
    materiSumber = await ambilTeksArtikelLengkap(item.link, item.sourceSelector);
  }
  if (!materiSumber) {
    materiSumber = item.content || item.contentSnippet || '(tidak ada ringkasan tersedia)';
  }

  const userPrompt = `Sumber: ${item.sourceName}
Judul asli: ${item.title}
Materi sumber:
${materiSumber}

Tautan sumber asli: ${item.link}`;

  const response = await openai.responses.create({
    model: 'gpt-5.6-luna',
    reasoning: { effort: 'low' },
    input: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  });

  const text = response.output_text || '';
  const judulMatch = text.match(/JUDUL:\s*(.+)/);
  const ringkasanMatch = text.match(/RINGKASAN:\s*(.+)/);
  const tagMatch = text.match(/TAG:\s*(.+)/);
  const isiMatch = text.match(/ISI:\s*([\s\S]+)/);

  const tags = tagMatch
    ? tagMatch[1].split(',').map((t) => t.trim()).filter(Boolean).slice(0, 4)
    : [];

  return {
    judul: judulMatch ? judulMatch[1].trim() : item.title,
    ringkasan: ringkasanMatch ? ringkasanMatch[1].trim() : '',
    tags,
    isi: isiMatch ? isiMatch[1].trim() : `<p>${text.trim()}</p>`,
  };
}

async function postingKeWordPress({ judul, isi, sourceLink, sourceName, foto, ringkasan, tagIds }) {
  const auth = Buffer.from(`${WP_USER}:${WP_APP_PASSWORD}`).toString('base64');
  let kontenLengkap = '';

  if (SISIPKAN_FOTO_DI_ARTIKEL && foto && foto.sourceUrlWp) {
    kontenLengkap += `<figure class="wp-block-image"><img src="${foto.sourceUrlWp}" alt="Foto: ${sourceName}" /><figcaption>Foto: ${sourceName}</figcaption></figure>\n`;
  }
  if (SERTAKAN_RINGKASAN && ringkasan) {
    kontenLengkap += `<div class="ringkasan-berita" style="background:#f6f6f6;border-left:4px solid #2980b9;padding:14px 18px;margin:0 0 22px;font-size:1.05em;line-height:1.5;font-style:italic;">
  ${ringkasan}
</div>\n`;
  }
  kontenLengkap += isi;
  kontenLengkap += `\n<p><em>Sumber: <a href="${sourceLink}" target="_blank" rel="noopener nofollow">${sourceName}</a></em></p>`;

  const payload = {
    title: judul,
    content: kontenLengkap,
    status: POST_STATUS_SAINS,
    categories: [KATEGORI_SAINS_ID],
  };
  if (foto && foto.mediaId) payload.featured_media = foto.mediaId;
  if (SERTAKAN_RINGKASAN && ringkasan) payload.excerpt = ringkasan;
  if (SERTAKAN_TAG_OTOMATIS && tagIds && tagIds.length) payload.tags = tagIds;

  const res = await axios.post(`${WP_URL}/wp-json/wp/v2/posts`, payload, {
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
  });
  return res.data;
}

async function main() {
  console.log('Mengecek konten sains baru...');
  const semuaItemBaru = await fetchNewItems();
  console.log(`Ditemukan ${semuaItemBaru.length} item baru total.`);

  const items = semuaItemBaru.slice(0, MAKS_SAINS_PER_PROSES);
  if (semuaItemBaru.length > items.length) {
    console.log(`Memproses ${items.length} dulu (batas MAKS_SAINS_PER_PROSES=${MAKS_SAINS_PER_PROSES}); sisanya menyusul di jadwal berikutnya.`);
  }

  for (const item of items) {
    try {
      console.log(`Memproses: ${item.title}`);
      const artikel = await tulisArtikelSainsDenganLuna(item);

      let foto = null;
      if (SERTAKAN_FOTO) {
        const urlGambar = ekstrakUrlGambar(item);
        if (urlGambar) foto = await unggahFotoDenganKredit(urlGambar, item.sourceName);
      }

      let tagIds = [];
      if (SERTAKAN_TAG_OTOMATIS && artikel.tags.length) {
        tagIds = await dapatkanIdTagBanyak(artikel.tags);
      }

      const hasil = await postingKeWordPress({
        judul: artikel.judul,
        isi: artikel.isi,
        sourceLink: item.link,
        sourceName: item.sourceName,
        foto,
        ringkasan: artikel.ringkasan,
        tagIds,
      });
      console.log(`Berhasil dibuat sebagai "${POST_STATUS_SAINS}" -> ID: ${hasil.id}${foto ? ' (dengan foto)' : ''}${tagIds.length ? ` (${tagIds.length} tag)` : ''}`);
      savePostedLink(item.link);
    } catch (err) {
      console.error(`Gagal memproses "${item.title}":`, err.response?.data || err.message);
    }
  }

  console.log('Selesai.');
}

main().catch((err) => {
  console.error('Terjadi error fatal:', err);
  process.exit(1);
});
