/**
 * Script migrasi gambar dari local filesystem ke Cloudinary.
 *
 * Cara pakai:
 *   1. Isi dulu CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET di .env
 *   2. node scripts/migrateUploads.js
 *
 * Yang dimigrasi:
 *   1. uploads/products/  → products/
 *   2. uploads/shipments_proofs/  → shipments_proofs/
 *
 * Setelah migrasi, field `gambar_url` di Firestore akan diupdate
 * dari path relatif (mis: /uploads/products/xxx.jpg) menjadi full URL
 * (mis: https://res.cloudinary.com/.../products/xxx.jpg)
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const fs = require('fs');
const cloudinary = require('cloudinary').v2;

// Init Firebase Admin (sama seperti firebaseAdmin.js)
const { admin, db } = require('../src/firebaseAdmin');

// Konfig Cloudinary
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

const UPLOAD_ROOT = path.join(__dirname, '..', 'uploads');

/**
 * Upload satu file dari disk ke Cloudinary, return secure_url.
 */
function uploadFile(localPath, publicId) {
    return new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
            {
                public_id: publicId,
                resource_type: 'image',
                overwrite: true,
            },
            (error, result) => {
                if (error) reject(error);
                else resolve(result.secure_url);
            }
        );
        fs.createReadStream(localPath).pipe(uploadStream);
    });
}

/**
 * Migrasi gambar produk.
 * Cari dokumen yang gambar_url-nya masih path relatif (/uploads/products/...)
 */
async function migrateProducts() {
    console.log('\n=== MIGRASI GAMBAR PRODUK ===');
    const snap = await db.collection('products').get();
    let total = 0;
    let migrated = 0;
    let skipped = 0;

    for (const doc of snap.docs) {
        total++;
        const data = doc.data();
        const oldUrl = data.gambar_url || '';
        const filename = data.gambar_filename || '';

        // Skip kalau sudah full URL (mulai dengan http)
        if (oldUrl.startsWith('http')) {
            skipped++;
            continue;
        }

        if (!filename) {
            skipped++;
            continue;
        }

        const localPath = path.join(UPLOAD_ROOT, 'products', filename);
        if (!fs.existsSync(localPath)) {
            console.warn(`  ⚠ File tidak ditemukan: ${localPath}`);
            skipped++;
            continue;
        }

        try {
            // public_id = products/filename tanpa ekstensi
            const publicId = 'products/' + filename.replace(/\.[^.]+$/, '');
            const newUrl = await uploadFile(localPath, publicId);
            await doc.ref.update({ gambar_url: newUrl });
            console.log(`  ✅ ${data.sku || data.id}: ${filename} → migrated`);
            migrated++;
        } catch (e) {
            console.error(`  ❌ Gagal migrate ${filename}:`, e.message);
        }
    }

    console.log(`\nProduk: ${total} total, ${migrated} migrated, ${skipped} skipped`);
    return migrated;
}

/**
 * Migrasi bukti penerimaan shipment.
 */
async function migrateShipmentProofs() {
    console.log('\n=== MIGRASI BUKTI PENERIMAAN SHIPMENT ===');
    const snap = await db.collection('shipments').get();
    let total = 0;
    let migrated = 0;
    let skipped = 0;

    for (const doc of snap.docs) {
        total++;
        const data = doc.data();
        const urls = data.bukti_penerimaan_urls || [];

        if (!urls.length) {
            skipped++;
            continue;
        }

        // Filter mana yang masih path relatif
        const oldLocalUrls = urls.filter(u => u && !u.startsWith('http'));
        if (!oldLocalUrls.length) {
            skipped++;
            continue;
        }

        console.log(`  📦 Shipment ${data.kode_pengiriman || data.id}: ${oldLocalUrls.length} file perlu migrasi`);
        const newUrls = [];

        for (const oldUrl of oldLocalUrls) {
            const parts = oldUrl.split('/');
            const filename = parts[parts.length - 1];
            if (!filename) continue;

            const localPath = path.join(UPLOAD_ROOT, 'shipments_proofs', filename);
            if (!fs.existsSync(localPath)) {
                console.warn(`    ⚠ File tidak ditemukan: ${localPath}`);
                continue;
            }

            try {
                const publicId = 'shipments_proofs/' + filename.replace(/\.[^.]+$/, '');
                const newUrl = await uploadFile(localPath, publicId);
                newUrls.push(newUrl);
                console.log(`    ✅ ${filename} → migrated`);
            } catch (e) {
                console.error(`    ❌ Gagal migrate ${filename}:`, e.message);
            }
        }

        // Gabung URL baru dengan yang sudah http
        const existingHttpUrls = urls.filter(u => u && u.startsWith('http'));
        const finalUrls = [...existingHttpUrls, ...newUrls];

        if (finalUrls.length > 0) {
            await doc.ref.update({ bukti_penerimaan_urls: finalUrls });
            migrated += newUrls.length;
            console.log(`  ✅ Shipment ${data.kode_pengiriman || data.id} updated`);
        }
    }

    console.log(`\nShipment: ${total} total, ${migrated} file migrated`);
    return migrated;
}

async function main() {
    console.log('☁️  Memulai migrasi uploads ke Cloudinary...');
    console.log(`   Cloud Name: ${process.env.CLOUDINARY_CLOUD_NAME || '(belum diset)'}`);

    if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
        console.error('\n❌ ERROR: Isi dulu CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET di .env');
        console.log('   Daftar gratis di https://cloudinary.com/console');
        process.exit(1);
    }

    const prodCount = await migrateProducts();
    const proofCount = await migrateShipmentProofs();

    console.log('\n========================================');
    console.log('✅ Selesai! Total migrasi:');
    console.log(`   - Gambar produk: ${prodCount} file`);
    console.log(`   - Bukti penerimaan: ${proofCount} file`);
    console.log('========================================\n');
    process.exit(0);
}

main().catch(e => {
    console.error('❌ Migrasi gagal:', e);
    process.exit(1);
});
