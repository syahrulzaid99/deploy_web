require('dotenv').config();
const path = require('path');
const express = require('express');
const expressLayouts = require('express-ejs-layouts');
const fs = require('fs');
const cookieParser = require('cookie-parser');

const app = express();
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// cookie parser (wajib kalau pakai csurf dengan cookie)
app.use(cookieParser())

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use((req, res, next) => {
    res.locals.currentPath = req.path; // mis. "/admin/users"
    res.locals.isActive = (path) => (req.path === path ? 'active' : '');
    res.locals.isPrefix = (prefix) => (req.path.startsWith(prefix) ? 'active' : '');
    next();
});

// aktifkan layouts
app.use(expressLayouts);
app.set('layout', 'layouts/base'); // default layout = views/layouts/base.ejs

// serve file gambar
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

// serve file statis
app.use('/public', express.static(path.join(__dirname, 'public')));

// Routes
const authRoutes = require('./routes/auth.route');
const dashRoutes = require('./routes/dashboard.route');
const usersRoutes = require('./routes/users.route');
const productsRoutes = require('./routes/products.route');
const shipmentsRoutes = require('./routes/shipments.route');
const cabangShipmentsRoutes = require('./routes/cabang/shipments.route');
const cabangOrdersRoutes = require('./routes/cabang_orders.route');
const reportsRoutes = require('./routes/reports.route');
const divisiRoutes = require('./routes/divisi.route');
const adminOrdersRoutes = require('./routes/admin_orders.route');

app.use('/', authRoutes);
app.use('/', dashRoutes);
app.use('/', usersRoutes);
app.use('/', productsRoutes);
app.use('/', shipmentsRoutes);
app.use('/', cabangShipmentsRoutes);
app.use('/', cabangOrdersRoutes);
app.use('/', reportsRoutes);
app.use('/', divisiRoutes);
app.use('/', adminOrdersRoutes);
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// siapkan folder uploads/products
const uploadDir = path.join(__dirname, '..', 'uploads', 'products');
try {
    if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
    }
} catch (e) {
    console.warn('Gagal membuat folder uploads (biasanya karena filesystem read-only di Vercel):', e.message);
}

app.get('/', (req, res) => res.redirect('/dashboard'));

const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
    app.listen(PORT, () => console.log(`App running at http://localhost:${PORT}`));
}

module.exports = app;
