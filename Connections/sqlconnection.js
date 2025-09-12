import SQLManager from "../database/MySQLDB.js";
import dotenv from "dotenv";
dotenv.config();
const config = {
  host: process.env.HOST,
  user: process.env.USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DATABASE,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
};
const dbManager = new SQLManager(config);
export default dbManager;
