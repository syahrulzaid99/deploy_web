const express = require('express');
const router = express.Router();
const csrf = require('csurf');

const { db } = require('../firebaseAdmin');
const { requireAuth, requireRole } = require('../middleware/auth');

const csrfProtection = csrf({ cookie: true });
router.use(express.urlencoded({ extended: false }));

// ===== List =====
router.get('/admin/divisi', requireAuth, requireRole(['admin']), csrfProtection, async (req, res) => {
    const snap = await db.collection('divisi').orderBy('nama').get();
    const divisi = snap.docs.map(d => d.data());
    
    res.render('admin/divisi', {
        title: 'Manajemen Divisi',
        csrfToken: req.csrfToken(),
        user: req.user,
        profile: req.profile,
        divisi
    });
});

// ===== Create =====
router.post('/admin/divisi', requireAuth, requireRole(['admin']), csrfProtection, async (req, res) => {
    try {
        const { nama, keterangan } = req.body;
        if (!nama) {
            return res.redirect('/admin/divisi?err=' + encodeURIComponent('Nama divisi wajib diisi'));
        }

        // Unique check
        const exist = await db.collection('divisi').where('nama', '==', nama.trim()).limit(1).get();
        if (!exist.empty) {
            return res.redirect('/admin/divisi?err=' + encodeURIComponent('Divisi sudah ada'));
        }

        const id = require('crypto').randomUUID();
        const doc = {
            id,
            nama: nama.trim(),
            keterangan: (keterangan || '').trim(),
            createdAt: new Date(),
            updatedAt: new Date()
        };
        await db.collection('divisi').doc(id).set(doc);
        return res.redirect('/admin/divisi?ok=created');
    } catch (e) {
        console.error(e);
        return res.redirect('/admin/divisi?err=' + encodeURIComponent('Gagal membuat divisi'));
    }
});

// ===== Update =====
router.post('/admin/divisi/:id', requireAuth, requireRole(['admin']), csrfProtection, async (req, res) => {
    try {
        const id = req.params.id;
        const ref = db.collection('divisi').doc(id);
        const cur = await ref.get();
        if (!cur.exists) return res.redirect('/admin/divisi?err=' + encodeURIComponent('Divisi tidak ditemukan'));

        const { nama, keterangan } = req.body;
        if (nama && nama.trim() !== cur.data().nama) {
            const exist = await db.collection('divisi').where('nama', '==', nama.trim()).limit(1).get();
            if (!exist.empty) {
                return res.redirect('/admin/divisi?err=' + encodeURIComponent('Nama divisi sudah digunakan'));
            }
        }

        const patch = {
            nama: nama ? nama.trim() : cur.data().nama,
            keterangan: typeof keterangan === 'string' ? keterangan.trim() : (cur.data().keterangan || ''),
            updatedAt: new Date()
        };

        await ref.update(patch);
        return res.redirect('/admin/divisi?ok=updated');
    } catch (e) {
        console.error(e);
        return res.redirect('/admin/divisi?err=' + encodeURIComponent('Gagal update divisi'));
    }
});

// ===== Delete =====
router.post('/admin/divisi/:id/delete', requireAuth, requireRole(['admin']), csrfProtection, async (req, res) => {
    try {
        await db.collection('divisi').doc(req.params.id).delete();
        return res.redirect('/admin/divisi?ok=deleted');
    } catch (e) {
        console.error(e);
        return res.redirect('/admin/divisi?err=' + encodeURIComponent('Gagal menghapus divisi'));
    }
});

module.exports = router;
