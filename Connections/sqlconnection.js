import SQLManager from "../database/MySQLDB.js";
import dotenv from "dotenv";
dotenv.config();
const config = {
  host: process.env.HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DATABASE,
  port: 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
};
console.log(config);
const dbManager = new SQLManager(config);
export default dbManager;
