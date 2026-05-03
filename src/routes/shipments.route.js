const express = require('express');
const router = express.Router();
const csrf = require('csurf');
const { randomUUID } = require('crypto');

const { db } = require('../firebaseAdmin');
const { requireAuth, requireAuthApi, requireRole } = require('../middleware/auth');
const { generateSequentialCode, generateResiCode } = require('../utils/generateCode');

const csrfProtection = csrf({ cookie: true });
router.use(express.urlencoded({ extended: false }));

const multer = require('multer');
const path = require('path');
const admin = require('firebase-admin');
const { profile } = require('console');

const proofStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, path.join(__dirname, '..', '..', 'uploads', 'shipments_proofs'));
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname || '').toLowerCase();
        cb(null, Date.now() + '-' + Math.random().toString(36).slice(2, 8) + ext);
    },
});


const uploadProofs = multer({ storage: proofStorage });

// Helpers
async function getCabangUsersMap() {
    const snap = await db.collection('users').where('role', '==', 'cabang').get();
    const list = snap.docs.map(d => d.data());
    const map = {};
    for (const u of list) map[u.id] = u;
    return { list, map };
}
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

// ====================== ADMIN: LIST & CREATE ======================
router.get('/admin/shipments', requireAuth, requireRole(['admin']), csrfProtection, async (req, res) => {
    const snap = await db.collection('shipments').orderBy('kode_pengiriman').get();
    const shipments = snap.docs.map(d => d.data());

    // cabang (tanpa orderBy agar tak perlu index komposit)
    const cabangSnap = await db.collection('users').where('role', '==', 'cabang').get();
    const cabangs = cabangSnap.docs.map(d => d.data()).sort((a, b) => (a.username || '').localeCompare(b.username || ''));

    // usersMap (untuk tampil username)
    const semuaUserIds = [...new Set([
        ...shipments.map(s => s.pengirim).filter(Boolean),
        ...shipments.map(s => s.penerima).filter(Boolean),
    ])];
    async function getUsersMapByIds(ids = []) {
        if (!ids.length) return {};
        const chunks = []; for (let i = 0; i < ids.length; i += 10) chunks.push(ids.slice(i, i + 10));
        const map = {};
        for (const chunk of chunks) {
            const snaps = await Promise.all(chunk.map(id => db.collection('users').doc(id).get()));
            for (const s of snaps) if (s.exists) map[s.id] = s.data();
        }
        return map;
    }
    const usersMap = await getUsersMapByIds(semuaUserIds);

    // productsMap (id -> produk) untuk render detail item
    const prodSnap = await db.collection('products').orderBy('sku').get();
    const products = prodSnap.docs.map(d => d.data());
    const productsMap = {};
    for (const p of products) productsMap[p.id] = p;

    res.render('admin/shipments', {
        title: 'Pengiriman',
        csrfToken: req.csrfToken(),
        user: req.user, profile: req.profile,
        shipments, cabangs, usersMap,
        products,         // untuk dropdown di modal
        productsMap,      // untuk render detail di tabel
        ok: req.query.ok || null, err: req.query.err || null,
    });
});

