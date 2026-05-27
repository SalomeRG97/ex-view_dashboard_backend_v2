const prisma = require('./src/config/database');

async function main() {
  try {
    // Check dashboards
    const count = await prisma.dashboard.count();
    console.log('Total dashboards:', count);
    
    const dashboards = await prisma.dashboard.findMany({
      take: 5,
      select: { id: true, installationName: true }
    });
    console.log('Sample dashboards:', JSON.stringify(dashboards, null, 2));

    // Check specific dashboard from user's URL
    const targetId = 'b8ad55ff-c59f-4131-8729-bd92639b5c90';
    const found = await prisma.dashboard.findUnique({ where: { id: targetId } });
    console.log('Dashboard exists:', found ? 'YES' : 'NO');

    // Check reports
    const reportCount = await prisma.report.count();
    console.log('Total reports:', reportCount);

    const allReports = await prisma.report.findMany({
      include: { sections: true }
    });
    console.log('All reports in DB:', JSON.stringify(allReports, null, 2));

  } catch (e) {
    console.error('DB ERROR:', e.message);
  } finally {
    await prisma.$disconnect();
  }
}

main();
