const { doubleCsrf } = require('csrf-csrf');

const {
  generateToken,
  doubleCsrfProtection,
} = doubleCsrf({
  getSecret: () => process.env.CSRF_SECRET || 'csrf-skr1psi-aqua-secret-2025',
  cookieName: '__csrf',
  cookieOptions: {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: false, // false untuk development HTTP
  },
  size: 64,
  getTokenFromRequest: (req) => {
    // Baca dari body._csrf (form EJS)
    return req.body?._csrf || req.headers['x-csrf-token'] || '';
  },
  // Jangan abaikan metode — ini penting utk debugging
  ignoredMethods: [],
});

/**
 * Middleware CSRF untuk Express.
 * Di GET/HEAD/OPTIONS: set token cookie + attach req.csrfToken()
 * Di POST/PUT/DELETE: validasi token
 */
function csrfProtection(req, res, next) {
  // Attach csrfToken() untuk views EJS
  req.csrfToken = () => {
    const token = generateToken(req, res);
    return token;
  };

  // Di method yang tidak merubah state, jangan validasi
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    // Tetap generate token di cookie agar siap dipakai form
    generateToken(req, res);
    return next();
  }

  // Untuk method state-changing, validasi token
  doubleCsrfProtection(req, res, next);
}

module.exports = { csrfProtection };
