const express = require('express');
const router = express.Router();
const { csrfProtection } = require('../middleware/csrf');
const { randomUUID } = require('crypto');
const admin = require('firebase-admin');

const { db } = require('../firebaseAdmin');
const { requireAuth, requireRole, requireAuthApi } = require('../middleware/auth');
const { generateSequentialCode } = require('../utils/generateCode');
const { snap } = require('../midtransClient');

router.use(express.urlencoded({ extended: false }));

// Helper to get users map
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

// ====================== SALES: LIST ORDERS (yang dibuat sales) ======================
router.get('/sales/orders', requireAuth, requireRole(['sales']), csrfProtection, async (req, res) => {
    try {
        const snap = await db.collection('orders').orderBy('createdAt', 'desc').get();
        const allOrders = snap.docs.map(d => d.data());

        // Sales lihat SEMUA order (bantu cabang) + bisa buat order baru
        const cabangIds = [...new Set(allOrders.map(o => o.cabang_id).filter(Boolean))];
        const usersMap = await getUsersMapByIds(cabangIds);

        const cabangUsers = await db.collection('users').where('role', '==', 'cabang').get();
        const cabangList = cabangUsers.docs.map(d => ({ id: d.id, username: d.data().username || d.id }));

        // Get products for order form
        const prodSnap = await db.collection('products').orderBy('sku').get();
        const products = prodSnap.docs.map(d => d.data());

        res.render('sales/orders', {
            title: 'Pesanan',
            csrfToken: req.csrfToken(),
            user: req.user,
            profile: req.profile,
            orders: allOrders,
            usersMap,
            cabangList,
            products,
            ok: req.query.ok || null,
            err: req.query.err || null,
        });
    } catch (error) {
        console.error("Error loading sales orders:", error);
        const cabangUsers = await db.collection('users').where('role', '==', 'cabang').get();
        const cabangList = cabangUsers.docs.map(d => ({ id: d.id, username: d.data().username || d.id }));
        res.render('sales/orders', {
            title: 'Pesanan',
            csrfToken: req.csrfToken(),
            user: req.user,
            profile: req.profile,
            orders: [],
            usersMap: {},
            cabangList,
            products: [],
            ok: req.query.ok || null,
            err: "Gagal memuat daftar pesanan.",
        });
    }
});

