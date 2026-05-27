const prisma = require('../../config/database');

class ReportRepository {
  async findByDashboardId(dashboardId) {
    return await prisma.report.findMany({
      where: { dashboardId },
      include: { sections: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findById(id) {
    return await prisma.report.findUnique({
      where: { id },
      include: { sections: true },
    });
  }

  async create(data) {
    return await prisma.report.create({ data });
  }

  async updateStatus(id, status) {
    return await prisma.report.update({
      where: { id },
      data: { status },
    });
  }

  async updateWithSections(id, sections) {
    // Borra secciones anteriores y las reemplaza
    await prisma.reportSection.deleteMany({ where: { reportId: id } });
    return await prisma.report.update({
      where: { id },
      data: {
        status: 'READY',
        sections: {
          create: sections,
        },
      },
      include: { sections: true },
    });
  }

  async delete(id) {
    return await prisma.report.delete({ where: { id } });
  }
}

module.exports = new ReportRepository();
