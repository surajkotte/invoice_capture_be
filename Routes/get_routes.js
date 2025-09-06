import express from "express";
import { SQLFile } from "../database/SQLFile.js";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import { connectionCheck } from "../middleware/connectionCheck.js";
dotenv.config();
const get_router = express.Router();

get_router.get(
  "/admin/Fields/:type",
  (req, res, next) => {
    const { type } = req.params;
    res.locals.table = type === "Header" ? "Header_Fields" : "Item_Fields";
    res.locals.columns = "id, field_name, field_label, field_type";
    next();
  },
  SQLFile.get_data
);

get_router.get(
  "/admin/doctype",
  (req, res, next) => {
    res.locals.table = "document_type";
    res.locals.columns = "id, mimetypes, size";
    next();
  },
  SQLFile.get_data
);

get_router.get("/check", (req, res, next) => {
  const token = req.cookies.token;
  if (!token)
    return res.status(401).json({ messageType: "E", message: "Unauthorized" });
  try {
    const decoded = jwt.verify(token, process.env.DECODE_SECRETE);
    const query = "SELECT * FROM users WHERE id = ?";
    const data = { id: decoded?.id };
    if (SQLFile.check_id(query, data))
      res.status(200).json({ messageType: "S" });
    else throw error;
  } catch (err) {
    res.status(403).json({ messageType: "E", message: "Unauthorized" });
  }
});

get_router.get(
  "/admin/system",
  connectionCheck,
  (req, res, next) => {
    res.locals.table = "system_config";
    res.locals.columns = "id, system_name, system_domain, system_port";
    //res.locals.where = { session_id: req.tokenid };
    next();
  },
  SQLFile.get_data
);

get_router.get(
  "/data",
  //  connectionCheck,
  (req, res, next) => {
    next();
  },
  SQLFile.getRegistartionData
);

export default get_router;
