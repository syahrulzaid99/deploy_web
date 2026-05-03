const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
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
        const counts = await getUserCounts();
        res.render('admin/dashboard', {
            title: 'Dashboard',
            user: req.user,
            profile: req.profile,
            counts
        });
    } catch (e) {
        console.error('Failed to load dashboard counts:', e);
        res.render('admin/dashboard', {
            title: 'Dashboard',
            user: req.user,
            profile: req.profile,
            counts: { total: 0, admin: 0, cabang: 0 }
        });
    }
});

module.exports = router;
