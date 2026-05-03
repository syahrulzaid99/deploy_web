const jwt = require('jsonwebtoken');
const { db } = require('../firebaseAdmin');

const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || '__session';
const JWT_SECRET = process.env.JWT_SECRET;

async function requireAuth(req, res, next) {
    try {
        const token = req.cookies[SESSION_COOKIE_NAME];
        if (!token) return res.redirect('/login');

        const payload = jwt.verify(token, JWT_SECRET); // { uid, username, role, exp, iat }
        req.user = payload;

        // Ambil profil terbaru (opsional, atau pakai payload saja)
        const snap = await db.collection('users').doc(payload.uid).get();
        req.profile = snap.exists ? snap.data() : null;

        next();
    } catch (e) {
        return res.redirect('/login');
    }
}

function extractToken(req) {
    const h = req.headers.authorization || '';
    if (h.toLowerCase().startsWith('bearer ')) return h.slice(7).trim();
    return req.cookies?.[SESSION_COOKIE_NAME]; // fallback cookie (web)
}

async function requireAuthApi(req, res, next) {
    try {
        const token = extractToken(req);
        if (!token) return res.status(401).json({ error: 'unauthorized' });

        const payload = jwt.verify(token, JWT_SECRET);
        req.user = payload;

        const snap = await db.collection('users').doc(payload.uid).get();
        req.profile = snap.exists ? snap.data() : null;

        return next();
    } catch (e) {
        return res.status(401).json({ error: 'unauthorized' });
    }
}

function requireRole(roles = []) {
    return (req, res, next) => {
        const role = req.user?.role || req.profile?.role;
        if (!role || !roles.includes(role)) {
            // untuk API lebih enak JSON
            const wantsJson = String(req.headers.accept || '').includes('application/json') || req.path.startsWith('/api/');
            return wantsJson ? res.status(403).json({ error: 'forbidden' }) : res.status(403).send('Forbidden');
        }
        next();
    };
}

module.exports = { requireAuthApi, requireRole };


// function requireRole(roles = []) {
//     return (req, res, next) => {
//         const role = req.user?.role || req.profile?.role;
//         if (!role || !roles.includes(role)) {
//             return res.status(403).send('Forbidden');
//         }
//         next();
//     };
// }

module.exports = { requireAuth, requireAuthApi, requireRole };
