const { db } = require('../firebaseAdmin');

/**
 * Generate sequential code for orders and shipments based on the current date.
 * Example: PREFIX-YYYYMMDD-001
 * 
 * @param {string} collectionName - 'orders' or 'shipments'
 * @param {string} prefix - 'PO' or 'SO'
 * @param {string} codeField - 'kode_order' or 'kode_pengiriman'
 * @returns {Promise<string>} The sequential code
 */
async function generateSequentialCode(collectionName, prefix, codeField) {
    const today = new Date();
    // Get start and end of today in local time
    const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);

    // Query documents created today to count them
    const snap = await db.collection(collectionName)
        .where('createdAt', '>=', startOfDay)
        .where('createdAt', '<', endOfDay)
        .get();

    // In case there are missing createdAt fields, we can fallback to checking if any document matches the YYYYMMDD prefix
    // But relying on count for today's documents is standard.
    // However, if some documents were deleted, count might overlap.
    // A safer way is to fetch the latest document for today and increment its number.
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    const dateStr = `${yyyy}${mm}${dd}`;

    let maxSequence = 0;

    snap.docs.forEach(doc => {
        const data = doc.data();
        const code = data[codeField] || '';
        // Look for the sequence number at the end of the code (e.g., PO-20260503-001)
        if (code.startsWith(`${prefix}-${dateStr}-`)) {
            const parts = code.split('-');
            if (parts.length === 3) {
                const seq = parseInt(parts[2], 10);
                if (!isNaN(seq) && seq > maxSequence) {
                    maxSequence = seq;
                }
            }
        }
    });

    const nextSequence = maxSequence + 1;
    const sequenceStr = String(nextSequence).padStart(3, '0');

    return `${prefix}-${dateStr}-${sequenceStr}`;
}

async function generateResiCode() {
    const prefix = "TRXID";
    // Generate a string of 10 random digits
    let randomDigits = "";
    for (let i = 0; i < 10; i++) {
        randomDigits += Math.floor(Math.random() * 10).toString();
    }
    return `${prefix}${randomDigits}`;
}

module.exports = { generateSequentialCode, generateResiCode };
