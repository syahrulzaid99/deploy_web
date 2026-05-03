require('dotenv').config();
const bcrypt = require('bcryptjs');
const { db } = require('../src/firebaseAdmin');

(async () => {
    try {
        // dynamic import uuid
        const { v4: uuidv4 } = await import('uuid');

        const username = 'admin';
        const password = 'SandiKuat123!';
        const role = 'admin';

        // cek username unik
        const exists = await db.collection('users').where('username', '==', username).limit(1).get();
        if (!exists.empty) throw new Error('Username sudah dipakai');

        const id = uuidv4();
        const password_hash = await bcrypt.hash(password, 12);

        await db.collection('users').doc(id).set({
            id,
            username,
            password_hash,
            role,
            nama_cabang: 'Pusat',
            provinsi: 'DKI Jakarta',
            kota: 'Jakarta',
            jalan: 'Jl. Contoh No.1',
            createdAt: new Date(),
            updatedAt: new Date(),
        });

        console.log('User dibuat:', { id, username, role });
        process.exit(0);
    } catch (err) {
        console.error('Gagal membuat user:', err);
        process.exit(1);
    }
})();