router.post('/admin/shipments', requireAuth, requireRole(['admin']), csrfProtection, async (req, res) => {
    try {
        const { penerima, status, keterangan, data_barang_json, po_number, so_number } = req.body;
        if (!penerima || !data_barang_json) {
            return res.redirect('/admin/shipments?err=' + encodeURIComponent('Field wajib belum lengkap'));
        }

        // === generate kode otomatis (Resi & SO) ===
        const kode_pengiriman = await generateResiCode();
        let final_so_number = (so_number || '').trim();
        if (!final_so_number) {
            final_so_number = await generateSequentialCode('shipments', 'SO', 'so_number');
        }

        const id = require('crypto').randomUUID();
        const pengirim = req.user.uid;

        let data_barang;
        try {
            data_barang = JSON.parse(data_barang_json);
        } catch (e) {
            return res.redirect('/admin/shipments?err=Format data_barang tidak valid');
        }

        // Target snapshot harga dan info detail
        const productsMap = {};
        const prodSnap = await db.collection('products').get();
        prodSnap.docs.forEach(d => { productsMap[d.id] = d.data(); });

        const enriched_data_barang = data_barang.map(item => {
            const p = productsMap[item.product_id] || {};
            return {
                ...item,
                item_cost: p.harga_modal || 0,
                item_net_value: p.harga_jual || 0,
                item_tax: p.pajak || 0,
                divisi: p.divisi || '',
                sku: p.sku || item.sku || '',
                barcode: p.barcode || item.barcode || '',
                nama_produk: p.nama_produk || item.nama_produk || '',
                satuan: p.satuan || item.satuan || ''
            };
        });

        const doc = {
            id,
            kode_pengiriman,
            po_number: (po_number || '').trim(),
            so_number: final_so_number,
            pengirim,
            penerima,
            data_barang: enriched_data_barang,
            status: status || 'draft',
            keterangan: keterangan || '',
            createdAt: new Date(),
            updatedAt: new Date()
        };

        await db.collection('shipments').doc(id).set(doc);

        // Deduct inventory stock
        const batch = db.batch();
        let hasOp = false;
        for (const item of enriched_data_barang) {
            const qty = Number(item.qty || item.jumlah || item._qty || 0);
            if (qty > 0 && item.product_id) {
                batch.update(db.collection('products').doc(item.product_id), {
                    stok: admin.firestore.FieldValue.increment(-qty),
                    updatedAt: new Date()
                });
                hasOp = true;
            }
        }
        if (hasOp) await batch.commit().catch(e => console.error('Failed to deduct stock:', e));

        return res.redirect('/admin/shipments?ok=created');
    } catch (e) {
        console.error(e);
        return res.redirect('/admin/shipments?err=' + encodeURIComponent('Gagal membuat pengiriman'));
    }
});

// (opsional) Ubah status/keterangan shipment oleh admin
router.post('/admin/shipments/:id', requireAuth, requireRole(['admin']), csrfProtection, async (req, res) => {
    try {
        const id = req.params.id;
        const { status, keterangan } = req.body;
        const ref = db.collection('shipments').doc(id);
        const cur = await ref.get();
        if (!cur.exists) return res.redirect('/admin/shipments?err=' + encodeURIComponent('Pengiriman tidak ditemukan'));

        await ref.update({
            status: status ? status.trim() : cur.data().status,
            keterangan: typeof keterangan === 'string' ? keterangan.trim() : (cur.data().keterangan || ''),
        });

        return res.redirect('/admin/shipments?ok=updated');
    } catch (e) {
        console.error(e);
        return res.redirect('/admin/shipments?err=' + encodeURIComponent('Gagal update pengiriman'));
    }
});

// (opsional) Hapus shipment
router.post('/admin/shipments/:id/delete', requireAuth, requireRole(['admin']), csrfProtection, async (req, res) => {
    try {
        const docRef = db.collection('shipments').doc(req.params.id);
        const docSnap = await docRef.get();
        if (docSnap.exists) {
            const dt = docSnap.data();
            if (dt.status !== 'ditolak') {
                // Restore inventory stock only if it hasn't been rejected (which already restores it)
                // Actually if it's draft, terkirim, diterima, the origin still sent it out physically,
                // deleting it means invalidating the shipment, so restore to central.
                const items = Array.isArray(dt.data_barang) ? dt.data_barang : [];
                const batch = db.batch();
                let hasOp = false;
                for (const item of items) {
                    const qty = Number(item.qty || item.jumlah || item._qty || 0);
                    if (qty > 0 && item.product_id) {
                        batch.update(db.collection('products').doc(item.product_id), {
                            stok: admin.firestore.FieldValue.increment(qty),
                            updatedAt: new Date()
                        });
                        hasOp = true;
                    }
                }
                if (hasOp) await batch.commit().catch(e => console.error('Failed to restore stock:', e));
            }
            await docRef.delete();
        }
        return res.redirect('/admin/shipments?ok=deleted');
    } catch (e) {
        console.error(e);
        return res.redirect('/admin/shipments?err=' + encodeURIComponent('Gagal menghapus pengiriman'));
    }
});

