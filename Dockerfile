FROM node:22

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Dependencias Linux
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
    ca-certificates \
    wget \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copiar TODO el proyecto primero
COPY . .

# Instalar dependencias
RUN npm install

# Generar Prisma Client
RUN npx prisma generate

# Verificaciones
RUN pdftoppm -v
RUN chromium --version

EXPOSE 3000

CMD ["npm", "start"]