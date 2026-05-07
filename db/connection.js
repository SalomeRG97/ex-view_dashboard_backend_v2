const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
  host:     process.env.HOST,
  port:     parseInt(process.env.DB_PORT) || 3306,
  user:     process.env.USER,
  password: process.env.PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit:    10,
  queueLimit:         0,
  timezone: '+00:00',
});

/**
 * Test the database connection on startup.
 */
async function testConnection() {
  try {
    const conn = await pool.getConnection();
    console.log('✅ Connected to MySQL database');
    conn.release();
  } catch (err) {
    console.error('❌ Database connection failed:', err.message);
    process.exit(1);
  }
}

module.exports = { pool, testConnection };
