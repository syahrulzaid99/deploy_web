const express = require('express');
const router = express.Router();
const { requireAuth, requireAuthApi } = require('../middleware/auth');
const { db } = require('../firebaseAdmin');

async function getUserCounts() {
    // coba pakai aggregate count() (cepat & hemat)
    try {
        const [totalSnap, adminSnap, cabangSnap] = await Promise.all([
            db.collection('users').count().get(),
            db.collection('users').where('role', '==', 'admin').count().get(),
            db.collection('users').where('role', '==', 'cabang').count().get(),
        ]);

        return {
            total: totalSnap.data().count || 0,
            admin: adminSnap.data().count || 0,
            cabang: cabangSnap.data().count || 0,
        };
    } catch (e) {
        // fallback (SDK lama): ambil ukuran snapshot
        const [totalSnap, adminSnap, cabangSnap] = await Promise.all([
            db.collection('users').get(),
            db.collection('users').where('role', '==', 'admin').get(),
            db.collection('users').where('role', '==', 'cabang').get(),
        ]);
        return {
            total: totalSnap.size,
            admin: adminSnap.size,
            cabang: cabangSnap.size,
        };
    }
}

router.get('/dashboard', requireAuth, async (req, res) => {
    try {
        let branchStocks = [];
        let counts = { total: 0, admin: 0, cabang: 0 };
        let salesStats = { pending: 0, approved: 0, rejected: 0 };
        let gudangStats = { readyToPack: 0, packed: 0, sent: 0 };

        const role = req.profile?.role;

        if (role === 'cabang') {
            // Jika cabang, ambil data stok cabang
            const stockSnap = await db.collection('branch_stocks').where('cabang_id', '==', req.user.uid).get();
            const stocksMap = {};
            stockSnap.docs.forEach(d => {
                const data = d.data();
                if (data.product_id) stocksMap[data.product_id] = data.stok || 0;
            });

            // Ambil detail produk
            const prodSnap = await db.collection('products').get();
            prodSnap.docs.forEach(d => {
                const p = d.data();
                if (stocksMap[p.id] !== undefined) {
                    branchStocks.push({
                        ...p,
                        stok_tersedia: stocksMap[p.id]
                    });
                }
            });
            // Urutkan berdasarkan nama produk
            branchStocks.sort((a, b) => (a.nama_produk || '').localeCompare(b.nama_produk || ''));
        } else if (role === 'sales') {
            // Sales: ambil statistik pesanan
            const snap = await db.collection('orders').get();
            snap.docs.forEach(d => {
                const st = (d.data().status || '').toLowerCase();
                if (st === 'pending') salesStats.pending++;
                if (st === 'approved_admin' || st === 'dipaket' || st === 'dikirim') salesStats.approved++;
                if (st === 'diterima' || st === 'selesai') salesStats.rejected++; // reuse field for completed
            });
        } else if (role === 'gudang') {
            // Gudang: ambil statistik
            const snap = await db.collection('orders').get();
            snap.docs.forEach(d => {
                const st = (d.data().status || '').toLowerCase();
                if (st === 'approved_admin') gudangStats.readyToPack++;
                else if (st === 'dipaket') gudangStats.packed++;
                else if (st === 'dikirim') gudangStats.sent++;
            });
        } else {
            // Admin: ambil counts
            counts = await getUserCounts();
        }

        res.render('admin/dashboard', {
            title: 'Dashboard',
            user: req.user,
            profile: req.profile,
            counts,
            branchStocks,
            salesStats,
            gudangStats,
        });
    } catch (e) {
        console.error('Failed to load dashboard:', e);
        res.render('admin/dashboard', {
            title: 'Dashboard',
            user: req.user,
            profile: req.profile,
            counts: { total: 0, admin: 0, cabang: 0 },
            branchStocks: [],
            salesStats: { pending: 0, approved: 0, rejected: 0 },
            gudangStats: { readyToPack: 0, packed: 0, sent: 0 },
        });
    }
});

// API untuk Flutter App
router.get('/api/v1/cabang/dashboard', requireAuthApi, async (req, res) => {
    try {
        const role = req.profile?.role;

        // Role-based dashboard API
        if (role === 'cabang') {
            const uid = req.user.uid;

            const shipSnap = await db.collection('shipments').where('penerima', '==', uid).get();
            let countStokMasuk = 0;
            shipSnap.docs.forEach(d => {
                const status = String(d.data().status || '').toLowerCase();
                if (status !== 'draft' && status !== 'ditolak') {
                    countStokMasuk++;
                }
            });

            const stockSnap = await db.collection('branch_stocks').where('cabang_id', '==', uid).get();
            const stocksMap = {};
            stockSnap.docs.forEach(d => {
                const data = d.data();
                if (data.product_id) stocksMap[data.product_id] = data.stok || 0;
            });

            const branchStocks = [];
            const prodSnap = await db.collection('products').get();
            prodSnap.docs.forEach(d => {
                const p = d.data();
                if (stocksMap[p.id] !== undefined) {
                    branchStocks.push({
                        id: p.id,
                        nama_produk: p.nama_produk || '-',
                        sku: p.sku || '',
                        barcode: p.barcode || '',
                        satuan: p.satuan || '',
                        stok_tersedia: stocksMap[p.id],
                        gambar_url: p.gambar_url || ''
                    });
                }
            });
            branchStocks.sort((a, b) => (a.nama_produk).localeCompare(b.nama_produk));

            return res.json({
                role: 'cabang',
                stok_masuk: countStokMasuk,
                stok_tersedia: branchStocks
            });
        }

        if (role === 'sales') {
            const snap = await db.collection('orders').get();
            let pending = 0, approved = 0, rejected = 0;
            snap.docs.forEach(d => {
                const st = (d.data().status || '').toLowerCase();
                if (st === 'pending') pending++;
                else if (st === 'approved_sales') approved++;
                else if (st === 'rejected') rejected++;
            });

            return res.json({ role: 'sales', stats: { pending, approved, rejected } });
        }

        if (role === 'gudang') {
            const snap = await db.collection('orders').get();
            let readyToPack = 0, packed = 0, sent = 0;
            snap.docs.forEach(d => {
                const st = (d.data().status || '').toLowerCase();
                if (st === 'approved_admin') readyToPack++;
                else if (st === 'dipaket') packed++;
                else if (st === 'dikirim') sent++;
            });

            return res.json({ role: 'gudang', stats: { readyToPack, packed, sent } });
        }

        return res.json({ role: role || 'unknown' });
    } catch (e) {
        console.error('API dashboard error:', e);
        return res.status(500).json({ error: 'server_error' });
    }
});

module.exports = router;