router.get(
    '/admin/shipments/:id/resi',
    requireAuth,
    requireRole(['admin']),
    async (req, res) => {
        const id = req.params.id;
        const snap = await db.collection('shipments').doc(id).get();
        if (!snap.exists) return res.status(404).send('Pengiriman tidak ditemukan');

        const s = snap.data();

        // --- ambil data pengirim & penerima (seperti kemarin)
        const [pengirimDoc, penerimaDoc] = await Promise.all([
            s.pengirim ? db.collection('users').doc(s.pengirim).get() : null,
            s.penerima ? db.collection('users').doc(s.penerima).get() : null,
        ]);

        // --- ambil items dari shipment
        const items = Array.isArray(s.data_barang) ? s.data_barang : [];

        // kumpulkan kandidat productId dari item
        const candIds = [];
        for (const it of items) {
            const ids = [
                it.product_id,
                it.produk_id,
                it.productId,
                it.id_produk,
                it.product,
                it.pid,
            ].filter(Boolean);
            for (const cid of ids) {
                const pid = String(cid).trim();
                if (pid) candIds.push(pid);
            }
        }
        const uniqIds = [...new Set(candIds)];

        // ambil produk dari Firestore
        const productSnaps = await Promise.all(
            uniqIds.map(pid => db.collection('products').doc(pid).get())
        );
        const productsById = {};
        for (const ps of productSnaps) {
            if (ps.exists) productsById[ps.id] = ps.data();
        }

        // helper qty
        const getQty = (it = {}) => {
            if (it.qty != null) return Number(it.qty);
            if (it.qty_in != null) return Number(it.qty_in);
            if (it.qty_out != null) return Number(it.qty_out);
            if (it.jumlah != null) return Number(it.jumlah);
            return 0;
        };

        // bentuk items yang sudah ada nama & barcode
        const itemsEnriched = items.map(it => {
            let prod = null;
            const ids = [
                it.product_id,
                it.produk_id,
                it.productId,
                it.id_produk,
                it.product,
                it.pid,
            ].filter(Boolean);
            for (const cid of ids) {
                const pid = String(cid).trim();
                if (pid && productsById[pid]) {
                    prod = productsById[pid];
                    break;
                }
            }

            const namaProduk =
                it.nama_produk ||
                (prod && (prod.nama_produk || prod.name)) ||
                '-';

            const barcode =
                it.barcode ||
                (prod && prod.barcode) ||
                '';

            const qty = getQty(it);

            return {
                ...it,
                _nama_produk: namaProduk,
                _barcode: barcode,
                _qty: Number.isFinite(qty) ? qty : 0,
            };
        });

        res.render('admin/shipment-resi', {
            layout: false,                // tanpa base.ejs
            title: 'Resi Pengiriman',
            user: req.user,
            profile: req.profile,
            shipment: s,
            pengirim: pengirimDoc ? pengirimDoc.data() : null,
            penerima: penerimaDoc ? penerimaDoc.data() : null,
            items: itemsEnriched,         // 🔴 kirim ke view
        });
    }
);

