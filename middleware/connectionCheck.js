import { SQLFile } from "../database/SQLFile.js";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import { Agent } from "https";
import axios from "axios";
const agent = new Agent({ rejectUnauthorized: false });
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

export const system_check = async (req, res, next) => {
  const { domain, port } = req.body;
  const token = req.cookies.token;
  try {
    const response = await SQLFile.get_data1(
      "SELECT csrf_token,cookie FROM token_table WHERE session_id = ? and domain = ? and port = ?",
      [token, domain, port]
    );
    if (response) {
      const serviceUrl = `https://${domain}:${port}/sap/opu/odata/sap/Z_LOGIN_SRV/JsonResponseSet`;
      const tokenResponse = await axios({
        method: "get",
        url: serviceUrl,
        headers: {
          "X-CSRF-Token": response[0][0]?.csrf_token,
          "Content-Type": "application/json",
          Accept: "application/json",
          Cookie: response[0][0]?.cookie,
        },
        httpsAgent: agent,
      });
      if (tokenResponse?.status != 201 || tokenResponse?.status != 200) {
        const response = await SQLFile.delete_data("token_table", {
          session_id: token,
        });
        if (response) {
          const username = "ap_processor";
          const password = "Otvim1234!";
          const serviceUrl = `https://${domain}:${port}/sap/opu/odata/sap/Z_LOGIN_SRV/JsonResponseSet`;
          const tokenResponse = await axios({
            method: "get",
            url: serviceUrl,
            headers: {
              "X-CSRF-Token": "Fetch",
            },
            auth: { username, password },
            httpsAgent: agent,
          });
          if (tokenResponse.status === 200) {
            const csrfToken = tokenResponse.headers.get("x-csrf-token");
            const cookies =
              tokenResponse.headers["set-cookie"]?.join("; ") || "";
            const data = {
              csrf_token: csrfToken,
              cookie: cookies,
              domain,
              port,
              session_id: token,
            };
            const response = await SQLFile.insert_data("token_table", data);
            if (response) {
              next();
            } else {
              throw new Error(`Unable to connect to system ${domain}`);
            }
          }
        } else {
          throw new Error(`Unable to connect to system ${domain}`);
        }
      }
    } else {
      const username = "ap_processor";
      const password = "Otvim1234!";
      const serviceUrl = `https://${domain}:${port}/sap/opu/odata/sap/Z_LOGIN_SRV/JsonResponseSet`;
      console.log(serviceUrl);
      const tokenResponse = await axios({
        method: "get",
        url: serviceUrl,
        headers: {
          "X-CSRF-Token": "Fetch",
        },
        auth: { username, password },
        httpsAgent: agent,
      });
      if (tokenResponse.status === 200) {
        const csrfToken = tokenResponse.headers.get("x-csrf-token");
        const cookies = tokenResponse.headers["set-cookie"]?.join("; ") || "";
        const data = {
          csrf_token: csrfToken,
          cookie: cookies,
          domain,
          port,
          session_id: token,
        };
        const response = await SQLFile.insert_data("token_table", data);
        console.log(response);
        if (response) {
          next();
        } else {
          throw new Error(`Unable to connect to system ${domain}`);
        }
      }
    }
  } catch (error) {
    res.status(500).json({ messageType: "E", message: error.message });
  }
};