// ====================== SALES: CREATE ORDER (sama seperti cabang) ======================
router.post('/sales/orders', requireAuth, requireRole(['sales']), csrfProtection, async (req, res) => {
    try {
        const { keterangan, data_barang_json, cabang_id } = req.body;

        if (!data_barang_json) {
            return res.redirect('/sales/orders?err=' + encodeURIComponent('Data barang tidak valid'));
        }

        let items;
        try {
            items = JSON.parse(data_barang_json);
        } catch (e) {
            return res.redirect('/sales/orders?err=' + encodeURIComponent('Format data barang salah'));
        }

        if (!Array.isArray(items) || items.length === 0) {
            return res.redirect('/sales/orders?err=' + encodeURIComponent('Minimal pilih 1 produk'));
        }

        for (const it of items) {
            if (!it.product_id || !it.qty || it.qty <= 0) {
                return res.redirect('/sales/orders?err=' + encodeURIComponent('Kuantitas item harus lebih dari 0'));
            }
        }

        // Target cabang — wajib diisi oleh sales
        const targetCabangId = (cabang_id || '').trim();
        if (!targetCabangId) {
            return res.redirect('/sales/orders?err=' + encodeURIComponent('Pilih cabang tujuan'));
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

        // Ambil data user cabang untuk username
        const cabangDoc = await db.collection('users').doc(targetCabangId).get();
        const cabangUsername = cabangDoc.exists ? (cabangDoc.data().username || targetCabangId) : targetCabangId;

        const kode_order = await generateSequentialCode('orders', 'PO', 'kode_order');

        const id = randomUUID();
        const doc = {
            id,
            kode_order,
            cabang_id: targetCabangId,
            cabang_username: cabangUsername,
            created_by: req.user.uid,
            created_by_role: 'sales',
            created_by_username: req.user.username,
            items: enrichedItems,
            total_harga,
            keterangan: String(keterangan || '').trim(),
            status: 'pending',
            payment_status: 'pending',
            createdAt: new Date(),
            updatedAt: new Date(),
        };

        // Generate Midtrans Snap Token
        const midtrans_order_id = `${kode_order}-${Date.now()}`;
        try {
            const parameter = {
                transaction_details: {
                    order_id: midtrans_order_id,
                    gross_amount: Math.round(total_harga),
                },
                customer_details: {
                    first_name: cabangUsername,
                },
                enabled_payments: [
                    'credit_card', 'bca_va', 'bni_va', 'bri_va', 'permata_va',
                    'mandiri_bill', 'gopay', 'shopeepay', 'other_qris',
                    'alfamart', 'indomaret',
                ],
            };
            console.log('[Midtrans] Sales creating transaction:', midtrans_order_id, 'amount:', Math.round(total_harga));
            const transaction = await snap.createTransaction(parameter);
            doc.snap_token = transaction.token;
            doc.payment_url = transaction.redirect_url;
            doc.midtrans_order_id = midtrans_order_id;
            doc.payment_status = 'pending';
            console.log('[Midtrans] token ok:', doc.payment_url);
        } catch (midtransError) {
            const msgs = midtransError?.ApiResponse?.error_messages || midtransError?.message || midtransError;
            console.error('[Midtrans] GAGAL buat token:', JSON.stringify(msgs));
            doc.payment_status = 'failed_to_generate';
        }

        await db.collection('orders').doc(id).set(doc);

        // Deduct inventory stock
        const batch = db.batch();
        let hasOp = false;
        for (const item of enrichedItems) {
            if (item.product_id && item.qty > 0) {
                batch.update(db.collection('products').doc(item.product_id), {
                    stok: admin.firestore.FieldValue.increment(-item.qty),
                    updatedAt: new Date()
                });
                hasOp = true;
            }
        }
        if (hasOp) await batch.commit().catch(e => console.error('Failed to deduct stock for order:', e));

        return res.redirect('/sales/orders?ok=created');
    } catch (e) {
        console.error('❌ Sales create order error:', e);
        return res.redirect('/sales/orders?err=' + encodeURIComponent('Gagal membuat pesanan'));
    }
});

// ====================== SALES: API for Flutter ======================

// GET orders for flutter
router.get('/api/v1/sales/orders', requireAuthApi, requireRole(['sales']), async (req, res) => {
    try {
        const snap = await db.collection('orders').orderBy('createdAt', 'desc').get();
        const allOrders = snap.docs.map(d => d.data());

        const cabangIds = [...new Set(allOrders.map(o => o.cabang_id).filter(Boolean))];
        const usersMap = await getUsersMapByIds(cabangIds);

        const result = allOrders.map(o => ({
            id: o.id,
            kode_order: o.kode_order,
            cabang_id: o.cabang_id,
            cabang_username: o.cabang_username || usersMap[o.cabang_id]?.username || o.cabang_id,
            status: o.status || 'pending',
            payment_status: o.payment_status || 'pending',
            total_harga: o.total_harga || 0,
            jumlah_item: Array.isArray(o.items) ? o.items.length : 0,
            items: o.items || [],
            keterangan: o.keterangan || '',
            created_by_role: o.created_by_role || '',
            createdAt: o.createdAt || null,
        }));

        return res.json({ orders: result });
    } catch (e) {
        console.error(e);
        return res.status(500).json({ error: 'server_error' });
    }
});

// POST create order via API (sama seperti cabang, tapi untuk sales + wajib pilih cabang)
router.post('/api/v1/sales/orders', requireAuthApi, requireRole(['sales']), express.json(), async (req, res) => {
    try {
        const { items, keterangan, cabang_id } = req.body || {};

        if (!Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ error: 'items_required' });
        }

        for (const it of items) {
            if (!it.product_id || !it.qty || it.qty <= 0) {
                return res.status(400).json({ error: 'invalid_item', detail: 'Setiap item harus punya product_id dan qty > 0' });
            }
        }

        const targetCabangId = (cabang_id || '').trim();
        if (!targetCabangId) {
            return res.status(400).json({ error: 'cabang_required', message: 'Sales wajib memilih cabang tujuan' });
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

        // Stock validation
        for (const it of enrichedItems) {
            const p = productsById[it.product_id] || {};
            const currentStock = p.stok || 0;
            if (currentStock < it.qty) {
                return res.status(400).json({
                    error: 'insufficient_stock',
                    message: `Stok produk "${it.nama_produk}" tidak mencukupi (Tersisa: ${currentStock})`
                });
            }
        }

        const cabangDoc = await db.collection('users').doc(targetCabangId).get();
        const cabangUsername = cabangDoc.exists ? (cabangDoc.data().username || targetCabangId) : targetCabangId;

        const kode_order = await generateSequentialCode('orders', 'PO', 'kode_order');
        const id = randomUUID();
        const doc = {
            id,
            kode_order,
            cabang_id: targetCabangId,
            cabang_username: cabangUsername,
            created_by: req.user.uid,
            created_by_role: 'sales',
            created_by_username: req.user.username,
            items: enrichedItems,
            total_harga,
            keterangan: String(keterangan || '').trim(),
            status: 'pending',
            payment_status: 'pending',
            createdAt: new Date(),
            updatedAt: new Date(),
        };

        // Generate Midtrans Snap Token
        const midtrans_order_id = `${kode_order}-${Date.now()}`;
        try {
            const parameter = {
                transaction_details: {
                    order_id: midtrans_order_id,
                    gross_amount: Math.round(total_harga),
                },
                customer_details: {
                    first_name: cabangUsername,
                },
                enabled_payments: [
                    'credit_card', 'bca_va', 'bni_va', 'bri_va', 'permata_va',
                    'mandiri_bill', 'gopay', 'shopeepay', 'other_qris',
                    'alfamart', 'indomaret',
                ],
            };
            console.log('[Midtrans] Sales API creating transaction:', midtrans_order_id);
            const transaction = await snap.createTransaction(parameter);
            doc.snap_token = transaction.token;
            doc.payment_url = transaction.redirect_url;
            doc.midtrans_order_id = midtrans_order_id;
            console.log('[Midtrans] token ok:', doc.payment_url);
        } catch (midtransError) {
            console.error('[Midtrans] GAGAL buat token:', midtransError?.message || midtransError);
            doc.payment_status = 'failed_to_generate';
        }

        await db.collection('orders').doc(id).set(doc);

        // Deduct stock
        const batch = db.batch();
        let hasOp = false;
        for (const item of enrichedItems) {
            if (item.product_id && item.qty > 0) {
                batch.update(db.collection('products').doc(item.product_id), {
                    stok: admin.firestore.FieldValue.increment(-item.qty),
                    updatedAt: new Date()
                });
                hasOp = true;
            }
        }
        if (hasOp) await batch.commit().catch(e => console.error('Failed to deduct stock:', e));

        return res.json({ ok: true, kode_order, id, payment_url: doc.payment_url });
    } catch (e) {
        console.error('❌ Sales API create order error:', e);
        return res.status(500).json({ error: 'server_error' });
    }
});

module.exports = router;
