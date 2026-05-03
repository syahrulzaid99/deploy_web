const express = require('express');
const router = express.Router();
const csrf = require('csurf');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const { db } = require('../firebaseAdmin');
const { requireAuth, requireRole } = require('../middleware/auth');

const csrfProtection = csrf({ cookie: true });
router.use(express.urlencoded({ extended: false }));

// ===== Multer setup =====
const uploadRoot = path.join(__dirname, '..', '..', 'uploads', 'products');
fs.mkdirSync(uploadRoot, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadRoot),
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
const upload = multer({ storage, fileFilter, limits: { fileSize: 5 * 1024 * 1024 } }); // 5MB

// ===== Helpers =====
function imageUrl(filename) {
    return filename ? `/uploads/products/${filename}` : '';
}
function safeUnlink(filename) {
    if (!filename) return;
    const full = path.join(uploadRoot, filename);
    fs.existsSync(full) && fs.unlink(full, () => { });
}

// ===== List =====
router.get('/admin/products', requireAuth, requireRole(['admin']), csrfProtection, async (req, res) => {
    const snap = await db.collection('products').orderBy('sku').get();
    const products = snap.docs.map(d => d.data());

    const divisiSnap = await db.collection('divisi').orderBy('nama').get();
    const listDivisi = divisiSnap.docs.map(d => d.data());

    res.render('admin/products', {
        title: 'Produk',
        csrfToken: req.csrfToken(),
        user: req.user,
        profile: req.profile,
        products,
        listDivisi
    });
});

// ===== Create =====
router.post('/admin/products', requireAuth, requireRole(['admin']), upload.single('gambar'), csrfProtection, async (req, res) => {
    try {
        const { sku, barcode, nama_produk, satuan, divisi, harga_modal, harga_jual, pajak, stok } = req.body;
        if (!sku || !nama_produk || !satuan) {
            // hapus upload yang sudah terlanjur naik
            if (req.file?.filename) safeUnlink(req.file.filename);
            return res.redirect('/admin/products?err=' + encodeURIComponent('SKU, Nama Produk, dan Satuan wajib diisi'));
        }

        // Unique check (SKU wajib unik; barcode opsional kalau diisi)
        const skuExist = await db.collection('products').where('sku', '==', sku).limit(1).get();
        if (!skuExist.empty) {
            if (req.file?.filename) safeUnlink(req.file.filename);
            return res.redirect('/admin/products?err=' + encodeURIComponent('SKU sudah digunakan'));
        }
        if (barcode) {
            const bcExist = await db.collection('products').where('barcode', '==', barcode).limit(1).get();
            if (!bcExist.empty) {
                if (req.file?.filename) safeUnlink(req.file.filename);
                return res.redirect('/admin/products?err=' + encodeURIComponent('Barcode sudah digunakan'));
            }
        }

        const id = require('crypto').randomUUID();
        const fileName = req.file?.filename || '';
        const doc = {
            id,
            sku: sku.trim(),
            barcode: (barcode || '').trim(),
            nama_produk: nama_produk.trim(),
            satuan: satuan.trim(),
            divisi: (divisi || '').trim(),
            stok: Number(stok) || 0,
            harga_modal: parseFloat(harga_modal) || 0,
            harga_jual: parseFloat(harga_jual) || 0,
            pajak: parseFloat(pajak) || 0,
            gambar_filename: fileName,
            gambar_url: imageUrl(fileName),
            createdAt: new Date(),
            updatedAt: new Date()
        };
        await db.collection('products').doc(id).set(doc);
        return res.redirect('/admin/products?ok=created');
    } catch (e) {
        console.error(e);
        return res.redirect('/admin/products?err=' + encodeURIComponent('Gagal membuat produk'));
    }
});

// ===== Update =====
router.post('/admin/products/:id', requireAuth, requireRole(['admin']), upload.single('gambar'), csrfProtection, async (req, res) => {
    try {
        const id = req.params.id;
        const ref = db.collection('products').doc(id);
        const cur = await ref.get();
        if (!cur.exists) {
            if (req.file?.filename) safeUnlink(req.file.filename);
            return res.redirect('/admin/products?err=' + encodeURIComponent('Produk tidak ditemukan'));
        }
        const { sku, barcode, nama_produk, satuan, divisi, harga_modal, harga_jual, pajak, stok } = req.body;

        // unique checks (jika sku/barcode berubah)
        if (sku && sku !== cur.data().sku) {
            const skuExist = await db.collection('products').where('sku', '==', sku).limit(1).get();
            if (!skuExist.empty) {
                if (req.file?.filename) safeUnlink(req.file.filename);
                return res.redirect('/admin/products?err=' + encodeURIComponent('SKU sudah digunakan'));
            }
        }
        if (barcode && barcode !== cur.data().barcode) {
            const bcExist = await db.collection('products').where('barcode', '==', barcode).limit(1).get();
            if (!bcExist.empty) {
                if (req.file?.filename) safeUnlink(req.file.filename);
                return res.redirect('/admin/products?err=' + encodeURIComponent('Barcode sudah digunakan'));
            }
        }

        const patch = {
            sku: sku ? sku.trim() : cur.data().sku,
            barcode: typeof barcode === 'string' ? barcode.trim() : (cur.data().barcode || ''),
            nama_produk: nama_produk ? nama_produk.trim() : cur.data().nama_produk,
            satuan: satuan ? satuan.trim() : cur.data().satuan,
            divisi: typeof divisi === 'string' ? divisi.trim() : (cur.data().divisi || ''),
            stok: stok !== undefined ? (Number(stok) || 0) : (cur.data().stok || 0),
            harga_modal: harga_modal !== undefined ? (parseFloat(harga_modal) || 0) : (cur.data().harga_modal || 0),
            harga_jual: harga_jual !== undefined ? (parseFloat(harga_jual) || 0) : (cur.data().harga_jual || 0),
            pajak: pajak !== undefined ? (parseFloat(pajak) || 0) : (cur.data().pajak || 0),
            updatedAt: new Date()
        };

        // gambar baru?
        if (req.file?.filename) {
            const oldFile = cur.data().gambar_filename;
            patch.gambar_filename = req.file.filename;
            patch.gambar_url = imageUrl(req.file.filename);
            await ref.update(patch);
            safeUnlink(oldFile); // hapus file lama
        } else {
            await ref.update(patch);
        }

        return res.redirect('/admin/products?ok=updated');
    } catch (e) {
        console.error(e);
        return res.redirect('/admin/products?err=' + encodeURIComponent('Gagal update produk'));
    }
});

// ===== Delete =====
router.post('/admin/products/:id/delete', requireAuth, requireRole(['admin']), csrfProtection, async (req, res) => {
    try {
        const id = req.params.id;
        const ref = db.collection('products').doc(id);
        const cur = await ref.get();
        if (cur.exists) {
            const oldFile = cur.data().gambar_filename;
            await ref.delete();
            safeUnlink(oldFile);
        }
        return res.redirect('/admin/products?ok=deleted');
    } catch (e) {
        console.error(e);
        return res.redirect('/admin/products?err=' + encodeURIComponent('Gagal menghapus produk'));
    }
});

module.exports = router;
