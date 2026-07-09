const express = require('express');
const router = express.Router();
const { db } = require('../firebaseAdmin');
const { requireAuth, requireRole } = require('../middleware/auth');

// ====================== ADMIN: STOK CABANG ======================
router.get('/admin/cabang', requireAuth, requireRole(['admin']), async (req, res) => {
    try {
        // 1. Ambil semua user cabang
        const cabangSnap = await db.collection('users').where('role', '==', 'cabang').get();
        const cabangs = cabangSnap.docs.map(d => d.data()).sort((a, b) => (a.nama_cabang || '').localeCompare(b.nama_cabang || ''));

        // 2. Ambil semua branch_stocks
        const stockSnap = await db.collection('branch_stocks').get();
        const allStocks = stockSnap.docs.map(d => d.data());

        // 3. Ambil semua produk
        const prodSnap = await db.collection('products').get();
        const productsMap = {};
        prodSnap.docs.forEach(d => {
            const p = d.data();
            if (p.id) productsMap[p.id] = p;
        });

        // 4. Group stocks per cabang
        // stocksByCabang = { cabang_id: [ { product, stok } ] }
        const stocksByCabang = {};
        for (const s of allStocks) {
            const cid = s.cabang_id;
            const pid = s.product_id;
            if (!cid || !pid) continue;
            if (!stocksByCabang[cid]) stocksByCabang[cid] = [];
            const product = productsMap[pid] || null;
            stocksByCabang[cid].push({
                product_id: pid,
                stok: s.stok || 0,
                updatedAt: s.updatedAt || null,
                nama_produk: product ? (product.nama_produk || '-') : '-',
                sku: product ? (product.sku || '') : '',
                barcode: product ? (product.barcode || '') : '',
                satuan: product ? (product.satuan || '') : '',
                gambar_url: product ? (product.gambar_url || '') : '',
                divisi: product ? (product.divisi || '') : '',
            });
        }

        // Sort items per cabang by nama_produk
        for (const cid of Object.keys(stocksByCabang)) {
            stocksByCabang[cid].sort((a, b) => (a.nama_produk).localeCompare(b.nama_produk));
        }

        // 5. Hitung ringkasan per cabang
        const cabangSummaries = cabangs.map(c => {
            const stocks = stocksByCabang[c.id] || [];
            const totalItems = stocks.length;
            const totalStok = stocks.reduce((sum, s) => sum + s.stok, 0);
            return {
                ...c,
                stocks,
                totalItems,
                totalStok,
            };
        });

        // 6. Ambil jumlah pengiriman diterima per cabang
        const shipSnap = await db.collection('shipments').where('status', '==', 'diterima').get();
        const shipCountByCabang = {};
        shipSnap.docs.forEach(d => {
            const s = d.data();
            if (s.penerima) {
                shipCountByCabang[s.penerima] = (shipCountByCabang[s.penerima] || 0) + 1;
            }
        });

        // Attach ship counts
        for (const c of cabangSummaries) {
            c.totalShipmentsDiterima = shipCountByCabang[c.id] || 0;
        }

        // selectedCabang: jika ada query ?cabang=xxx
        const selectedCabangId = req.query.cabang || null;
        const selectedCabang = selectedCabangId
            ? cabangSummaries.find(c => c.id === selectedCabangId) || null
            : null;

        res.render('admin/cabang', {
            title: 'Stok Cabang',
            user: req.user,
            profile: req.profile,
            cabangSummaries,
            selectedCabang,
            selectedCabangId,
        });
    } catch (e) {
        console.error('Failed to load cabang stocks:', e);
        res.render('admin/cabang', {
            title: 'Stok Cabang',
            user: req.user,
            profile: req.profile,
            cabangSummaries: [],
            selectedCabang: null,
            selectedCabangId: null,
        });
    }
});

module.exports = router;
