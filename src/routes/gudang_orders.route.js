const express = require('express');
const router = express.Router();
const { csrfProtection } = require('../middleware/csrf');
const { randomUUID } = require('crypto');
const admin = require('firebase-admin');

const { db } = require('../firebaseAdmin');
const { requireAuth, requireRole } = require('../middleware/auth');
const { generateSequentialCode, generateResiCode } = require('../utils/generateCode');

router.use(express.urlencoded({ extended: false }));

// Helpers
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

// ====================== GUDANG: LIST ORDERS SIAP DIKEMAS ======================
router.get('/gudang/orders', requireAuth, requireRole(['gudang']), csrfProtection, async (req, res) => {
    try {
        const snap = await db.collection('orders').orderBy('createdAt', 'desc').get();
        const allOrders = snap.docs.map(d => d.data());

        // Gudang lihat: approved_admin (siap dikemas), dipaket (sedang diproses), dikirim (dalam pengiriman)
        const orders = allOrders.filter(o => {
            const st = (o.status || '').toLowerCase();
            return ['approved_admin', 'dipaket', 'dikirim'].includes(st);
        });

        const cabangIds = [...new Set(orders.map(o => o.cabang_id).filter(Boolean))];
        const usersMap = await getUsersMapByIds(cabangIds);

        res.render('gudang/orders', {
            title: 'Pengemasan',
            csrfToken: req.csrfToken(),
            user: req.user,
            profile: req.profile,
            orders,
            usersMap,
            ok: req.query.ok || null,
            err: req.query.err || null,
        });
    } catch (error) {
        console.error("Error loading gudang orders:", error);
        res.render('gudang/orders', {
            title: 'Pengemasan',
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

// ====================== GUDANG: DETAIL ORDER ======================
router.get('/gudang/orders/:id', requireAuth, requireRole(['gudang']), csrfProtection, async (req, res) => {
    try {
        const id = req.params.id;
        const doc = await db.collection('orders').doc(id).get();

        if (!doc.exists) {
            return res.redirect('/gudang/orders?err=' + encodeURIComponent('Pesanan tidak ditemukan'));
        }

        const order = doc.data();
        const cabangDoc = order.cabang_id ? await db.collection('users').doc(order.cabang_id).get() : null;
        const cabangInfo = cabangDoc?.exists ? cabangDoc.data() : null;

        res.render('gudang/detail', {
            title: 'Detail Pesanan',
            csrfToken: req.csrfToken(),
            user: req.user,
            profile: req.profile,
            order,
            cabangInfo,
            ok: req.query.ok || null,
            err: req.query.err || null,
        });
    } catch (error) {
        console.error("Error loading gudang order detail:", error);
        return res.redirect('/gudang/orders?err=' + encodeURIComponent('Gagal memuat detail pesanan'));
    }
});

// ====================== GUDANG: PACK ORDER ======================
router.post('/gudang/orders/:id/pack', requireAuth, requireRole(['gudang']), csrfProtection, async (req, res) => {
    try {
        const id = req.params.id;
        const ref = db.collection('orders').doc(id);
        const cur = await ref.get();

        if (!cur.exists) {
            return res.redirect('/gudang/orders?err=' + encodeURIComponent('Pesanan tidak ditemukan'));
        }

        const currentData = cur.data();
        const curStatus = (currentData.status || '').toLowerCase();

        if (curStatus !== 'approved_admin') {
            return res.redirect('/gudang/orders?err=' + encodeURIComponent('Pesanan harus sudah diverifikasi admin untuk dikemas'));
        }

        const catatan_packing = typeof req.body.catatan_packing === 'string' ? req.body.catatan_packing.trim() : '';

        const history = Array.isArray(currentData.history) ? currentData.history : [];
        history.push({
            status: 'dipaket',
            by: req.user.uid,
            by_username: req.user.username,
            at: new Date(),
            note: catatan_packing,
        });

        await ref.update({
            status: 'dipaket',
            packed_at: new Date(),
            packed_by: req.user.uid,
            catatan_packing,
            history,
            updatedAt: new Date()
        });

        console.log(`[Gudang] Order ${currentData.kode_order || id} packed by ${req.user.username}`);
        return res.redirect('/gudang/orders?ok=packed');
    } catch (e) {
        console.error(e);
        return res.redirect('/gudang/orders?err=' + encodeURIComponent('Gagal mengemas pesanan'));
    }
});

// ====================== GUDANG: SEND ORDER (create shipment) ======================
router.post('/gudang/orders/:id/send', requireAuth, requireRole(['gudang']), csrfProtection, async (req, res) => {
    try {
        const id = req.params.id;
        const ref = db.collection('orders').doc(id);
        const cur = await ref.get();

        if (!cur.exists) {
            return res.redirect('/gudang/orders?err=' + encodeURIComponent('Pesanan tidak ditemukan'));
        }

        const currentData = cur.data();
        const curStatus = (currentData.status || '').toLowerCase();

        if (!['dipaket', 'approved_admin'].includes(curStatus)) {
            return res.redirect('/gudang/orders?err=' + encodeURIComponent('Pesanan harus sudah dikemas untuk dikirim'));
        }

        // Generate shipment data
        const kode_pengiriman = await generateResiCode();
        const so_number = await generateSequentialCode('shipments', 'SO', 'so_number');
        const shipmentId = randomUUID();

        const items = (currentData.items || []).map(it => ({
            ...it,
            item_net_value: it.harga || 0,
            item_tax: it.pajak || 0,
        }));

        const finalKet = 'Dari Pesanan: ' + currentData.kode_order + ' (Dikemas oleh: ' + req.user.username + ')';

        const shipmentDoc = {
            id: shipmentId,
            kode_pengiriman,
            po_number: currentData.kode_order,
            so_number,
            pengirim: req.user.uid,
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

        // Update order
        const history = Array.isArray(currentData.history) ? currentData.history : [];
        history.push({
            status: 'dikirim',
            by: req.user.uid,
            by_username: req.user.username,
            at: new Date(),
            note: 'Shipment: ' + kode_pengiriman,
        });

        await ref.update({
            status: 'dikirim',
            shipment_id: shipmentId,
            kode_pengiriman,
            history,
            updatedAt: new Date()
        });

        console.log(`[Gudang] Order ${currentData.kode_order || id} sent by ${req.user.username}, shipment: ${kode_pengiriman}`);
        return res.redirect('/gudang/orders?ok=sent');
    } catch (e) {
        console.error(e);
        return res.redirect('/gudang/orders?err=' + encodeURIComponent('Gagal mengirim barang'));
    }
});

// ====================== GUDANG: API for Flutter ======================

// GET orders ready for packing
router.get('/api/v1/gudang/orders', requireAuth, requireRole(['gudang']), async (req, res) => {
    try {
        const snap = await db.collection('orders').orderBy('createdAt', 'desc').get();
        const allOrders = snap.docs.map(d => d.data());

        const orders = allOrders.filter(o => {
            const st = (o.status || '').toLowerCase();
            return ['approved_admin', 'dipaket', 'dikirim'].includes(st);
        });

        const cabangIds = [...new Set(orders.map(o => o.cabang_id).filter(Boolean))];
        const usersMap = await getUsersMapByIds(cabangIds);

        const result = orders.map(o => ({
            id: o.id,
            kode_order: o.kode_order,
            cabang_id: o.cabang_id,
            cabang_username: o.cabang_username || usersMap[o.cabang_id]?.username || o.cabang_id,
            status: o.status || 'pending',
            total_harga: o.total_harga || 0,
            jumlah_item: Array.isArray(o.items) ? o.items.length : 0,
            items: o.items || [],
            keterangan: o.keterangan || '',
            catatan_packing: o.catatan_packing || '',
            kode_pengiriman: o.kode_pengiriman || '',
            createdAt: o.createdAt || null,
        }));

        return res.json({ orders: result });
    } catch (e) {
        console.error(e);
        return res.status(500).json({ error: 'server_error' });
    }
});

// POST pack order
router.post('/api/v1/gudang/orders/:id/pack', requireAuth, requireRole(['gudang']), async (req, res) => {
    try {
        const id = req.params.id;
        const ref = db.collection('orders').doc(id);
        const cur = await ref.get();

        if (!cur.exists) return res.status(404).json({ error: 'not_found' });
        const currentData = cur.data();

        if ((currentData.status || '').toLowerCase() !== 'approved_admin') {
            return res.status(400).json({ error: 'order_not_ready' });
        }

        const history = Array.isArray(currentData.history) ? currentData.history : [];
        history.push({
            status: 'dipaket',
            by: req.user.uid,
            by_username: req.user.username,
            at: new Date(),
            note: req.body.catatan_packing || '',
        });

        await ref.update({
            status: 'dipaket',
            packed_at: new Date(),
            packed_by: req.user.uid,
            catatan_packing: req.body.catatan_packing || '',
            history,
            updatedAt: new Date()
        });

        return res.json({ ok: true, status: 'dipaket' });
    } catch (e) {
        console.error(e);
        return res.status(500).json({ error: 'server_error' });
    }
});

// POST send order (create shipment)
router.post('/api/v1/gudang/orders/:id/send', requireAuth, requireRole(['gudang']), async (req, res) => {
    try {
        const id = req.params.id;
        const ref = db.collection('orders').doc(id);
        const cur = await ref.get();

        if (!cur.exists) return res.status(404).json({ error: 'not_found' });
        const currentData = cur.data();
        const curStatus = (currentData.status || '').toLowerCase();

        if (!['dipaket', 'approved_admin'].includes(curStatus)) {
            return res.status(400).json({ error: 'order_not_packed' });
        }

        const kode_pengiriman = await generateResiCode();
        const so_number = await generateSequentialCode('shipments', 'SO', 'so_number');
        const shipmentId = randomUUID();

        const items = (currentData.items || []).map(it => ({
            ...it,
            item_net_value: it.harga || 0,
            item_tax: it.pajak || 0,
        }));

        const finalKet = 'Dari Pesanan: ' + currentData.kode_order + ' (Dikemas oleh: ' + req.user.username + ')';

        const shipmentDoc = {
            id: shipmentId,
            kode_pengiriman,
            po_number: currentData.kode_order,
            so_number,
            pengirim: req.user.uid,
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

        const history = Array.isArray(currentData.history) ? currentData.history : [];
        history.push({
            status: 'dikirim',
            by: req.user.uid,
            by_username: req.user.username,
            at: new Date(),
            note: 'Shipment: ' + kode_pengiriman,
        });

        await ref.update({
            status: 'dikirim',
            shipment_id: shipmentId,
            kode_pengiriman,
            history,
            updatedAt: new Date()
        });

        return res.json({ ok: true, status: 'dikirim', kode_pengiriman, shipment_id: shipmentId });
    } catch (e) {
        console.error(e);
        return res.status(500).json({ error: 'server_error' });
    }
});

module.exports = router;
