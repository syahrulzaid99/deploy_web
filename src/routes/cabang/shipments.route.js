const express = require('express');
const router = express.Router();
const csrf = require('csurf');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const { db } = require('../../firebaseAdmin');
const { requireAuth, requireRole } = require('../../middleware/auth');
const admin = require('firebase-admin');

const csrfProtection = csrf({ cookie: true });
router.use(express.urlencoded({ extended: false }));

// ===== Upload setup (bukti foto penerimaan) =====
const proofsRoot = path.join(__dirname, '..', '..', '..', 'uploads', 'shipments_proofs');
try {
    if (!fs.existsSync(proofsRoot)) {
        fs.mkdirSync(proofsRoot, { recursive: true });
    }
} catch (e) {
    console.warn('Gagal membuat folder shipments proofs:', e.message);
}
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, proofsRoot),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname || '').toLowerCase();
        const name = Date.now() + '-' + Math.random().toString(36).slice(2, 8) + ext;
        cb(null, name);
    }
});
function fileFilter(req, file, cb) {
    const ok = /^image\/(png|jpe?g|gif|webp|svg\+xml)$/.test(file.mimetype);
    cb(ok ? null : new Error('File harus gambar'), ok);
}
const upload = multer({ storage, fileFilter, limits: { fileSize: 5 * 1024 * 1024 } }); // 5MB/berkas
function proofUrl(filename) { return filename ? `/uploads/shipments_proofs/${filename}` : ''; }

// helpers
async function getUsersMapByIds(ids = []) {
    if (!ids.length) return {};
    const chunks = [];
    for (let i = 0; i < ids.length; i += 10) chunks.push(ids.slice(i, i + 10));
    const map = {};
    for (const chunk of chunks) {
        const snaps = await Promise.all(chunk.map(id => db.collection('users').doc(id).get()));
        for (const s of snaps) if (s.exists) map[s.id] = s.data();
    }
    return map;
}

// ====================== CABANG: LIST & KONFIRMASI ======================

// daftar pengiriman untuk cabang yang login
router.get('/cabang/shipments', requireAuth, requireRole(['cabang']), csrfProtection, async (req, res) => {
    const snap = await db.collection('shipments')
        .where('penerima', '==', req.user.uid)
        .get();
    const shipmentsAll = snap.docs.map(d => d.data());
    // tampilkan semua kecuali 'draft'
    const shipments = shipmentsAll.filter(s => String(s.status || '').toLowerCase() !== 'draft');

    const semuaUserIds = [...new Set([
        ...shipments.map(s => s.pengirim).filter(Boolean),
        ...shipments.map(s => s.penerima).filter(Boolean),
    ])];
    const usersMap = await getUsersMapByIds(semuaUserIds);

    const prodSnap = await db.collection('products').orderBy('sku').get();
    const products = prodSnap.docs.map(d => d.data());
    // index produk lengkap: by id, sku (trim+lower), barcode (trim)
    const productsById = {};
    const productsBySku = {};
    const productsByBarcode = {};
    for (const p of products) {
        if (p && p.id) productsById[p.id] = p;
        const sku = (p && p.sku ? String(p.sku).trim().toLowerCase() : '');
        if (sku) productsBySku[sku] = p;
        const bc = (p && p.barcode ? String(p.barcode).trim() : '');
        if (bc) productsByBarcode[bc] = p;
    }

    // helper normalisasi qty
    const getQty = (it) => {
        if (it == null) return 0;
        if (it.qty != null) return Number(it.qty);
        if (it.jumlah != null) return Number(it.jumlah);
        if (it.quantity != null) return Number(it.quantity);
        if (it.qty_in != null) return Number(it.qty_in);
        if (it.qty_out != null) return Number(it.qty_out);
        return 0;
    };

    // helper resolve produk dari berbagai kemungkinan field
    const resolveProduct = (it = {}) => {
        const candIds = [
            it.product_id, it.produk_id, it.productId, it.id, it.product, it.pid, it.id_produk
        ].filter(Boolean);
        for (const cid of candIds) {
            const pid = String(cid).trim();
            if (pid && productsById[pid]) return productsById[pid];
            // kadang ada data lama yang salah isi id dengan sku → coba map sku juga
            const pidAsSku = String(cid).trim().toLowerCase();
            if (pidAsSku && productsBySku[pidAsSku]) return productsBySku[pidAsSku];
        }
        const sku = it.sku ? String(it.sku).trim().toLowerCase() : '';
        if (sku && productsBySku[sku]) return productsBySku[sku];
        const bc = it.barcode ? String(it.barcode).trim() : '';
        if (bc && productsByBarcode[bc]) return productsByBarcode[bc];
        return null;
    };

    // enrich tiap shipment → items dengan _p (produk) & _qty
    const shipmentsEnriched = shipments.map(s => {
        const items = Array.isArray(s.data_barang) ? s.data_barang : [];
        const itemsEnriched = items.map(it => {
            const p = resolveProduct(it);
            const qty = getQty(it);
            return {
                ...it,
                _qty: isNaN(qty) ? 0 : qty,
                _p: p ? {
                    id: p.id,
                    sku: p.sku || '',
                    nama_produk: p.nama_produk || '',
                    satuan: p.satuan || '',
                    barcode: p.barcode || '',
                    gambar_url: p.gambar_url || ''
                } : null
            };
        });
        return { ...s, _items: itemsEnriched };
    });

    res.render('cabang/shipments', {
        title: 'Pengiriman Masuk (Cabang)',
        csrfToken: req.csrfToken(),
        user: req.user, profile: req.profile,
        shipments: shipmentsEnriched,
        usersMap,
        ok: req.query.ok || null, err: req.query.err || null,
    });
});

