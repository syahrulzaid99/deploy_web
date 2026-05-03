const express = require('express');
const router = express.Router();
const csrf = require('csurf');
const { randomUUID } = require('crypto');
const admin = require('firebase-admin');
const { generateSequentialCode, generateResiCode } = require('../utils/generateCode');

const { db } = require('../firebaseAdmin');
const { requireAuth, requireRole } = require('../middleware/auth');

const csrfProtection = csrf({ cookie: true });
router.use(express.urlencoded({ extended: false }));

// Helper to get users
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

// ====================== ADMIN: LIST ORDERS ======================
router.get('/admin/orders', requireAuth, requireRole(['admin']), csrfProtection, async (req, res) => {
    try {
        const snap = await db.collection('orders').orderBy('createdAt', 'desc').get();
        const orders = snap.docs.map(d => d.data());

        // usersMap (untuk tampil username cabang)
        const cabangIds = [...new Set(orders.map(o => o.cabang_id).filter(Boolean))];
        const usersMap = await getUsersMapByIds(cabangIds);

        res.render('admin/orders', {
            title: 'Pesanan Cabang',
            csrfToken: req.csrfToken(),
            user: req.user,
            profile: req.profile,
            orders,
            usersMap,
            ok: req.query.ok || null,
            err: req.query.err || null,
        });
    } catch (error) {
        console.error("Error loading orders:", error);
        res.render('admin/orders', {
            title: 'Pesanan Cabang',
            csrfToken: req.csrfToken(),
            user: req.user,
            profile: req.profile,
            orders: [],
            usersMap: {},
            ok: req.query.ok || null,
            err: "Gagal memuat daftar pesanan.",
        });
    }
});

// ====================== ADMIN: POLLING NEW ORDERS ======================
router.get('/admin/orders/check-new', requireAuth, requireRole(['admin']), async (req, res) => {
    try {
        const sinceStr = req.query.since;
        const lastCheck = sinceStr ? new Date(Number(sinceStr)) : new Date(Date.now() - 15000);

        const snap = await db.collection('orders')
            .where('createdAt', '>', lastCheck)
            .orderBy('createdAt', 'desc')
            .get();

        const pendingDocs = snap.docs.filter(d => d.data().status === 'pending');

        if (pendingDocs.length === 0) {
            return res.json({ hasNew: false, orders: [] });
        }

        const orders = pendingDocs.map(d => {
            const data = d.data();
            return {
                id: d.id,
                kode_order: data.kode_order,
                cabang_id: data.cabang_id,
                createdAt: data.createdAt ? (data.createdAt.toMillis ? data.createdAt.toMillis() : new Date(data.createdAt._seconds * 1000).getTime()) : null
            };
        });

        const cabangIds = [...new Set(orders.map(o => o.cabang_id).filter(Boolean))];
        const usersMap = await getUsersMapByIds(cabangIds);

        orders.forEach(o => {
            o.nama_cabang = usersMap[o.cabang_id]?.username || o.cabang_id;
        });

        return res.json({ hasNew: true, orders });
    } catch (e) {
        console.error("Error checking new orders:", e);
        return res.status(500).json({ error: 'server_error' });
    }
});

// ====================== ADMIN: UPDATE ORDER STATUS ======================
router.post('/admin/orders/:id', requireAuth, requireRole(['admin']), csrfProtection, async (req, res) => {
    try {
        const id = req.params.id;
        const { status, keterangan } = req.body;

        const ref = db.collection('orders').doc(id);
        const cur = await ref.get();

        if (!cur.exists) return res.redirect('/admin/orders?err=' + encodeURIComponent('Pesanan tidak ditemukan'));

        const currentData = cur.data();
        const newStatus = status ? status.trim() : currentData.status;

        // Jika status diubah jadi 'dikirim' dan sebelumnya belum 'dikirim'
        if (newStatus === 'dikirim' && currentData.status !== 'dikirim') {
            // 1. Generate Kode Pengiriman (Resi) dan SO Number
            const kode_pengiriman = await generateResiCode();
            const so_number = await generateSequentialCode('shipments', 'SO', 'so_number');

            const shipmentId = randomUUID();
            const items = (currentData.items || []).map(it => ({
                ...it,
                item_net_value: it.harga || 0, // Pastikan harga ikut terbawa
                item_tax: it.pajak || 0
            }));

            // Format keterangan khusus
            const orderKet = (keterangan && typeof keterangan === 'string') ? keterangan.trim() : (currentData.keterangan_admin || '');
            const finalKet = (orderKet ? orderKet + ' | ' : '') + 'Dari Pesanan: ' + currentData.kode_order;

            const shipmentDoc = {
                id: shipmentId,
                kode_pengiriman,
                po_number: currentData.kode_order, // PO dari pesanan asal
                so_number: so_number,              // SO Number sendiri (sequential)
                pengirim: req.user.uid, // Admin yang sedang login
                penerima: currentData.cabang_id,
                keterangan: finalKet,
                status: 'dikirim',
                data_barang: items,
                total_harga: currentData.total_harga || 0,
                jumlah_item: items.length,
                createdAt: new Date(),
                updatedAt: new Date(),
            };

            await db.collection('shipments').doc(shipmentId).set(shipmentDoc);

            // 3. Potong Stok Gudang Utama
            const batch = db.batch();
            let hasOp = false;
            for (const item of items) {
                const qty = Number(item.qty || item.jumlah || item._qty || 0);
                const pid = item.product_id || item.produk_id || item.productId;
                if (qty > 0 && pid) {
                    batch.update(db.collection('products').doc(pid), {
                        stok: admin.firestore.FieldValue.increment(-qty),
                        updatedAt: new Date()
                    });
                    hasOp = true;
                }
            }
            if (hasOp) await batch.commit().catch(e => console.error('Gagal potong stok:', e));

            // 4. Update status order dengan ref shipment
            await ref.update({
                status: newStatus,
                keterangan_admin: typeof keterangan === 'string' ? keterangan.trim() : (currentData.keterangan_admin || ''),
                shipment_id: shipmentId,
                kode_pengiriman: kode_pengiriman,
                updatedAt: new Date()
            });
        } else {
            // Update status biasa tanpa auto-create shipment
            await ref.update({
                status: newStatus,
                keterangan_admin: typeof keterangan === 'string' ? keterangan.trim() : (currentData.keterangan_admin || ''),
                updatedAt: new Date()
            });
        }

        return res.redirect('/admin/orders?ok=updated');
    } catch (e) {
        console.error(e);
        return res.redirect('/admin/orders?err=' + encodeURIComponent('Gagal update pesanan'));
    }
});

// ====================== ADMIN: DELETE ORDER ======================
router.post('/admin/orders/:id/delete', requireAuth, requireRole(['admin']), csrfProtection, async (req, res) => {
    try {
        const id = req.params.id;
        await db.collection('orders').doc(id).delete();
        return res.redirect('/admin/orders?ok=deleted');
    } catch (e) {
        console.error("Error deleting order:", e);
        return res.redirect('/admin/orders?err=' + encodeURIComponent('Gagal menghapus pesanan'));
    }
});

module.exports = router;
