import express from "express";
import { SQLFile } from "../database/SQLFile.js";
import { v4 as uuidv4 } from "uuid";
import {
  connectionCheck,
  system_check,
} from "../middleware/connectionCheck.js";
import multer from "multer";
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, "uploads"),
  filename: (_, file, cb) => cb(null, Date.now() + "-" + file.originalname),
});
const upload = multer({ storage });
const post_router = express.Router();

post_router.post(
  "/admin/Fields",
  (req, res, next) => {
    const { Type, Fields } = req.body;
    if (Type === "Header") {
      req.body.table = "Header_Fields";
    } else {
      req.body.table = "Item_Fields";
    }
    req.body.delFlag = "X";
    const data = Fields?.map((info) => {
      return {
        id: uuidv4(),
        Field_name: info?.fieldTechName,
        field_type: info?.fieldType,
        field_label: info?.name,
      };
    });
    req.body.data = data;
    next();
  },
  SQLFile.insert
);

post_router.post(
  "/admin/doctype",
  (req, res, next) => {
    req.body.table = "document_type";
    const mimetypes = req.body.documents.toString();
    const size = req.body.size;
    const data = { mimetypes, size, id: uuidv4() };
    req.body.data = data;
    req.body.delFlag = "X";
    next();
  },
  SQLFile.insert
);

post_router.post(
  "/signup",
  (req, res, next) => {
    req.body.table = "users";
    next();
  },
  SQLFile.signup
);

post_router.post(
  "/login",
  (req, res, next) => {
    next();
  },
  SQLFile.login
);

post_router.post(
  "/admin/system",
  connectionCheck,
  (req, res, next) => {
    const { system_name, system_port, system_domain, id, is_default } =
      req.body;
    let new_id = id;
    if (!id || id == null || id?.includes("new")) {
      new_id = uuidv4();
    }
    req.body.table = "system_config";
    req.body.data = {
      system_domain,
      system_name,
      system_port,
      id: new_id,
      is_default: is_default ? 1 : 0,
    };
    req.body.delFlag = "";
    next();
  },
  SQLFile.insert
);

post_router.post(
  "/connection/check",
  connectionCheck,
  SQLFile.check_connection
);

post_router.post(
  "/upload",
  (req, res, next) => {
    next();
  },
  upload.single("file"),
  connectionCheck,
  SQLFile.upload
);

post_router.post(
  "/submit",
  connectionCheck,
  system_check,
  (req, res, next) => {
    const { domain, port } = req.body;
    next();
  },
  SQLFile.submit
);

post_router.post(
  "/logout",
  connectionCheck,
  (req, res, next) => {
    req.body.where = { session_id: req.cookies.token };
    req.body.table = "token_table";
    res.clearCookie("token");
    next();
  },
  SQLFile.deleteTableData
);

post_router.post(
  "/prompt",
  connectionCheck,
  upload.single("file"),
  (req, res, next) => {
    next();
  },
  SQLFile.uploadPrompt
);

post_router.post(
  "/message",
  connectionCheck,
  (req, res, next) => {
    next();
  },
  SQLFile.promptData
);
export default post_router;
