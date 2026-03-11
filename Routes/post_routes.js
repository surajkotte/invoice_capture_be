import express from "express";
import { SQLFile } from "../database/SQLFile.js";
import { v4 as uuidv4 } from "uuid";
import rateLimit from "express-rate-limit";
import {
  connectionCheck,
  system_check,
} from "../middleware/connectionCheck.js";
import multer from "multer";
import { run } from "../util/sceUtil.js";
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, "uploads"),
  filename: (_, file, cb) => cb(null, Date.now() + "-" + file.originalname),
});
const fileFilter = (req, file, cb) => {
  const allowedMimeTypes = [
    "application/pdf",
    "application/xml",
    "text/xml",
    "text/plain",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ];
  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(
      new Error("Invalid file type. Only PDF, XML, TXT, and DOCX are allowed."),
      false,
    );
  }
};
const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 },
});
const post_router = express.Router();
const aiUploadLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minutes timeframe
  max: 10, // Limit each IP to exactly 10 requests per 1 minutes
  keyGenerator: (req, res) => {
    // Assuming your 'connectionCheck' middleware attaches the user's data to req.user
    // If they aren't logged in for some reason, fallback to their IP address
    return req.cookies.token || "unknown";
  },
  message: {
    messageType: "E",
    message:
      "Too many documents processed. To protect system resources, please wait 15 minutes before uploading again.",
  },
  standardHeaders: true, // Sends rate limit info in standard `RateLimit-*` headers
  legacyHeaders: false, // Disables older `X-RateLimit-*` headers
});
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
  SQLFile.insert,
);

post_router.post(
  "/admin/doctype",
  (req, res, next) => {
    req.body.table = "document_type";
    const mimetypes = req.body.documents.toString();
    const size = req.body.size;
    const data = {
      mimetypes,
      size,
      id: uuidv4(),
    };
    req.body.data = data;
    req.body.delFlag = "X";
    next();
  },
  SQLFile.insert,
);

post_router.post(
  "/signup",
  (req, res, next) => {
    req.body.table = "users";
    next();
  },
  SQLFile.signup,
);

post_router.post(
  "/login",
  (req, res, next) => {
    console.log("here");
    next();
  },
  SQLFile.login,
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
  SQLFile.insert,
);

post_router.post(
  "/connection/check",
  connectionCheck,
  SQLFile.check_connection,
);

post_router.post(
  "/upload",
  connectionCheck,
  aiUploadLimiter,
  upload.single("file"),
  async (req, res, next) => {
    try {
      if (!req.file)
        return res.status(400).json({ error: "No file uploaded." });
      const filename = req.file.filename;
      const { hash } = await run(filename);
      req.body.layoutHash = hash;
      next();
    } catch (error) {
      // const fs = require("fs");
      // if (req.file && fs.existsSync(req.file.path))
      //   fs.unlinkSync(req.file.path);
      return res
        .status(500)
        .json({ messageType: "E", message: "Layout processing failed." });
    }
  },
  SQLFile.upload,
);

post_router.post(
  "/submit",
  connectionCheck,
  system_check,
  async (req, res, next) => {
    const { data, sceTemplate } = req.body;
    if (sceTemplate) {
      const { hash } = await run(data?.fileName);
      req.body.layoutHash = hash;
      next();
    } else {
      next();
    }
  },
  SQLFile.submit,
);

post_router.post(
  "/logout",
  (req, res, next) => {
    req.body.where = {
      session_id: req.cookies.token,
    };
    req.body.table = "token_table";
    res.clearCookie("token");
    next();
  },
  SQLFile.deleteTableData,
);

post_router.post(
  "/prompt",
  connectionCheck,
  async (req, res, next) => {
    console.log("in prompt");
    console.log(req);
    const filename = req.body.filename;
    const { hash } = await run(filename);
    req.body.layoutHash = hash;
    next();
  },
  SQLFile.uploadPrompt,
);

post_router.post(
  "/message",
  connectionCheck,
  (req, res, next) => {
    next();
  },
  SQLFile.promptData,
);
post_router.post(
  "/save/prompt",
  async (req, res, next) => {
    const { filename } = req.body;
    const { hash } = await run(filename);
    req.body.layoutHash = hash;
    next();
  },
  SQLFile.savePromptData,
);
post_router.post(
  "/admin/system/delete",
  async (req, res, next) => {
    next();
  },
  SQLFile.delete_systemconfig,
);
export default post_router;
