const express = require('express');
const router = express.Router();
const { db } = require('../firebaseAdmin');
const { requireAuth, requireRole } = require('../middleware/auth');

router.get('/admin/reports', requireAuth, requireRole(['admin']), async (req, res) => {
    try {
        const snap = await db.collection('shipments').orderBy('kode_pengiriman').get();
        const shipments = snap.docs.map(d => d.data());

        // Get Users for customer mapping
        const semuaUserIds = [...new Set([
            ...shipments.map(s => s.pengirim).filter(Boolean),
            ...shipments.map(s => s.penerima).filter(Boolean),
        ])];

        const usersMap = {};
        if (semuaUserIds.length > 0) {
            const chunks = []; 
            for (let i = 0; i < semuaUserIds.length; i += 10) chunks.push(semuaUserIds.slice(i, i + 10));
            for (const chunk of chunks) {
                const snaps = await Promise.all(chunk.map(id => db.collection('users').doc(id).get()));
                for (const s of snaps) if (s.exists) usersMap[s.id] = s.data();
            }
        }

        // Flatten data into individual item rows for the report
        const reportRows = [];
        for (const s of shipments) {
            const penerimaUser = usersMap[s.penerima] || {};
            const invDate = s.createdAt && s.createdAt.toDate ? s.createdAt.toDate() : (new Date());
            const items = Array.isArray(s.data_barang) ? s.data_barang : [];
            
            for (const it of items) {
                const qty = Number(it.qty || it.jumlah || it._qty || 0);
                
                reportRows.push({
                    invoice_no: s.kode_pengiriman || '',
                    invoice_date: invDate,
                    delivery_note: s.kode_pengiriman || '',
                    customer_code: s.penerima || '',
                    customer_name: penerimaUser.username || penerimaUser.nama_cabang || penerimaUser.nama || s.penerima || '',
                    po_number: s.po_number || '',
                    so_number: s.so_number || '',
                    po_date: invDate, // Usually same as invoice date if we don't have separate field
                    material_no: it.sku || it.barcode || it.product_id || '',
                    material_desc: it.nama_produk || '',
                    material_div: it.divisi || '',
                    billed_qty: qty,
                    item_net_value: Number(it.item_net_value || 0),
                    item_cost: Number(it.item_cost || 0),
                    item_tax: Number(it.item_tax || 0)
                });
            }
        }

        res.render('admin/reports', {
            title: 'Laporan Penjualan',
            user: req.user, 
            profile: req.profile,
            reportRows
        });
    } catch (e) {
        console.error(e);
        res.status(500).send('Error generating report');
    }
});

module.exports = router;
