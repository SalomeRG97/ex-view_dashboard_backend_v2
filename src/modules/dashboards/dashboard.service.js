const repository = require('./dashboard.repository');

class DashboardService {
  async getAllDashboards() {
    return await repository.findAll();
  }

  async getDashboardById(id) {
    const dashboard = await repository.findById(id);
    if (!dashboard) {
      throw new Error('Dashboard no encontrado');
    }
    return dashboard;
  }

  async createDashboard(data) {
    const newDashboard = {
      installationName: data.installationName,
      formData: data.formData 
    };
    return await repository.create(newDashboard);
  }

  async updateDashboard(id, data) {
    await this.getDashboardById(id);
    return await repository.update(id, {
      installationName: data.installationName,
      formData: data.formData
    });
  }

  async deleteDashboard(id) {
    await this.getDashboardById(id);
    return await repository.delete(id);
  }
}

module.exports = new DashboardService();
