-- ============================================================
-- EX-VIEW SOLAR - Dashboard Database Schema
-- ============================================================

-- Table: dashboard_configs
-- Stores generated dashboard tokens and configuration per asset
CREATE TABLE IF NOT EXISTS dashboard_configs (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  token         VARCHAR(64)    NOT NULL UNIQUE,
  asset_name    VARCHAR(255)   NOT NULL,
  total_paneles INT            NOT NULL,
  puntos_calientes INT         NOT NULL,
  capacidad_instalada_mw DECIMAL(10,4) NOT NULL,
  unidad        ENUM('MW','kW') NOT NULL DEFAULT 'MW',
  files_url     TEXT           NULL,
  created_at    DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at    DATETIME       NULL,
  INDEX idx_token (token),
  INDEX idx_asset (asset_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- Reference: Existing table used (READ ONLY)
-- ============================================================
-- TABLE: anomalies
--   asset_name  VARCHAR  - identifies the installation
--   type        VARCHAR  - anomaly type (e.g. "Hotspot", "Bypass Diode", etc.)
--   id          INT      - anomaly record ID
-- ============================================================
