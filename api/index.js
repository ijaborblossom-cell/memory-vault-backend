const { app, ensureStorageInitialized } = require('../server');

module.exports = async (req, res) => {
  try {
    await ensureStorageInitialized();
    return app(req, res);
  } catch (error) {
    console.error('Vercel handler init error:', error);
    return res.status(500).json({
      success: false,
      message: 'Server initialization failed'
    });
  }
};