// GET detail shipment untuk Flutter: berdasarkan kode_pengiriman
router.get(
    '/api/v1/cabang/shipments/:kode_pengiriman',
    requireAuthApi,
    requireRole(['cabang']),
    async (req, res) => {
        try {
            const kode = req.params.kode_pengiriman;

            const snap = await db.collection('shipments')
                .where('kode_pengiriman', '==', kode)
                .limit(1)
                .get();

            if (snap.empty) return res.status(404).json({ error: 'not_found' });

            const doc = snap.docs[0];
            const s = doc.data();

            // kunci: resi harus milik cabang yang login
            if (s.penerima !== req.user.uid) {
                return res.status(403).json({ error: 'forbidden_shipment_not_yours' });
            }

            // ambil user pengirim & penerima
            const [pengirimDoc, penerimaDoc] = await Promise.all([
                s.pengirim ? db.collection('users').doc(s.pengirim).get() : null,
                s.penerima ? db.collection('users').doc(s.penerima).get() : null,
            ]);
            const pengirimU = pengirimDoc?.exists ? pengirimDoc.data() : null;
            const penerimaU = penerimaDoc?.exists ? penerimaDoc.data() : null;

            const pengirimNama = pengirimU?.nama_cabang || pengirimU?.username || pengirimU?.nama || null;
            const penerimaNama = penerimaU?.nama_cabang || penerimaU?.username || penerimaU?.nama || null;

            // load semua produk (paling simpel & robust)
            const prodSnap = await db.collection('products').orderBy('sku').get();
            const products = prodSnap.docs.map(d => d.data());

            const productsById = {};
            const productsBySku = {};
            const productsByBarcode = {};

            for (const p of products) {
                if (p?.id) productsById[String(p.id)] = p;
                const sku = (p?.sku ? String(p.sku).trim().toLowerCase() : '');
                if (sku) productsBySku[sku] = p;
                const bc = (p?.barcode ? String(p.barcode).trim() : '');
                if (bc) productsByBarcode[bc] = p;
            }

            const getQty = (it = {}) => {
                if (it.qty != null) return Number(it.qty);
                if (it.jumlah != null) return Number(it.jumlah);
                if (it.quantity != null) return Number(it.quantity);
                if (it.qty_in != null) return Number(it.qty_in);
                if (it.qty_out != null) return Number(it.qty_out);
                return 0;
            };

            const resolveProduct = (it = {}) => {
                const candIds = [
                    it.product_id, it.produk_id, it.productId, it.id, it.product, it.pid, it.id_produk
                ].filter(Boolean);

                for (const cid of candIds) {
                    const pid = String(cid).trim();
                    if (pid && productsById[pid]) return productsById[pid];

                    const pidAsSku = String(cid).trim().toLowerCase();
                    if (pidAsSku && productsBySku[pidAsSku]) return productsBySku[pidAsSku];
                }

                const sku = it.sku ? String(it.sku).trim().toLowerCase() : '';
                if (sku && productsBySku[sku]) return productsBySku[sku];

                const bc = it.barcode ? String(it.barcode).trim() : '';
                if (bc && productsByBarcode[bc]) return productsByBarcode[bc];

                return null;
            };

            let total_harga = 0;
            const itemsRaw = Array.isArray(s.data_barang) ? s.data_barang : [];
            const items = itemsRaw.map((it) => {
                const p = resolveProduct(it);
                const qty = getQty(it);
                const harga = Number(it.item_net_value || it.harga || p?.harga_jual || 0);
                total_harga += (qty * harga);

                return {
                    // konsisten untuk android
                    nama_produk: it.nama_produk || p?.nama_produk || '-',
                    barcode: it.barcode || p?.barcode || '',
                    sku: it.sku || p?.sku || '',
                    satuan: it.satuan || p?.satuan || '',
                    qty: Number.isFinite(qty) ? qty : 0,
                    harga: harga,
                    gambar_url: it.gambar_url || it.imageUrl || it.image_url || p?.gambar_url || '',
                };
            });

            return res.json({
                id: doc.id,
                kode_pengiriman: s.kode_pengiriman,
                status: s.status || 'draft',
                tanggal_kirim: s.createdAt || s.created_at || s.tanggal_kirim || null,

                pengirim: pengirimNama,     // ✅ nama_cabang
                penerima: penerimaNama,     // ✅ nama_cabang

                alamat_penerima_jalan: penerimaU?.jalan || '',
                alamat_penerima_kota: penerimaU?.kota || '',
                alamat_penerima_provinsi: penerimaU?.provinsi || '',

                items, // ✅ sudah ada nama_produk & barcode & gambar_url & harga
                total_harga,
                bukti_penerimaan_urls: s.bukti_penerimaan_urls || [],
            });
        } catch (e) {
            console.error(e);
            return res.status(500).json({ error: 'server_error' });
        }
    }
);

