import cors from "cors";
import express from "express";
import { Agent } from "https";
import cookieParser from "cookie-parser";
import bodyParser from "body-parser";
import path from "path";
import { fileURLToPath } from "url";
const app = express();
const agent = new Agent({ rejectUnauthorized: false });
import post_router from "./Routes/post_routes.js";
import get_router from "./Routes/get_routes.js";
import dbManager from "./Connections/sqlconnection.js";
import "./database/Mail.js";
app.use(
  cors({
    origin: "http://localhost:5173",
    credentials: true,
  })
);
app.use(cookieParser());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// If using bodyParser explicitly
app.use(bodyParser.json({ limit: "50mb" }));
app.use(bodyParser.urlencoded({ limit: "50mb", extended: true }));
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(bodyParser.json());
(async () => {
  try {
    await dbManager.connect();
    console.log("Database connection successful. Starting server...");
    app.listen(5000, "0.0.0.0", () => {
      console.log("listening to server 3000");
    });
  } catch (error) {
    console.error(
      "Failed to connect to the database. Server not started.",
      error
    );
    process.exit(1);
  }
})();
app.use("/", post_router);
app.use("/", get_router);
app.use(express.urlencoded({ extended: true }));
app.use("/files", express.static(path.join(__dirname, "uploads")));
