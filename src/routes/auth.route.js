const express = require('express');
const router = express.Router();
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { csrfProtection } = require('../middleware/csrf');
const { db } = require('../firebaseAdmin');
const { requireAuthApi } = require('../middleware/auth');


const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || '__session';
const EXPIRES_DAYS = parseInt(process.env.SESSION_COOKIE_EXPIRES_DAYS || '5', 10);
const JWT_SECRET = process.env.JWT_SECRET;

router.use(cookieParser());
router.get('/login', csrfProtection, (req, res) => {
    res.render('login', { 
        layout: false, 
        csrfToken: req.csrfToken(),
        error: req.query.error,
        oldUsername: req.query.u
    });
});


router.post('/login', express.urlencoded({ extended: false }), csrfProtection, async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.redirect('/login?error=empty');

        // Cari user berdasarkan username (case-sensitive, sesuaikan kebutuhan)
        const q = await db.collection('users').where('username', '==', username).limit(1).get();
        if (q.empty) return res.redirect('/login?error=invalid&u=' + encodeURIComponent(username));

        const doc = q.docs[0];
        const user = doc.data();

        const ok = await bcrypt.compare(password, user.password_hash || '');
        if (!ok) return res.redirect('/login?error=invalid&u=' + encodeURIComponent(username));

        // Buat JWT
        const expiresInSec = EXPIRES_DAYS * 24 * 60 * 60;
        const token = jwt.sign(
            { uid: user.id, username: user.username, role: user.role },
            JWT_SECRET,
            { expiresIn: expiresInSec }
        );

        res.cookie(SESSION_COOKIE_NAME, token, {
            maxAge: expiresInSec * 1000,
            httpOnly: true,
            secure: true,   // set false saat dev HTTP lokal
            sameSite: 'lax',
            path: '/'
        });

        res.redirect('/dashboard');
    } catch (e) {
        console.error(e);
        res.status(500).send('Login error');
    }
});

router.post('/api/v1/auth/login', express.json(), async (req, res) => {
    try {
        const { username, password } = req.body || {};
        if (!username || !password) return res.status(400).json({ error: 'missing_fields' });

        const q = await db.collection('users').where('username', '==', username).limit(1).get();
        if (q.empty) return res.status(401).json({ error: 'invalid_credentials' });

        const user = q.docs[0].data();
        const ok = await bcrypt.compare(password, user.password_hash || '');
        if (!ok) return res.status(401).json({ error: 'invalid_credentials' });

        // Semua role bisa login via API (Flutter akan routing menu sesuai role)

        const expiresInSec = EXPIRES_DAYS * 24 * 60 * 60;
        const token = jwt.sign(
            { uid: user.id, username: user.username, role: user.role },
            JWT_SECRET,
            { expiresIn: expiresInSec }
        );

        return res.json({
            token,
            user: {
                id: user.id,
                username: user.username,
                role: user.role,
                nama_cabang: user.nama_cabang || '',
            }
        });
    } catch (e) {
        console.error(e);
        return res.status(500).json({ error: 'server_error' });
    }
});

router.get('/api/v1/auth/me', requireAuthApi, (req, res) => {
    return res.json({
        user: req.profile || {}
    });
});

router.put('/api/v1/auth/profile', express.json(), requireAuthApi, async (req, res) => {
    try {
        const { nama_cabang, provinsi, kota, jalan, password } = req.body;
        const uid = req.user.uid;

        const updateData = {
            nama_cabang: nama_cabang ?? '',
            provinsi: provinsi ?? '',
            kota: kota ?? '',
            jalan: jalan ?? '',
            updatedAt: new Date()
        };

        if (password && password.trim().length >= 6) {
            updateData.password_hash = await bcrypt.hash(password.trim(), 12);
        }

        await db.collection('users').doc(uid).update(updateData);
        
        return res.json({ success: true, message: 'Profil berhasil diperbarui' });
    } catch (e) {
        console.error(e);
        return res.status(500).json({ error: 'server_error' });
    }
});

router.post('/logout', (req, res) => {
    res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    res.redirect('/login');
});

module.exports = router;
