const service = require('./dashboard.service');

class DashboardController {
  async getAll(req, res, next) {
    try {
      const dashboards = await service.getAllDashboards();
      res.status(200).json(dashboards);
    } catch (error) {
      next(error);
    }
  }

  async getById(req, res, next) {
    try {
      const dashboard = await service.getDashboardById(req.params.id);
      res.status(200).json(dashboard);
    } catch (error) {
      next(error);
    }
  }

  async create(req, res, next) {
    try {
      const dashboard = await service.createDashboard(req.body);
      res.status(201).json(dashboard);
    } catch (error) {
      next(error);
    }
  }

  async update(req, res, next) {
    try {
      const dashboard = await service.updateDashboard(req.params.id, req.body);
      res.status(200).json(dashboard);
    } catch (error) {
      next(error);
    }
  }

  async delete(req, res, next) {
    try {
      await service.deleteDashboard(req.params.id);
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  }
}

module.exports = new DashboardController();