// POST bukti penerimaan (foto) dari Flutter
router.post('/api/v1/cabang/shipments/:kode_pengiriman/proofs',
    requireAuthApi,
    requireRole(['cabang']),
    uploadProofs.array('photos', 5),
    async (req, res) => {
        try {
            const kode = req.params.kode_pengiriman;

            const snap = await db.collection('shipments')
                .where('kode_pengiriman', '==', kode)
                .limit(1)
                .get();

            if (snap.empty) return res.status(404).json({ error: 'not_found' });

            const doc = snap.docs[0];
            const s = doc.data();

            if (s.penerima !== req.user.uid) {
                return res.status(403).json({ error: 'forbidden_shipment_not_yours' });
            }

            const baseUrl = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
            const files = req.files || [];
            const urls = files.map(f => `${baseUrl}/uploads/shipments_proofs/${f.filename}`);

            await doc.ref.update({
                status: 'diterima',
                diterima_at: new Date(),
                diterima_oleh: req.user.uid,
                bukti_penerimaan_urls: admin.firestore.FieldValue.arrayUnion(...urls),
            });

            return res.json({ ok: true, added_urls: urls });
        } catch (e) {
            console.error(e);
            return res.status(500).json({ error: 'server_error' });
        }
    }
);

router.post(
    '/api/v1/cabang/shipments/:kode_pengiriman/confirm',
    requireAuthApi,
    requireRole(['cabang']),
    uploadProofs.array('photos', 5),
    async (req, res) => {
        try {
            const kode = req.params.kode_pengiriman;

            const snap = await db.collection('shipments')
                .where('kode_pengiriman', '==', kode)
                .limit(1)
                .get();

            if (snap.empty) return res.status(404).json({ error: 'not_found' });

            const doc = snap.docs[0];
            const s = doc.data();

            // hanya cabang penerima resi tsb
            if (s.penerima !== req.user.uid) {
                return res.status(403).json({ error: 'forbidden_shipment_not_yours' });
            }

            // optional: jangan boleh konfirmasi ulang
            const st = String(s.status || '').toLowerCase();
            if (['diterima', 'ditolak'].includes(st)) {
                return res.status(409).json({ error: 'already_confirmed' });
            }

            let aksi = req.body.aksi;
            if (Array.isArray(aksi)) aksi = aksi[aksi.length - 1];
            aksi = String(aksi || '').toLowerCase();

            const keterangan = String(req.body.keterangan || '').trim();
            if (!['diterima', 'ditolak'].includes(aksi)) {
                return res.status(400).json({ error: 'invalid_aksi' });
            }

            // foto bukti
            const baseUrl = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
            const files = req.files || [];
            const urls = files.map((f) => `${baseUrl}/uploads/shipments_proofs/${f.filename}`);

            // items_json: [{idx, qty_diterima, catatan}]
            let itemsPatch = [];
            if (req.body.items_json) {
                try {
                    itemsPatch = JSON.parse(req.body.items_json);
                    if (!Array.isArray(itemsPatch)) itemsPatch = [];
                } catch (_) {
                    return res.status(400).json({ error: 'invalid_items_json' });
                }
            }

            // update data_barang (index-based)
            const curItems = Array.isArray(s.data_barang) ? s.data_barang : [];
            const byIdx = new Map();
            for (const it of itemsPatch) {
                const idx = Number(it?.idx);
                if (Number.isFinite(idx) && idx >= 0) byIdx.set(idx, it);
            }

            const nextItems = curItems.map((it, idx) => {
                const p = byIdx.get(idx);
                if (!p) return it;
                const qty = Number(p.qty_diterima);
                const cat = String(p.catatan || '').trim();
                return {
                    ...it,
                    qty_diterima: Number.isFinite(qty) && qty >= 0 ? qty : 0,
                    catatan_penerimaan: cat,
                };
            });

            // 🔥 FIX: Base update object (tanpa bukti_penerimaan_urls dulu)
            const updateData = {
                status: aksi === 'ditolak' ? 'ditolak' : 'diterima',
                keterangan,
                data_barang: nextItems,
                [`${aksi}_at`]: new Date(),
                [`${aksi}_oleh`]: req.user.uid,
            };

            // 🔥 FIX: Hanya gunakan arrayUnion jika ada foto
            if (urls.length > 0) {
                updateData.bukti_penerimaan_urls = admin.firestore.FieldValue.arrayUnion(...urls);
            }

            await doc.ref.update(updateData);

            return res.json({
                ok: true,
                status: aksi,
                photos_uploaded: urls.length
            });
        } catch (e) {
            console.error('❌ Confirm error:', e);
            return res.status(500).json({ error: 'server_error' });
        }
    }
);

