const express = require('express');
const router = express.Router();
const csrf = require('csurf');
const { randomUUID } = require('crypto');
const { generateSequentialCode } = require('../utils/generateCode');

const { db } = require('../firebaseAdmin');
const { requireAuth, requireRole } = require('../middleware/auth');

const csrfProtection = csrf({ cookie: true });
router.use(express.urlencoded({ extended: false }));

// ====================== CABANG: LIST ORDERS ======================
router.get('/cabang/orders', requireAuth, requireRole(['cabang']), csrfProtection, async (req, res) => {
    try {
        const snap = await db.collection('orders')
            .where('cabang_id', '==', req.user.uid)
            .get();

        const orders = snap.docs.map(d => d.data());
        
        // sort by createdAt desc
        orders.sort((a, b) => {
            const da = a.createdAt ? new Date(a.createdAt._seconds ? a.createdAt._seconds * 1000 : a.createdAt) : new Date(0);
            const db2 = b.createdAt ? new Date(b.createdAt._seconds ? b.createdAt._seconds * 1000 : b.createdAt) : new Date(0);
            return db2 - da;
        });

        // Ambil data products untuk dropdown modal "Buat Pesanan"
        const prodSnap = await db.collection('products').orderBy('sku').get();
        const products = prodSnap.docs.map(d => d.data());

        res.render('cabang/orders', {
            title: 'Pesanan Saya',
            csrfToken: req.csrfToken(),
            user: req.user, 
            profile: req.profile,
            orders, 
            products,
            ok: req.query.ok || null, 
            err: req.query.err || null,
        });
    } catch (error) {
        console.error("Error loading cabang orders:", error);
        res.render('cabang/orders', {
            title: 'Pesanan Saya',
            csrfToken: req.csrfToken(),
            user: req.user, 
            profile: req.profile,
            orders: [], 
            products: [],
            ok: req.query.ok || null, 
            err: "Gagal memuat daftar pesanan.",
        });
    }
});

// ====================== CABANG: CREATE ORDER ======================
router.post('/cabang/orders', requireAuth, requireRole(['cabang']), csrfProtection, async (req, res) => {
    try {
        const { keterangan, data_barang_json } = req.body;
        
        if (!data_barang_json) {
            return res.redirect('/cabang/orders?err=' + encodeURIComponent('Data barang tidak valid'));
        }

        let items;
        try {
            items = JSON.parse(data_barang_json);
        } catch (e) {
            return res.redirect('/cabang/orders?err=' + encodeURIComponent('Format data barang salah'));
        }

        if (!Array.isArray(items) || items.length === 0) {
            return res.redirect('/cabang/orders?err=' + encodeURIComponent('Minimal pilih 1 produk'));
        }

        for (const it of items) {
            if (!it.product_id || !it.qty || it.qty <= 0) {
                return res.redirect('/cabang/orders?err=' + encodeURIComponent('Kuantitas item harus lebih dari 0'));
            }
        }

        // enrich items with product data
        const prodSnap = await db.collection('products').get();
        const productsById = {};
        for (const d of prodSnap.docs) {
            const p = d.data();
            if (p && p.id) productsById[String(p.id)] = p;
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
                gambar_url: p.gambar_url || ''
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

        return res.redirect('/cabang/orders?ok=created');
    } catch (e) {
        console.error('❌ Create order web error:', e);
        return res.redirect('/cabang/orders?err=' + encodeURIComponent('Gagal membuat pesanan'));
    }
});

module.exports = router;
