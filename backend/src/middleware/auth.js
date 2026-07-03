function requireLogin(req, res, next) {
  if (!req.session || !req.session.personId) {
    return res.status(401).json({ error: "Not logged in. Visit /auth/login first." });
  }
  next();
}

module.exports = { requireLogin };
