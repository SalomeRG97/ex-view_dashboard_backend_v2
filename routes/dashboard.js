const express = require('express');
const router  = express.Router();
const {
  getDashboardData,
  getAssets,
} = require('../controllers/dashboardController');

// GET /api/dashboard-data?asset_name=...&total_paneles=...&...
router.get('/dashboard-data', getDashboardData);

// GET /api/assets?q=texto  →  autocomplete
router.get('/assets', getAssets);

module.exports = router;
