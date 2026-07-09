const midtransClient = require('midtrans-client');

const serverKey = process.env.MIDTRANS_SERVER_KEY || '';
const clientKey = process.env.MIDTRANS_CLIENT_KEY || '';

// Gunakan env var MIDTRANS_IS_PRODUCTION jika di-set secara eksplisit.
// Default: sandbox (false) — lebih aman untuk development/skripsi.
const isProduction = process.env.MIDTRANS_IS_PRODUCTION === 'true';

console.log(`[Midtrans] mode: ${isProduction ? 'PRODUCTION' : 'SANDBOX'}`);

// Inisialisasi Snap client
const snap = new midtransClient.Snap({
    isProduction,
    serverKey,
    clientKey,
});

// Inisialisasi CoreApi (opsional, untuk handle webhook notifikasi)
const coreApi = new midtransClient.CoreApi({
    isProduction,
    serverKey,
    clientKey,
});

module.exports = { snap, coreApi };
