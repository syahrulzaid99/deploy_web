const cloudinary = require('cloudinary').v2;

// ===== Konfigurasi dari env =====
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

/**
 * Upload file buffer ke Cloudinary.
 *
 * @param {Buffer} fileBuffer           - Isi file (dari multer memoryStorage)
 * @param {string} destinationPath      - Path tujuan, e.g. "products/namafile.jpg"
 *                                        (public_id = tanpa ekstensi)
 * @param {string} [contentType]        - MIME type file
 * @returns {Promise<string>}           - URL dari file yang sudah diupload
 */
function uploadToStorage(fileBuffer, destinationPath, contentType) {
    return new Promise((resolve, reject) => {
        // Cloudinary public_id = path tanpa ekstensi
        const publicId = destinationPath.replace(/\.[^.]+$/, '');

        const uploadStream = cloudinary.uploader.upload_stream(
            {
                public_id: publicId,
                resource_type: 'image',
                overwrite: true,
            },
            (error, result) => {
                if (error) {
                    console.error('Cloudinary upload error:', error);
                    reject(error);
                } else {
                    resolve(result.secure_url);
                }
            }
        );

        uploadStream.end(fileBuffer);
    });
}

/**
 * Hapus file dari Cloudinary.
 * @param {string} fileUrl - Public URL file yang ingin dihapus
 */
async function deleteFromStorage(fileUrl) {
    if (!fileUrl) return;
    try {
        // Ekstrak public_id dari URL Cloudinary
        // Format URL: https://res.cloudinary.com/<cloud_name>/image/upload/v1234567/products/namafile.jpg
        const parts = fileUrl.split('/');
        const versionIndex = parts.findIndex(p => p.startsWith('v') && /^\d+$/.test(p.slice(1)));
        if (versionIndex === -1) return;

        const publicIdParts = parts.slice(versionIndex + 1);
        const publicId = publicIdParts.join('/').replace(/\.[^.]+$/, ''); // hapus ekstensi

        if (!publicId) return;

        const result = await cloudinary.uploader.destroy(publicId);
        if (result.result !== 'ok') {
            console.warn('Cloudinary delete warning:', result);
        }
    } catch (e) {
        console.error('Gagal hapus file dari Cloudinary:', e.message);
    }
}

/**
 * Ekstrak filename dari URL Cloudinary.
 */
function getFilenameFromUrl(fileUrl) {
    if (!fileUrl) return '';
    try {
        const parts = fileUrl.split('/');
        // Cari bagian setelah /upload/v12345/
        const versionIndex = parts.findIndex(p => p.startsWith('v') && /^\d+$/.test(p.slice(1)));
        if (versionIndex === -1) return parts[parts.length - 1] || '';
        // Ambil path setelah version, sambung dengan /
        const filename = parts.slice(versionIndex + 1).join('_');
        return filename;
    } catch {
        return '';
    }
}

module.exports = { uploadToStorage, deleteFromStorage, getFilenameFromUrl };
