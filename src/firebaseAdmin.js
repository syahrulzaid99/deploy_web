const admin = require('firebase-admin');

// Pastikan dotenv sudah dipanggil di app.js paling awal.
// Jika mau aman di sini juga:
if (!process.env.FIREBASE_PROJECT_ID) {
    // Optional: try load dotenv here too
    try { require('dotenv').config(); } catch (_) { }
}

// Opsi A: pakai variabel .env terpisah
const projectId = process.env.FIREBASE_PROJECT_ID;
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
let privateKey = process.env.FIREBASE_PRIVATE_KEY;

// Convert "\n" ke newline asli
if (privateKey) {
    privateKey = privateKey.replace(/\\n/g, '\n');
}

// Validasi cepat agar error-nya jelas
function assertEnv(name, val) {
    if (!val || typeof val !== 'string' || val.trim() === '') {
        throw new Error(`Missing or invalid env: ${name}`);
    }
}

try {
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        // Opsi B (disarankan di server): pakai Application Default Credentials (file JSON)
        admin.initializeApp({
            credential: admin.credential.applicationDefault(),
        });
    } else {
        // Opsi A: pakai tiga variabel env
        assertEnv('FIREBASE_PROJECT_ID', projectId);
        assertEnv('FIREBASE_CLIENT_EMAIL', clientEmail);
        assertEnv('FIREBASE_PRIVATE_KEY', privateKey);

        admin.initializeApp({
            credential: admin.credential.cert({
                projectId,
                clientEmail,
                privateKey,
            }),
        });
    }
} catch (err) {
    // Bantu debug di dev (hindari log ini di production)
    console.error('Failed to init Firebase Admin:', err.message);
    console.error('Have envs?', {
        hasProjectId: !!projectId,
        hasClientEmail: !!clientEmail,
        hasPrivateKey: !!privateKey,
        usingADC: !!process.env.GOOGLE_APPLICATION_CREDENTIALS
    });
    throw err; // biar stacktrace tetap muncul
}

const db = admin.firestore();

module.exports = { admin, db };
