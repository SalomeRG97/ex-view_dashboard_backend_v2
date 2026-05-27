const prisma = require('../../config/database');

class DashboardRepository {
  async findAll() {
    return await prisma.dashboard.findMany({
      orderBy: { createdAt: 'desc' }
    });
  }

  async findById(id) {
    return await prisma.dashboard.findUnique({
      where: { id }
    });
  }

  async create(data) {
    return await prisma.dashboard.create({ data });
  }

  async update(id, data) {
    return await prisma.dashboard.update({
      where: { id },
      data
    });
  }

  async delete(id) {
    return await prisma.dashboard.delete({
      where: { id }
    });
  }
}

module.exports = new DashboardRepository();
