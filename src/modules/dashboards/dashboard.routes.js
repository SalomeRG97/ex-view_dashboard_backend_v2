const { Router } = require('express');
const controller = require('./dashboard.controller');
const { requireAdminAuth } = require('../../middlewares/auth.middleware');

const router = Router();

// Protegemos todas las rutas con el middleware admin
router.use(requireAdminAuth);

router.get('/', controller.getAll);
router.get('/:id', controller.getById);
router.post('/', controller.create);
router.put('/:id', controller.update);
router.delete('/:id', controller.delete);

module.exports = router;
