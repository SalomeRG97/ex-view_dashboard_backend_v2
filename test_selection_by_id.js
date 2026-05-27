const prisma = require('./src/config/database');
const reportService = require('./src/modules/reports/report.service');
const fs = require('fs');
const path = require('path');

async function test() {
  try {
    console.log('--- TEST: FILTRADO POR ID Y CORRECCIÓN DE PIE DE PÁGINA ---');

    // 1. Obtener el informe más reciente
    const reports = await prisma.report.findMany({
      include: { sections: true },
      orderBy: { createdAt: 'desc' }
    });

    if (reports.length === 0) {
      console.log('❌ No hay informes en la base de datos.');
      return;
    }

    const report = reports[0];
    console.log(`\n📄 Reporte seleccionado: ${report.originalName} (${report.id}) - Status: ${report.status}`);
    console.log('Secciones encontradas:');
    report.sections.forEach(s => {
      console.log(`- [ID: ${s.id}] Tipo: ${s.type} | Label: ${s.label} | Págs: ${s.pageStart}-${s.pageEnd}`);
    });

    // 2. Simular selección:
    // Busquemos las secciones. Queremos verificar que si hay Soiling / Suciedad y Polvo (ambas con type: soiling),
    // podemos filtrar para incluir SOLAMENTE una de ellas.
    const soilingSections = report.sections.filter(s => s.type === 'soiling');
    console.log(`\nSecciones de tipo 'soiling': ${soilingSections.length}`);

    if (soilingSections.length === 0) {
      console.log('⚠️ No hay secciones de tipo soiling para probar. Probando con todas las secciones menos la primera.');
      if (report.sections.length <= 1) {
        console.log('❌ No hay suficientes secciones para simular un filtrado.');
        return;
      }
    }

    // Seleccionamos solo la primera sección de tipo 'soiling' (que representa Soiling/Suciedad)
    // O si no hay, seleccionamos solo la primera sección cualquiera.
    const selectedSectionIds = [];
    let excludedSection = null;

    if (soilingSections.length > 0) {
      // Tomamos la primera de soiling (Soiling / Suciedad)
      selectedSectionIds.push(soilingSections[0].id);
      if (soilingSections.length > 1) {
        excludedSection = soilingSections[1];
        console.log(`\n👉 Probando inclusion de: "${soilingSections[0].label}" (ID: ${soilingSections[0].id})`);
        console.log(`👉 Probando EXCLUSION de: "${soilingSections[1].label}" (ID: ${soilingSections[1].id})`);
      } else {
        console.log(`\n👉 Probando inclusion de: "${soilingSections[0].label}" (ID: ${soilingSections[0].id})`);
      }
    } else {
      selectedSectionIds.push(report.sections[0].id);
      excludedSection = report.sections[1];
      console.log(`\n👉 Probando inclusion de: "${report.sections[0].label}" (ID: ${report.sections[0].id})`);
      console.log(`👉 Probando EXCLUSION de: "${report.sections[1].label}" (ID: ${report.sections[1].id})`);
    }

    // Si hay más secciones que no son soiling, las incluimos todas para ver la numeración desplazada completa
    report.sections.forEach(s => {
      if (s.type !== 'soiling' && s.id !== report.sections[0].id) {
        selectedSectionIds.push(s.id);
      }
    });

    console.log(`\nGenerando informe filtrado con selectedSectionIds:`, selectedSectionIds);

    // 3. Ejecutar la generación
    const pdfBuffer = await reportService.generateFilteredReport(report.id, {
      selectedSectionIds,
      dashboardName: 'Dashboard de Prueba Solar',
      clientName: 'Cliente Solar S.A.'
    });

    // 4. Guardar archivo final
    const outputPath = path.join(__dirname, 'test_id_output.pdf');
    fs.writeFileSync(outputPath, pdfBuffer);
    console.log(`\n✅ PDF de prueba generado correctamente en: ${outputPath}`);

    if (excludedSection) {
      console.log(`\nVerificación requerida en el PDF generado:`);
      console.log(`1. Verifica que las páginas del PDF original del rango ${excludedSection.pageStart}-${excludedSection.pageEnd} ("${excludedSection.label}") NO estén en el documento.`);
      console.log(`2. Verifica que las páginas de Conclusiones y Certificados se hayan reenumerado correctamente.`);
      console.log(`3. Verifica que los pies de página de estas secciones tengan el fondo blanco y SOLO el nuevo número de página.`);
    }

  } catch (error) {
    console.error('❌ Error ejecutando prueba:', error);
  } finally {
    await prisma.$disconnect();
  }
}

test();
