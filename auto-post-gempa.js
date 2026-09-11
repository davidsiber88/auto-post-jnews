/**
 * auto-post-gempa.js
 * ---------------------------------------------------------------
 * Auto-posting berita GEMPA BUMI TERKINI ke WordPress (JNews),
 * berdasarkan data RESMI BMKG (Badan Meteorologi, Klimatologi, dan
 * Geofisika) — data terbuka, TANPA perlu API key/autentikasi apa pun
 * dari BMKG. Artikelnya ditulis oleh GPT-5.6 Luna berdasarkan data
 * terstruktur ini (bukan RSS/teks bebas seperti auto-post-luna.js).
 *
 * Sumber data resmi:
 * https://data.bmkg.go.id/DataMKG/TEWS/gempaterkini.json
 * (berisi 15 data gempa M5.0+ terbaru)
 *
 * PENTING:
 * 1) Default status DRAFT — selalu review manusia sebelum tayang,
 *    apalagi untuk info kebencanaan yang butuh akurasi tinggi.
 * 2) Beberapa situs pemerintah Indonesia (termasuk berpotensi BMKG)
 *    kadang membatasi permintaan dari IP datacenter/cloud (termasuk
 *    GitHub Actions). Kalau proses gagal terus dengan error koneksi
 *    (ETIMEDOUT/ENETUNREACH/403), pertimbangkan pindah menjalankan
 *    skrip ini lewat cron di hosting sendiri (Bagian 6 Opsi A pada
 *    panduan utama) alih-alih GitHub Actions.
 * 3) Skrip ini berbagi WP_URL/WP_USER/WP_APP_PASSWORD/OPENAI_API_KEY
 *    yang sama dengan auto-post-luna.js — tidak perlu akun terpisah.
 * ---------------------------------------------------------------
 */

require('dotenv').config();
const axios = require('axios');
const OpenAI = require('openai');
const fs = require('fs');

// ---------- KONFIGURASI ----------
const WP_URL = process.env.WP_URL;
const WP_USER = process.env.WP_USER;
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const KATEGORI_GEMPA_ID = parseInt(process.env.KATEGORI_GEMPA_ID || '1', 10); // ID kategori "Gempa"/"Bencana" di WordPress
const POST_STATUS_GEMPA = process.env.POST_STATUS_GEMPA || 'draft'; // 'draft' (disarankan) atau 'publish'
const MAGNITUDE_MINIMAL = parseFloat(process.env.MAGNITUDE_MINIMAL || '5.0'); // lewati gempa di bawah magnitudo ini
const MAKS_GEMPA_PER_PROSES = parseInt(process.env.MAKS_GEMPA_PER_PROSES || '2', 10); // batas jumlah gempa diproses sekali jalan
const SERTAKAN_SHAKEMAP = (process.env.SERTAKAN_SHAKEMAP || 'true') === 'true'; // pasang peta guncangan BMKG sebagai featured image
const SERTAKAN_RINGKASAN = (process.env.SERTAKAN_RINGKASAN || 'true') === 'true';
const SERTAKAN_TAG_OTOMATIS = (process.env.SERTAKAN_TAG_OTOMATIS || 'true') === 'true';

const URL_GEMPA_TERKINI = 'https://data.bmkg.go.id/DataMKG/TEWS/autogempa.json'; // 15 gempa M5.0+ terbaru, resmi BMKG
const LOG_FILE = './posted-gempa-log.json'; // dedup terpisah dari posted-log.json milik auto-post-luna.js
// -----------------------------------

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

