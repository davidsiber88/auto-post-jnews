/**
 * auto-post-luna.js
 * ---------------------------------------------------------------
 * Sistem auto-posting berita ke WordPress (tema JNews) menggunakan
 * model OpenAI GPT-5.6 Luna untuk menulis ulang/meringkas berita
 * berdasarkan sumber RESMI (rilis pers, RSS lembaga negara, dll),
 * lengkap dengan foto dari sumber yang sama beserta kredit fotonya.
 *
 * PENTING (baca dulu sebelum pakai):
 * 1) Skrip ini secara default membuat DRAFT, bukan langsung tayang
 *    (lihat POST_STATUS di .env). Selalu ada proses review redaksi
 *    manusia sebelum publish — ini bukan cuma soal hukum, tapi juga
 *    tanggung jawab jurnalistik.
 * 2) Hanya gunakan sumber yang memang boleh diringkas/diolah ulang,
 *    termasuk fotonya (rilis pers resmi, data pemerintah, feed yang
 *    punya izin sindikasi). Jangan menarik artikel/foto penuh dari
 *    media lain lalu menyuruh AI "menulis ulang" — itu berisiko
 *    pelanggaran hak cipta & plagiarisme, walau kata-katanya beda.
 * 3) Selalu cantumkan atribusi sumber di setiap artikel DAN di
 *    setiap foto yang dipakai (sudah otomatis dilakukan skrip ini).
 * ---------------------------------------------------------------
 */

require('dotenv').config();
const axios = require('axios');
const Parser = require('rss-parser');
const OpenAI = require('openai');
const fs = require('fs');

// ---------- KONFIGURASI ----------
const WP_URL = process.env.WP_URL; // contoh: https://probaca.com
const WP_USER = process.env.WP_USER; // username WordPress Anda
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD; // application password (lihat panduan Bagian 3)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DEFAULT_CATEGORY_ID = parseInt(process.env.DEFAULT_CATEGORY_ID || '1', 10);
const POST_STATUS = process.env.POST_STATUS || 'draft'; // 'draft' (disarankan) atau 'publish'
const SERTAKAN_FOTO = (process.env.SERTAKAN_FOTO || 'true') === 'true'; // set 'false' untuk matikan seluruh fitur foto (tidak ambil & tidak upload foto sama sekali)
const SISIPKAN_FOTO_DI_ARTIKEL = (process.env.SISIPKAN_FOTO_DI_ARTIKEL || 'false') === 'true'; // default MATI supaya tidak dobel dengan featured image yang sudah ditampilkan tema JNews di atas artikel
const MAKS_BERITA_PER_PROSES = parseInt(process.env.MAKS_BERITA_PER_PROSES || '1', 10); // batas jumlah berita yang diproses dalam satu kali jalan
const SERTAKAN_RINGKASAN = (process.env.SERTAKAN_RINGKASAN || 'true') === 'true'; // tampilkan kotak ringkasan/highlight di awal artikel
const SERTAKAN_TAG_OTOMATIS = (process.env.SERTAKAN_TAG_OTOMATIS || 'true') === 'true'; // isi 4 tag WordPress secara otomatis


// Daftar sumber RSS. GANTI dengan sumber RESMI sesuai rubrik Anda.
// Contoh sumber resmi Indonesia yang umum menyediakan RSS/rilis publik:
// - setkab.go.id (Sekretariat Kabinet)

const RSS_SOURCES = [
  { name: 'Setkab RI', url: 'https://setkab.go.id/feed/' },
  { name: 'Pronusantara.com', url: 'https://rss.promediateknologi.id/feed/social?apikey=71c4f47ad3004225e94879c772a703ef41204014' },
  { name: 'Detik.com', url: 'https://news.detik.com/berita/rss' },
  { name: 'Kemhan.go.id', url: 'https://www.kemhan.go.id/category/berita/feed' },
];

const LOG_FILE = './posted-log.json'; // penyimpanan sederhana anti-duplikat
// -----------------------------------

// customFields ditambahkan supaya rss-parser juga menangkap tag
// media:content / media:thumbnail (ekstensi Media RSS yang sering
// dipakai untuk menyisipkan foto di feed lembaga resmi).
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
          newItems.push({ ...item, sourceName: source.name });
        }
      }
    } catch (err) {
      console.error(`Gagal mengambil feed "${source.name}":`, err.message);
    }
  }
  return newItems;
}

/**
 * Mencari URL foto dari item RSS, dengan urutan prioritas:
 * 1) tag <enclosure> standar RSS (kalau tipenya gambar)
 * 2) tag Media RSS <media:content> / <media:thumbnail>
 * 3) gambar pertama yang ditemukan di dalam isi/HTML artikel
 * Kembalikan null kalau tidak ada foto yang bisa dipakai.
 */
