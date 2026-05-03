const express = require('express');
const router = express.Router();
const csrf = require('csurf');
const bcrypt = require('bcryptjs');

const { db } = require('../firebaseAdmin');
const { requireAuth, requireRole } = require('../middleware/auth');

const csrfProtection = csrf({ cookie: true });
router.use(express.urlencoded({ extended: false }));

// List Users (Admin only)
router.get('/admin/users', requireAuth, requireRole(['admin']), csrfProtection, async (req, res) => {
    const snap = await db.collection('users').orderBy('username').get();
    const users = snap.docs.map(d => d.data());
    res.render('admin/users', {
        title: 'Users',
        users,
        csrfToken: req.csrfToken(),
        user: req.user, profile: req.profile
    });
});

// CREATE
router.post('/admin/users', requireAuth, requireRole(['admin']), csrfProtection, async (req, res) => {
    try {
        const { username, password, role, nama_cabang, provinsi, kota, jalan } = req.body;
        if (!username || !password || !role) {
            return res.redirect('/admin/users?err=' + encodeURIComponent('Field wajib belum lengkap'));
        }
        if (!['admin', 'cabang'].includes(role)) {
            return res.redirect('/admin/users?err=' + encodeURIComponent('Role tidak valid'));
        }
        const exist = await db.collection('users').where('username', '==', username).limit(1).get();
        if (!exist.empty) return res.redirect('/admin/users?err=' + encodeURIComponent('Username sudah digunakan'));

        const id = require('crypto').randomUUID();
        const password_hash = await require('bcryptjs').hash(password, 12);

        await db.collection('users').doc(id).set({
            id, username, password_hash, role,
            nama_cabang: nama_cabang || '', provinsi: provinsi || '',
            kota: kota || '', jalan: jalan || '',
            createdAt: new Date(), updatedAt: new Date(),
        });

        return res.redirect('/admin/users?ok=created');
    } catch (e) {
        console.error(e);
        return res.redirect('/admin/users?err=' + encodeURIComponent('Gagal membuat user'));
    }
});

// UPDATE
router.post('/admin/users/:id', requireAuth, requireRole(['admin']), csrfProtection, async (req, res) => {
    try {
        const id = req.params.id;
        const { username, password, role, nama_cabang, provinsi, kota, jalan } = req.body;

        const docRef = db.collection('users').doc(id);
        const doc = await docRef.get();
        if (!doc.exists) return res.redirect('/admin/users?err=' + encodeURIComponent('User tidak ditemukan'));

        if (username && username !== doc.data().username) {
            const exist = await db.collection('users').where('username', '==', username).limit(1).get();
            if (!exist.empty) return res.redirect('/admin/users?err=' + encodeURIComponent('Username sudah digunakan'));
        }

        const patch = {
            username: username || doc.data().username,
            role: role || doc.data().role,
            nama_cabang: nama_cabang ?? doc.data().nama_cabang,
            provinsi: provinsi ?? doc.data().provinsi,
            kota: kota ?? doc.data().kota,
            jalan: jalan ?? doc.data().jalan,
            updatedAt: new Date(),
        };
        if (password && password.trim()) {
            patch.password_hash = await require('bcryptjs').hash(password, 12);
        }

        await docRef.update(patch);
        return res.redirect('/admin/users?ok=updated');
    } catch (e) {
        console.error(e);
        return res.redirect('/admin/users?err=' + encodeURIComponent('Gagal update user'));
    }
});

// DELETE
router.post('/admin/users/:id/delete', requireAuth, requireRole(['admin']), csrfProtection, async (req, res) => {
    try {
        await db.collection('users').doc(req.params.id).delete();
        return res.redirect('/admin/users?ok=deleted');
    } catch (e) {
        console.error(e);
        return res.redirect('/admin/users?err=' + encodeURIComponent('Gagal menghapus user'));
    }
});

module.exports = router;