function loadPostedKeys() {
  if (!fs.existsSync(LOG_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(LOG_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function savePostedKey(key) {
  const keys = loadPostedKeys();
  keys.push(key);
  fs.writeFileSync(LOG_FILE, JSON.stringify(keys, null, 2));
}

/** Mengambil daftar gempa terkini (M5.0+) langsung dari data terbuka BMKG. */
async function ambilDataGempaTerkini() {
  const res = await axios.get(URL_GEMPA_TERKINI, {
    timeout: 15000,
    headers: { 'User-Agent': 'Mozilla/5.0 (auto-post-gempa bot)' },
  });
  const daftar = res.data?.Infogempa?.gempa;
  return Array.isArray(daftar) ? daftar : [daftar].filter(Boolean);
}

/** Sama seperti di auto-post-luna.js: cari/buat tag WordPress berdasarkan nama. */
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

async function dapatkanIdTagBanyak(daftarNamaTag) {
  const ids = [];
  for (const nama of daftarNamaTag) {
    const id = await dapatkanIdTag(nama);
    if (id) ids.push(id);
  }
  return ids;
}

/**
 * Mengunduh peta guncangan (shakemap) resmi BMKG untuk gempa ini, lalu
 * mengunggahnya ke Media Library WordPress dengan kredit "BMKG".
 * Mengembalikan null kalau tidak ada shakemap atau gagal diunggah.
 */
async function unggahShakemapDenganKredit(namaFileShakemap) {
  if (!namaFileShakemap) return null;
  const urlGambar = `https://data.bmkg.go.id/DataMKG/TEWS/${namaFileShakemap}`;

  try {
    const unduhan = await axios.get(urlGambar, {
      responseType: 'arraybuffer',
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (auto-post-gempa bot)' },
    });
    const contentType = unduhan.headers['content-type'] || '';
    if (!contentType.startsWith('image/')) return null;

    const ekstensi = contentType.split('/')[1].split('+')[0].split(';')[0] || 'jpg';
    const namaFile = `shakemap-${Date.now()}.${ekstensi}`;
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
    const teksKredit = 'Peta guncangan (shakemap): BMKG';
    await axios.post(
      `${WP_URL}/wp-json/wp/v2/media/${mediaId}`,
      { caption: teksKredit, alt_text: teksKredit, description: teksKredit },
      { headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' } }
    );

    return { mediaId, sourceUrlWp: unggah.data.source_url };
  } catch (err) {
    console.warn('  Gagal mengunggah shakemap:', err.response?.data || err.message);
    return null;
  }
}

async function tulisArtikelGempaDenganLuna(gempa) {
  const systemPrompt = `Anda adalah jurnalis profesional untuk portal berita Probaca.com, menulis berita kebencanaan berdasarkan data resmi BMKG (Badan Meteorologi, Klimatologi, dan Geofisika).

Tugas Anda: menyusun data gempa bumi berikut menjadi artikel berita singkat
berbahasa Indonesia yang jelas, akurat, netral, dan mengikuti kaidah
jurnalistik kebencanaan.

Aturan ketat yang WAJIB dipatuhi:
1. Gunakan HANYA data yang diberikan. JANGAN menambahkan informasi korban
   jiwa, kerusakan bangunan, atau detail apa pun yang tidak ada di data —
   data yang diberikan TIDAK memuat info semacam itu, jadi jangan mengarang.
2. Sebutkan status POTENSI secara jelas dan menonjol, PERSIS sesuai
   data yang diberikan — jangan diperlemah atau diperkuat maknanya.
3. Kalau ada data wilayah yang merasakan guncangan (dirasakan), sebutkan.
4. Setelah memaparkan fakta gempa, TUTUP artikel dengan SATU paragraf
   singkat berisi imbauan keselamatan gempa bumi yang bersifat UMUM dan
   baku (mis. menjauhi bangunan retak/reruntuhan, waspada gempa susulan,
   mengikuti arahan petugas setempat) — tandai jelas ini sebagai imbauan
   umum kebencanaan, BUKAN pernyataan resmi BMKG tentang kejadian ini.
5. JANGAN membuat kutipan langsung (tanda kutip) dari BMKG kecuali memang
   ada kalimat kutipan di data yang diberikan (umumnya tidak ada — data
   di bawah berupa angka/fakta terstruktur saja).
6. Jaga nada tenang dan faktual, hindari bahasa yang memicu kepanikan.
7. Tambahkan teks "PROBACA.ID -" di awal artikel dan tutup dengan tanda "***" di akhir artikel.
8. Tambahkan teks "DISCLAIMER: Sebagian proses pengolahan artikel ini dibantu oleh teknologi AI. Pembaca disarankan memverifikasi kembali data dan informasi melalui sumber resmi atau sumber primer" di akhir artikel di bawah teks "***".


Keluarkan jawaban PERSIS dalam format berikut, tanpa teks tambahan lain:
JUDUL: <judul berita, maksimal 12 kata, sebutkan magnitudo & lokasi>
RINGKASAN: <ringkasan inti dalam SATU paragraf singkat (2-3 kalimat, 40-60 kata), satu baris tanpa enter>
TAG: <PERSIS 4 kata kunci/frasa pendek dipisah koma — mis. nama wilayah, "gempa bumi", magnitudo, status tsunami>
ISI: <isi berita dalam HTML sederhana, tag <p> per paragraf, sekitar 150-300 kata (berita gempa memang ringkas & padat fakta)>`;

  const baris = [
    `Tanggal: ${gempa.Tanggal || '-'}`,
    `Jam: ${gempa.Jam || '-'}`,
    `Magnitudo: ${gempa.Magnitude || '-'} SR`,
    `Kedalaman: ${gempa.Kedalaman || '-'}`,
    `Lokasi/Wilayah: ${gempa.Wilayah || '-'}`,
    `Koordinat: ${gempa.Coordinates || '-'}`,
    `Potensi: ${gempa.Potensi || '-'}`,
    `Dirasakan: ${gempa.Dirasakan || '-'}`,
  ];
  if (gempa.Dirasakan) baris.push(`Dirasakan di: ${gempa.Dirasakan}`);

  const userPrompt = `Data gempa dari BMKG:\n${baris.join('\n')}`;

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
    judul: judulMatch ? judulMatch[1].trim() : `Gempa M${gempa.Magnitude} - ${gempa.Wilayah}`,
    ringkasan: ringkasanMatch ? ringkasanMatch[1].trim() : '',
    tags,
    isi: isiMatch ? isiMatch[1].trim() : `<p>${text.trim()}</p>`,
  };
}

async function postingKeWordPress({ judul, isi, ringkasan, tagIds, foto }) {
  const auth = Buffer.from(`${WP_USER}:${WP_APP_PASSWORD}`).toString('base64');
  let kontenLengkap = '';

  if (SERTAKAN_RINGKASAN && ringkasan) {
    kontenLengkap += `<div class="ringkasan-berita" style="background:#f6f6f6;border-left:4px solid #c0392b;padding:14px 18px;margin:0 0 22px;font-size:1.05em;line-height:1.5;">
  <strong style="display:block;margin-bottom:6px;text-transform:uppercase;font-size:0.8em;letter-spacing:0.05em;color:#c0392b;">Ringkasan</strong>
  ${ringkasan}
</div>\n`;
  }

  kontenLengkap += isi;
  kontenLengkap += `\n<p><em>Diolah dari data BMKG (Badan Meteorologi, Klimatologi, dan Geofisika)</em></p>`;

  const payload = {
    title: judul,
    content: kontenLengkap,
    status: POST_STATUS_GEMPA,
    categories: [KATEGORI_GEMPA_ID],
  };
  if (foto && foto.mediaId) payload.featured_media = foto.mediaId;
  if (SERTAKAN_RINGKASAN && ringkasan) payload.excerpt = ringkasan;
  if (SERTAKAN_TAG_OTOMATIS && tagIds && tagIds.length) payload.tags = tagIds;

  const res = await axios.post(`${WP_URL}/wp-json/wp/v2/posts`, payload, {
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
  });
  return res.data;
}

async function main() {
  console.log('Mengecek data gempa terkini dari BMKG...');
  const semuaGempa = await ambilDataGempaTerkini();
  const posted = loadPostedKeys();

  const gempaBaru = semuaGempa.filter((g) => {
    const magnitudo = parseFloat(g.Magnitude);
    const sudahDiproses = !g.DateTime || posted.includes(g.DateTime);
    const cukupBesar = isNaN(magnitudo) || magnitudo >= MAGNITUDE_MINIMAL;
    return !sudahDiproses && cukupBesar;
  });

  console.log(`Ditemukan ${gempaBaru.length} gempa baru (>= M${MAGNITUDE_MINIMAL}) dari total ${semuaGempa.length} data BMKG.`);

  const diproses = gempaBaru.slice(0, MAKS_GEMPA_PER_PROSES);
  if (gempaBaru.length > diproses.length) {
    console.log(`Memproses ${diproses.length} dulu (batas MAKS_GEMPA_PER_PROSES=${MAKS_GEMPA_PER_PROSES}); sisanya ${gempaBaru.length - diproses.length} akan diproses di jadwal berikutnya.`);
  }

  for (const gempa of diproses) {
    try {
      console.log(`Memproses: M${gempa.Magnitude} - ${gempa.Wilayah} (${gempa.DateTime})`);
      const artikel = await tulisArtikelGempaDenganLuna(gempa);

      let foto = null;
      if (SERTAKAN_SHAKEMAP && gempa.Shakemap) {
        foto = await unggahShakemapDenganKredit(gempa.Shakemap);
      }

      let tagIds = [];
      if (SERTAKAN_TAG_OTOMATIS && artikel.tags.length) {
        tagIds = await dapatkanIdTagBanyak(artikel.tags);
      }

      const hasil = await postingKeWordPress({
        judul: artikel.judul,
        isi: artikel.isi,
        ringkasan: artikel.ringkasan,
        tagIds,
        foto,
      });
      console.log(`Berhasil dibuat sebagai "${POST_STATUS_GEMPA}" -> ID: ${hasil.id}${foto ? ' (dengan shakemap)' : ''}${tagIds.length ? ` (${tagIds.length} tag)` : ''}`);
      savePostedKey(gempa.DateTime);
    } catch (err) {
      console.error(`Gagal memproses gempa (${gempa.DateTime}):`, err.response?.data || err.message);
    }
  }

  console.log('Selesai.');
}

main().catch((err) => {
  console.error('Terjadi error fatal:', err);
  process.exit(1);
});