function ekstrakUrlGambar(item) {
  if (item.enclosure && item.enclosure.url) {
    const tipe = item.enclosure.type || '';
    if (!tipe || tipe.startsWith('image')) return item.enclosure.url;
  }

  if (item.mediaContent && item.mediaContent.$ && item.mediaContent.$.url) {
    return item.mediaContent.$.url;
  }
  if (item.mediaThumbnail && item.mediaThumbnail.$ && item.mediaThumbnail.$.url) {
    return item.mediaThumbnail.$.url;
  }

  const html = item['content:encoded'] || item.content || item.contentSnippet || '';
  const match = String(html).match(/<img[^>]+src=["']([^"']+)["']/i);
  if (match) return match[1];

  return null;
}

/**
 * Mengunduh foto dari sumber, mengunggahnya ke Media Library WordPress,
 * lalu menandai caption & alt text-nya dengan kredit foto berdasarkan
 * nama sumber. Mengembalikan { mediaId, sourceUrlWp } atau null kalau
 * gagal/tidak ada foto.
 */
async function unggahFotoDenganKredit(urlGambar, sourceName) {
  if (!urlGambar) return null;

  try {
    const unduhan = await axios.get(urlGambar, {
      responseType: 'arraybuffer',
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (auto-post-jnews bot)' },
    });

    const contentType = unduhan.headers['content-type'] || '';
    if (!contentType.startsWith('image/')) {
      console.warn(`Dilewati: URL bukan gambar (${contentType || 'tidak diketahui'}) -> ${urlGambar}`);
      return null;
    }

    const ekstensi = contentType.split('/')[1].split('+')[0].split(';')[0] || 'jpg';
    const namaFile = `berita-${Date.now()}.${ekstensi}`;
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
    const teksKredit = `Sumber ${sourceName}`;

    // Tandai caption & alt text supaya kredit foto ikut tampil
    // (JNews umumnya menampilkan caption media di bawah featured image).
    await axios.post(
      `${WP_URL}/wp-json/wp/v2/media/${mediaId}`,
      { caption: teksKredit, alt_text: teksKredit, description: teksKredit },
      { headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' } }
    );

    return { mediaId, sourceUrlWp: unggah.data.source_url };
  } catch (err) {
    console.error('Gagal mengunggah foto:', err.response?.data || err.message);
    return null;
  }
}

/**
 * Mencari ID tag WordPress berdasarkan nama; kalau belum ada, membuat tag
 * baru. Mengembalikan ID (number) atau null kalau gagal.
 */
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

/** Memanggil dapatkanIdTag() untuk beberapa nama tag sekaligus. */
async function dapatkanIdTagBanyak(daftarNamaTag) {
  const ids = [];
  for (const nama of daftarNamaTag) {
    const id = await dapatkanIdTag(nama);
    if (id) ids.push(id);
  }
  return ids;
}

async function tulisArtikelDenganLuna(item) {
  const systemPrompt = `Anda adalah jurnalis dan editor profesional untuk portal berita Probaca.com.

Tugas Anda: menulis ULANG (bukan menyalin atau menerjemahkan kalimat demi
kalimat) sebuah kabar menjadi artikel berita berbahasa Indonesia yang
orisinal, jelas, netral, tersusun dan tertata dengan baik, serta mengikuti
kaidah jurnalistik 5W+1H.

Aturan ketat yang WAJIB dipatuhi:
1. Dasarkan tulisan HANYA pada informasi yang diberikan. Jangan menambahkan hal yang tidak ada pada sumber. 
2. Pertahankan SEMUA kutipan langsung yang terdapat dalam sumber, tidak boleh ditambah, dikurangi, diperbaiki, dipoles, atau diubah.
3. Masukkan juga pernyataan tidak langsung dalam sumber apabila tersedia. Bagian ini boleh disusun ulang dengan gaya Bahasa sendiri, selama tidak mengubah makna atau fakta yang disampaikan sumber.
4. Jangan membuat kutipan baru.
5. Jika informasi kurang lengkap, tulis secukupnya. Jangan mengisi kekosongan dengan dugaan.
6. Hilangkan pengulangan informasi yang tidak diperlukan.
5. Jaga nada netral dan objektif sepanjang artikel; hindari opini pribadi atau bahasa yang menghakimi/menyimpulkan sepihak.
8. Tambahkan teks "PROBACA.ID -" di awal artikel dan tutup dengan tanda "***" di akhir artikel.

Keluarkan jawaban PERSIS dalam format berikut, tanpa teks tambahan lain:
JUDUL: <judul berita, maksimal 12 kata, ringkas dan SEO-friendly>
RINGKASAN: <ringkasan/highlight inti berita dalam SATU paragraf singkat (2-3 kalimat, sekitar 40-60 kata), ditulis dalam satu baris tanpa enter — akan ditampilkan di kotak highlight terpisah di awal artikel, jadi jangan sekadar mengulang kalimat pertama isi berita>
TAG: <PERSIS 4 kata kunci/frasa pendek, dipisah koma, tanpa tanda pagar #, mewakili topik utama artikel (mis. nama tempat, nama instansi, isu, sektor)>
ISI: <isi berita dalam HTML sederhana, gunakan tag <p> per paragraf, 300-500 kata>`;

  const userPrompt = `Sumber: ${item.sourceName}
Judul asli: ${item.title}
Ringkasan/isi yang tersedia: ${item.contentSnippet || item.content || '(tidak ada ringkasan tersedia)'}
Tautan sumber asli: ${item.link}`;

  const response = await openai.responses.create({
    model: 'gpt-5.6-luna',
    reasoning: { effort: 'low' }, // cukup untuk tugas rewrite/ringkas; lihat panduan Bagian 2.4
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

  // Foto sudah ditampilkan lewat featured_media (diatur JNews otomatis di atas
  // artikel). Sisipan <figure> berikut ini OPSIONAL, dimatikan secara default,
  // supaya foto tidak muncul dua kali. Aktifkan lewat SISIPKAN_FOTO_DI_ARTIKEL=true
  // di .env kalau tema/tampilan Anda ternyata TIDAK menampilkan featured image
  // secara otomatis.
  if (SISIPKAN_FOTO_DI_ARTIKEL && foto && foto.sourceUrlWp) {
    kontenLengkap += `<figure class="wp-block-image"><img src="${foto.sourceUrlWp}" alt="Foto: ${sourceName}" /><figcaption>Foto: ${sourceName}</figcaption></figure>\n`;
  }

  // Kotak ringkasan/highlight di awal artikel, sebelum isi berita.
  // Styling ditulis inline (bukan bergantung pada class tema tertentu) supaya
  // tetap tampil rapi di JNews versi apa pun. Sesuaikan warna/gaya sesukanya.
  if (SERTAKAN_RINGKASAN && ringkasan) {
    kontenLengkap += `<div class="ringkasan-berita" style="background:#f6f6f6;border-left:4px solid #c0392b;padding:14px 18px;margin:0 0 22px;font-size:1.05em;line-height:1.5;">
  <strong style="display:block;margin-bottom:6px;text-transform:uppercase;font-size:0.8em;letter-spacing:0.05em;color:#c0392b;">Ringkasan</strong>
  ${ringkasan}
</div>\n`;
  }

  kontenLengkap += isi;
  kontenLengkap += `\n<p><em>Sumber: <a href="${sourceLink}" target="_blank" rel="noopener nofollow">${sourceName}</a></em></p>`;

  const payload = {
    title: judul,
    content: kontenLengkap,
    status: POST_STATUS,
    categories: [DEFAULT_CATEGORY_ID],
  };
  if (foto && foto.mediaId) {
    payload.featured_media = foto.mediaId;
  }
  if (SERTAKAN_RINGKASAN && ringkasan) {
    payload.excerpt = ringkasan; // ikut mengisi excerpt WordPress (dipakai JNews di listing/arsip & meta SEO)
  }
  if (SERTAKAN_TAG_OTOMATIS && tagIds && tagIds.length) {
    payload.tags = tagIds;
  }

  const res = await axios.post(`${WP_URL}/wp-json/wp/v2/posts`, payload, {
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
  });
  return res.data;
}

async function main() {
  console.log('Mengecek sumber berita baru...');
  const semuaItemBaru = await fetchNewItems();
  console.log(`Ditemukan ${semuaItemBaru.length} item baru total.`);

  const items = semuaItemBaru.slice(0, MAKS_BERITA_PER_PROSES);
  if (semuaItemBaru.length > items.length) {
    console.log(`Memproses ${items.length} item dulu (batas MAKS_BERITA_PER_PROSES=${MAKS_BERITA_PER_PROSES}). Sisanya ${semuaItemBaru.length - items.length} item akan diproses di jadwal berikutnya.`);
  } else {
    console.log(`Memproses ${items.length} item.`);
  }

  for (const item of items) {
    try {
      console.log(`Memproses: ${item.title}`);
      const artikel = await tulisArtikelDenganLuna(item);

      let foto = null;
      if (SERTAKAN_FOTO) {
        const urlGambar = ekstrakUrlGambar(item);
        if (urlGambar) {
          foto = await unggahFotoDenganKredit(urlGambar, item.sourceName);
        } else {
          console.log('  Tidak ditemukan foto pada item ini, dilanjutkan tanpa foto.');
        }
      }

      let tagIds = [];
      if (SERTAKAN_TAG_OTOMATIS && artikel.tags && artikel.tags.length) {
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
      console.log(`Berhasil dibuat sebagai "${POST_STATUS}" -> ID: ${hasil.id}${foto ? ' (dengan foto + kredit)' : ''}${tagIds.length ? ` (${tagIds.length} tag)` : ''}`);
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