// ====================== API: LIST SHIPMENTS FOR CABANG ======================
router.get(
    '/api/v1/cabang/shipments',
    requireAuthApi,
    requireRole(['cabang']),
    async (req, res) => {
        try {
            const snap = await db.collection('shipments')
                .where('penerima', '==', req.user.uid)
                .get();

            const shipmentsAll = snap.docs.map(d => d.data());
            // exclude draft
            const shipments = shipmentsAll.filter(s => String(s.status || '').toLowerCase() !== 'draft');

            // load products for enrichment
            const prodSnap = await db.collection('products').get();
            const productsById = {};
            const productsBySku = {};
            const productsByBarcode = {};
            for (const d of prodSnap.docs) {
                const p = d.data();
                if (p?.id) productsById[String(p.id)] = p;
                const sku = (p?.sku ? String(p.sku).trim().toLowerCase() : '');
                if (sku) productsBySku[sku] = p;
                const bc = (p?.barcode ? String(p.barcode).trim() : '');
                if (bc) productsByBarcode[bc] = p;
            }

            const getQty = (it = {}) => {
                if (it.qty != null) return Number(it.qty);
                if (it.jumlah != null) return Number(it.jumlah);
                if (it.quantity != null) return Number(it.quantity);
                return 0;
            };

            const resolveProduct = (it = {}) => {
                const candIds = [
                    it.product_id, it.produk_id, it.productId, it.id, it.product, it.pid, it.id_produk
                ].filter(Boolean);
                for (const cid of candIds) {
                    const pid = String(cid).trim();
                    if (pid && productsById[pid]) return productsById[pid];
                    const pidAsSku = String(cid).trim().toLowerCase();
                    if (pidAsSku && productsBySku[pidAsSku]) return productsBySku[pidAsSku];
                }
                const sku = it.sku ? String(it.sku).trim().toLowerCase() : '';
                if (sku && productsBySku[sku]) return productsBySku[sku];
                const bc = it.barcode ? String(it.barcode).trim() : '';
                if (bc && productsByBarcode[bc]) return productsByBarcode[bc];
                return null;
            };

            // load user names
            const userIds = [...new Set(shipments.map(s => s.pengirim).filter(Boolean))];
            const usersMap = await getUsersMapByIds(userIds);

            const result = shipments.map(s => {
                const itemsRaw = Array.isArray(s.data_barang) ? s.data_barang : [];
                let total_harga = 0;
                const items = itemsRaw.map(it => {
                    const p = resolveProduct(it);
                    const qty = getQty(it);
                    const harga = Number(it.item_net_value || it.harga || p?.harga_jual || 0);
                    total_harga += qty * harga;
                    return {
                        nama_produk: it.nama_produk || p?.nama_produk || '-',
                        qty: Number.isFinite(qty) ? qty : 0,
                        harga,
                        satuan: it.satuan || p?.satuan || '',
                    };
                });

                const pengirimU = usersMap[s.pengirim] || null;
                const pengirimNama = pengirimU?.nama_cabang || pengirimU?.username || pengirimU?.nama || '-';

                return {
                    id: s.id,
                    kode_pengiriman: s.kode_pengiriman,
                    status: s.status || 'draft',
                    pengirim: pengirimNama,
                    total_harga,
                    jumlah_item: items.length,
                    items,
                    tanggal: s.createdAt || s.created_at || s.tanggal_kirim || null,
                    diterima_at: s.diterima_at || null,
                    ditolak_at: s.ditolak_at || null,
                };
            });

            // sort: terbaru dulu
            result.sort((a, b) => {
                const da = a.tanggal ? new Date(a.tanggal._seconds ? a.tanggal._seconds * 1000 : a.tanggal) : new Date(0);
                const db2 = b.tanggal ? new Date(b.tanggal._seconds ? b.tanggal._seconds * 1000 : b.tanggal) : new Date(0);
                return db2 - da;
            });

            return res.json({ shipments: result });
        } catch (e) {
            console.error(e);
            return res.status(500).json({ error: 'server_error' });
        }
    }
);

