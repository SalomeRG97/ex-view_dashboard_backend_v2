const sharp = require('sharp');

// Altura del footer a recortar (en píxeles).
// Ajustar según el PDF original.
const DEFAULT_FOOTER_HEIGHT = 80;

class ImageCropService {
  /**
   * Recorta el footer de una imagen y devuelve JPEG.
   * @param {Buffer} imageBuffer - Buffer de la página
   * @param {number|null} footerHeight - Píxeles a cortar desde abajo (o null para cálculo proporcional)
   * @returns {Promise<Buffer>} - Imagen JPEG sin footer
   */
  async cropFooter(imageBuffer, footerHeight = null) {
    const image = sharp(imageBuffer);
    const metadata = await image.metadata();

    // Si no se proporciona un alto específico, calcular proporcionalmente (aprox. 6.33% del alto)
    const actualFooterHeight = footerHeight !== null
      ? footerHeight
      : Math.round(metadata.height * 0.06335);

    const newHeight = metadata.height - actualFooterHeight;

    return await image
      .extract({ left: 0, top: 0, width: metadata.width, height: newHeight })
      .jpeg({ quality: 75, mozjpeg: true })
      .toBuffer();
  }

  /**
   * Recorta un área específica de la imagen (útil para portada, TOC, etc.)
   * @param {Buffer} imageBuffer
   * @param {object} area - { left, top, width, height }
   * @returns {Promise<Buffer>}
   */
  async cropArea(imageBuffer, area) {
    return await sharp(imageBuffer)
      .extract(area)
      .jpeg({ quality: 75, mozjpeg: true })
      .toBuffer();
  }

  /**
   * Redimensiona imagen al ancho deseado manteniendo aspecto.
   * @param {Buffer} imageBuffer
   * @param {number} width
   * @returns {Promise<Buffer>}
   */
  async resize(imageBuffer, width = 1700) {
    return await sharp(imageBuffer)
      .resize({ width, withoutEnlargement: true })
      .jpeg({ quality: 75, mozjpeg: true })
      .toBuffer();
  }
}

module.exports = new ImageCropService();
