import { SQLFile } from "../database/SQLFile.js";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
dotenv.config();
export const connectionCheck = async (req, res, next) => {
  const token = req.cookies.token;
  if (!token)
    return res.status(401).json({ messageType: "E", message: "Unauthorized" });
  try {
    const decoded = jwt.verify(token, process.env.DECODE_SECRETE);
    const query = "SELECT * FROM users WHERE id = ?";
    const data = [decoded?.id];
    if (SQLFile.check_id(query, data)) {
      req.tokenid = decoded?.id;
      next();
    } else throw error;
  } catch (err) {
    res.status(403).json({ messageType: "E", message: "Unauthorized" });
  }
};