// ====================== API: LIST PRODUCTS ======================
router.get(
    '/api/v1/cabang/products',
    requireAuthApi,
    requireRole(['cabang']),
    async (req, res) => {
        try {
            const snap = await db.collection('products').orderBy('sku').get();
            const products = snap.docs.map(d => {
                const p = d.data();
                return {
                    id: p.id,
                    sku: p.sku || '',
                    barcode: p.barcode || '',
                    nama_produk: p.nama_produk || '',
                    satuan: p.satuan || '',
                    harga_jual: p.harga_jual || 0,
                    stok: p.stok || 0,
                    gambar_url: p.gambar_url || '',
                    divisi: p.divisi || '',
                };
            });
            return res.json({ products });
        } catch (e) {
            console.error(e);
            return res.status(500).json({ error: 'server_error' });
        }
    }
);

// ====================== API: CREATE ORDER ======================
router.post(
    '/api/v1/cabang/orders',
    requireAuthApi,
    requireRole(['cabang']),
    express.json(),
    async (req, res) => {
        try {
            const { items, keterangan } = req.body || {};

            if (!Array.isArray(items) || items.length === 0) {
                return res.status(400).json({ error: 'items_required' });
            }

            // validate items
            for (const it of items) {
                if (!it.product_id || !it.qty || it.qty <= 0) {
                    return res.status(400).json({ error: 'invalid_item', detail: 'Setiap item harus punya product_id dan qty > 0' });
                }
            }

            // enrich items with product data
            const prodSnap = await db.collection('products').get();
            const productsById = {};
            for (const d of prodSnap.docs) {
                const p = d.data();
                if (p?.id) productsById[String(p.id)] = p;
            }

            let total_harga = 0;
            const enrichedItems = items.map(it => {
                const p = productsById[it.product_id] || {};
                const qty = Number(it.qty);
                const harga = p.harga_jual || 0;
                total_harga += qty * harga;
                return {
                    product_id: it.product_id,
                    nama_produk: p.nama_produk || '-',
                    sku: p.sku || '',
                    barcode: p.barcode || '',
                    satuan: p.satuan || '',
                    qty,
                    harga,
                    subtotal: qty * harga,
                };
            });

            // generate order code sequentially
            const kode_order = await generateSequentialCode('orders', 'PO', 'kode_order');

            const id = randomUUID();
            const doc = {
                id,
                kode_order,
                cabang_id: req.user.uid,
                cabang_username: req.user.username,
                items: enrichedItems,
                total_harga,
                keterangan: String(keterangan || '').trim(),
                status: 'pending',
                createdAt: new Date(),
                updatedAt: new Date(),
            };

            await db.collection('orders').doc(id).set(doc);

            return res.json({ ok: true, kode_order, id });
        } catch (e) {
            console.error('❌ Create order error:', e);
            return res.status(500).json({ error: 'server_error' });
        }
    }
);

// ====================== API: LIST ORDERS FOR CABANG ======================
router.get(
    '/api/v1/cabang/orders',
    requireAuthApi,
    requireRole(['cabang']),
    async (req, res) => {
        try {
            const snap = await db.collection('orders')
                .where('cabang_id', '==', req.user.uid)
                .get();

            const orders = snap.docs.map(d => {
                const o = d.data();
                return {
                    id: o.id,
                    kode_order: o.kode_order,
                    status: o.status || 'pending',
                    total_harga: o.total_harga || 0,
                    jumlah_item: Array.isArray(o.items) ? o.items.length : 0,
                    items: o.items || [],
                    keterangan: o.keterangan || '',
                    createdAt: o.createdAt || null,
                };
            });

            // sort terbaru dulu
            orders.sort((a, b) => {
                const da = a.createdAt ? new Date(a.createdAt._seconds ? a.createdAt._seconds * 1000 : a.createdAt) : new Date(0);
                const db2 = b.createdAt ? new Date(b.createdAt._seconds ? b.createdAt._seconds * 1000 : b.createdAt) : new Date(0);
                return db2 - da;
            });

            return res.json({ orders });
        } catch (e) {
            console.error(e);
            return res.status(500).json({ error: 'server_error' });
        }
    }
);

module.exports = router;
