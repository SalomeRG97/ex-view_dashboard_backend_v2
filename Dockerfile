FROM node:22

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Dependencias Linux (sistema base + Python 3 + librerías de sistema para pikepdf)
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
    python3 \
    python3-pip \
    python3-venv \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copiar TODO el proyecto primero
COPY . .

# Instalar dependencias Python del pipeline PDF nativo
RUN pip3 install --no-cache-dir --break-system-packages \
    pikepdf>=9.0.0 \
    pdfplumber>=0.11.0 \
    reportlab>=4.2.0 \
    requests>=2.31.0

# Instalar dependencias Node.js
RUN npm install

# Generar Prisma Client
RUN npx prisma generate

# Verificaciones
RUN pdftoppm -v
RUN chromium --version
RUN python3 -c "import pikepdf, pdfplumber, reportlab; print('✅ Python PDF libs OK')"

EXPOSE 3000

CMD ["npm", "start"]