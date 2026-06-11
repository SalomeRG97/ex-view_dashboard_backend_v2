FROM node:22

# Dependencias Linux (sistema base + Python 3 + librerías de sistema para pikepdf)
RUN apt-get update && apt-get install -y \
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
RUN pip3 install --no-cache-dir --break-system-packages -r pdf_pipeline/requirements.txt

# Instalar dependencias Node.js
RUN npm install

# Generar Prisma Client
RUN npx prisma generate

# Verificaciones
RUN python3 -c "import pikepdf, fitz, reportlab; print('✅ Python PDF libs OK')"

EXPOSE 3000

CMD ["npm", "start"]