// konfirmasi terima/ditolak oleh cabang
router.post('/cabang/shipments/:id/confirm',
    requireAuth,
    requireRole(['cabang']),
    upload.array('bukti_foto', 10),  // <= foto bukti (opsional, max 10)
    csrfProtection,
    async (req, res) => {
        try {
            const id = req.params.id;
            // Normalisasi 'aksi' agar selalu string tunggal
            let aksi = req.body.aksi;
            if (Array.isArray(aksi)) aksi = aksi[aksi.length - 1];
            aksi = String(aksi || '').toLowerCase();
            const keterangan = typeof req.body.keterangan === 'string' ? req.body.keterangan.trim() : '';
            if (!['diterima', 'ditolak'].includes(aksi)) {
                return res.redirect('/cabang/shipments?err=' + encodeURIComponent('Aksi tidak valid'));
            }
            const ref = db.collection('shipments').doc(id);
            const cur = await ref.get();
            if (!cur.exists) return res.redirect('/cabang/shipments?err=' + encodeURIComponent('Pengiriman tidak ditemukan'));
            if (cur.data().penerima !== req.user.uid) return res.status(403).send('Forbidden');

            if (aksi === 'ditolak') {
                await ref.update({
                    status: 'ditolak',
                    keterangan: keterangan || cur.data().keterangan || '',
                    ditolak_at: new Date(),
                    ditolak_oleh: req.user.uid
                });

                // Restore stock to central warehouse since branch rejected it
                const items = Array.isArray(cur.data().data_barang) ? cur.data().data_barang : [];
                const batch = db.batch();
                let hasOp = false;
                for (const item of items) {
                    const qty = Number(item.qty || item.jumlah || item._qty || 0);
                    const pid = item.product_id || item.produk_id || item.productId || item.id_produk;
                    if (qty > 0 && pid) {
                        batch.update(db.collection('products').doc(pid), {
                            stok: admin.firestore.FieldValue.increment(qty),
                            updatedAt: new Date()
                        });
                        hasOp = true;
                    }
                }
                if (hasOp) await batch.commit().catch(e => console.error('Failed to restore stock on reject:', e));

                return res.redirect('/cabang/shipments?ok=confirmed');
            }

            // === aksi: diterima ===
            const body = req.body;
            const asArray = v => Array.isArray(v) ? v : (v != null ? [v] : []);
            const qtyArr = asArray(body['qty_diterima']); // sejajar dengan data_barang (index-based)
            const noteArr = asArray(body['catatan_item']); // opsional

            const dataCur = cur.data();
            const items = Array.isArray(dataCur.data_barang) ? dataCur.data_barang : [];
            const itemsBaru = items.map((it, idx) => {
                const qty = Number(qtyArr[idx] ?? it._qty ?? it.qty ?? 0);
                const cat = String(noteArr[idx] ?? '').trim();
                return {
                    ...it,
                    qty_diterima: Number.isFinite(qty) && qty >= 0 ? qty : 0,
                    catatan_penerimaan: cat
                };
            });

            // simpan foto bukti (shipment-level)
            const files = req.files || [];
            const bukti_filenames = files.map(f => f.filename);
            const bukti_urls = files.map(f => proofUrl(f.filename));

            await ref.update({
                status: 'diterima',
                keterangan: keterangan || dataCur.keterangan || '',
                data_barang: itemsBaru,
                bukti_penerimaan_filenames: (dataCur.bukti_penerimaan_filenames || []).concat(bukti_filenames),
                bukti_penerimaan_urls: (dataCur.bukti_penerimaan_urls || []).concat(bukti_urls),
                diterima_at: new Date(),
                diterima_oleh: req.user.uid
            });

            return res.redirect('/cabang/shipments?ok=confirmed');
        } catch (e) {
            console.error(e);
            return res.redirect('/cabang/shipments?err=' + encodeURIComponent('Gagal konfirmasi pengiriman'));
        }
    });

module.exports = router;
