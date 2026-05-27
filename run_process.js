require('dotenv').config();
const prisma = require('./src/config/database');
const storageService = require('./src/storage/storageFactory');
const processingService = require('./src/modules/reports/services/ReportProcessingService');

async function run() {
  try {
    console.log('--- RUNNING REPORT PROCESSING PIPELINE (TEST) ---');
    const reports = await prisma.report.findMany({
      orderBy: { createdAt: 'desc' },
      take: 1
    });

    if (reports.length === 0) {
      console.error('❌ No se encontró ningún reporte en la base de datos.');
      return;
    }

    const report = reports[0];
    console.log(`Reporte encontrado: ${report.originalName} (${report.id}) - Status actual: ${report.status}`);
    console.log(`Descargando PDF original desde storage: ${report.storagePath}`);

    const buffer = await storageService.download(report.storagePath);
    console.log(`PDF descargado con éxito. Tamaño: ${Math.round(buffer.length / 1024)} KB`);

    console.log('Iniciando procesamiento con ReportProcessingService...');
    // Forzamos el procesamiento
    await processingService.process(report.id, buffer);

    console.log('--- PROCESAMIENTO COMPLETADO ---');

    // Volver a consultar
    const updated = await prisma.report.findUnique({
      where: { id: report.id },
      include: { sections: true }
    });
    console.log(`Reporte actualizado status: ${updated.status}`);
    console.log(`Secciones generadas: ${updated.sections.length}`);
    updated.sections.forEach(s => {
      console.log(`- ${s.label} (${s.type}): Págs ${s.pageStart}-${s.pageEnd}`);
    });

  } catch (error) {
    console.error('❌ Error en el procesamiento:', error);
  } finally {
    await prisma.$disconnect();
  }
}

run();
