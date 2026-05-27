FROM node:22

# Instalar dependencias del sistema requeridas para Poppler y Puppeteer
RUN apt-get update && apt-get install -y \
    poppler-utils \
    chromium \
    fonts-liberation \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libxss1 \
    xdg-utils \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Establecer directorio de trabajo
WORKDIR /app

# Copiar archivos de dependencias
COPY package*.json ./

# Instalar dependencias (esto ejecutará postinstall automáticamente)
RUN npm install

# Copiar el resto del código (excepto lo excluido en .dockerignore)
COPY . .

# Generar Prisma Client (por seguridad extra, aunque el postinstall debería hacerlo)
RUN npx prisma generate

# Exponer el puerto
EXPOSE 3000

# Comando de inicio
CMD ["npm", "start"]
