import dbManager from "../Connections/sqlconnection.js";
import { v4 as uuidv4 } from "uuid";
import bcrypt from "bcrypt";
import JWT from "jsonwebtoken";
import dotenv from "dotenv";
import { Agent } from "https";
import axios from "axios";
import path, { dirname } from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import Anthropic from "@anthropic-ai/sdk";
import normalizeResponseData from "../utils/NormalizeData.js";
import sharp from "sharp";
import FormData from "form-data";
import logLLMUsage from "../utils/UpdateLogs.js";
import {
  extractInvoiceUsingTemplate,
  extractLayoutSignature,
  run,
} from "../util/sceUtil.js";
import logger from "../Connections/Logger.js";
import crypto from "crypto";
const agent = new Agent({ rejectUnauthorized: false });
dotenv.config();
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});
export const SQLFile = {
  async signup(req, res) {
    const { table, data } = req.body;
    const email_address = data?.email;
    const passwordHash = await bcrypt.hash(data?.password, 10);
    const user_Info = {
      username: data?.username,
      password: passwordHash,
      email_address,
      id: uuidv4(),
      created_at: new Date(),
    };
    try {
      const response = await dbManager.insert(table, user_Info, ["id"], false);
      if (response) {
        if (user_Info?.id) {
          const token = JWT.sign(
            { id: user_Info?.id },
            process.env.DECODE_SECRETE,
            {
              expiresIn: "2h",
            },
          );
          res.cookie("token", token);
        }
      } else {
        logger.warn("User already exists");
        throw new Error("User already exist");
      }
      logger.info("User signed up successfully:", user_Info.username);
      res.json({ messageType: "S", data: [] });
    } catch (error) {
      logger.error("Signup error:", error);
      res.status(500).json({ messageType: "E", meessage: error.message });
    }
  },
  async insert(req, res) {
    const { table, data, delFlag } = req.body;
    try {
      const response = await dbManager.insert(
        table,
        data,
        [""],
        delFlag === "X" ? true : false,
      );
      if (response[0]) {
        logger.info("Data inserted successfully", data);
        res.json({ messageType: "S", data: response });
      } else {
        logger.warn("Insert operation did not affect any rows", data);
        throw new Error("Save Failed");
      }
    } catch (error) {
      logger.error("Insert error:", error);
      res.status(500).json({ messageType: "E", meessage: error.message });
    }
  },

  async login(req, res) {
    const { email, password } = req.body;
    try {
      const query = "SELECT * FROM users WHERE email_address = ?";
      const data = [email];
      const response = await dbManager.query(query, data);
      if (response[0].length > 0) {
        const user = response[0][0];
        const isPasswordValid = await bcrypt.compare(password, user.password);
        if (isPasswordValid) {
          logger.info("Password valid for user:", user.username);
          const csrfToken = crypto.randomBytes(32).toString("hex");
          const token = JWT.sign(
            { id: user.id, csrfToken: csrfToken },
            process.env.DECODE_SECRETE,
            {
              expiresIn: "2h",
            },
          );
          res.cookie("token", token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: "strict",
            maxAge: 2 * 60 * 60 * 1000,
          });
          logger.info("User logged in successfully:", user.username);
          res.json({
            messageType: "S",
            data: { username: user.username, csrfToken: csrfToken },
          });
        } else {
          logger.warn("Invalid password attempt for user:", user.username);
          res
            .status(401)
            .json({ messageType: "E", message: "Invalid credentials" });
        }
      } else {
        logger.warn("Login attempt failed", { email });
        res
          .status(401)
          .json({ messageType: "E", message: "Invalid credentials" });
      }
    } catch (error) {
      logger.error("Login error:", error);
      res.status(500).json({ messageType: "E", meessage: error.message });
    }
  },
  async check_id(table, data) {
    try {
      const response = await dbManager.query(table, data);
      if (response[0].length > 0 && response[0][0]?.id) {
        return true;
      } else {
        return false;
      }
    } catch (error) {
      return false;
    }
  },
  async get_data(req, res) {
    const { table, columns, data } = res.locals;
    const { where } = res.locals;
    try {
      let sql;
      let params = [];
      if (!where) {
        sql = `SELECT ${columns || "*"} FROM ${table}`;
      } else {
        const conditions = Object.keys(where)
          .map((key, idx) => `${key} = ?`)
          .join(" AND ");

        sql = `SELECT ${columns || "*"} FROM ${table} WHERE ${conditions}`;
        params = Object.values(where);
      }
      const response = await dbManager.query(sql, params);
      if (response && response.length > 0) {
        res.json({ messageType: "S", data: response[0] });
      } else {
        res.json({ messageType: "E", message: "No data found" });
      }
    } catch (err) {
      res.status(500).json({ messageType: "E", error: err.message });
    }
  },
  async delete(req, res) {
    const { table, where } = req.body;
    try {
      const response = await dbManager.delete(table, where);
      if (response) {
        res.json({ messageType: "S", data: response });
      } else {
        throw new Error("Delete Failed");
      }
    } catch (error) {
      res.status(500).json({ messageType: "E", meessage: error.message });
    }
  },
  async get_system_connections(req, res) {
    const { table, columns } = res.locals;
    try {
      const sql = `SELECT ${columns || "*"} FROM ${table}`;
      const dbresponse = await dbManager.query(sql, []);
      if (!dbresponse || dbresponse[0].length === 0) {
        throw new Error("No system info found");
      }
      const username = process.env.SYSTEM_USER;
      const password = process.env.SYSTEM_PASSWORD;
      const results = await Promise.all(
        dbresponse[0].map(async (systemInfo) => {
          logger.info("Checking connection for system:", {
            system_domain: systemInfo.system_domain,
            system_port: systemInfo.system_port,
          });
          const { system_domain: domain, system_port: port } = systemInfo;
          let connectionStatus = "error";

          try {
            // get csrf_token + cookie for this system
            const tokenRows = await SQLFile.get_data1(
              "SELECT csrf_token,cookie FROM token_table WHERE session_id = ? and domain = ? and port = ?",
              [req.tokenid, domain, port],
            );

            if (tokenRows?.[0]?.length > 0) {
              const tokenData = tokenRows[0][0];

              try {
                const serviceUrl = `https://${domain}:${port}/sap/opu/odata/sap/Z_LOGIN_SRV/JsonResponseSet`;
                const response = await axios({
                  method: "get",
                  url: serviceUrl,
                  headers: {
                    "X-CSRF-Token": tokenData.csrf_token,
                    "Content-Type": "application/json",
                    Accept: "application/json",
                    Cookie: tokenData.cookie,
                  },
                  httpsAgent: agent,
                });

                if (response?.status === 200) {
                  connectionStatus = "active";
                  return { ...systemInfo, connectionStatus };
                }
              } catch (err) {
                // token invalid → delete + fetch new
                await SQLFile.delete_data("token_table", {
                  session_id: req.tokenid,
                  domain,
                  port,
                });

                const serviceUrl = `https://${domain}:${port}/sap/opu/odata/sap/Z_LOGIN_SRV/JsonResponseSet`;
                const tokenResponse = await axios({
                  method: "get",
                  url: serviceUrl,
                  headers: { "X-CSRF-Token": "Fetch" },
                  auth: { username, password },
                  httpsAgent: agent,
                });

                if (tokenResponse.status === 200) {
                  const csrfToken = tokenResponse.headers["x-csrf-token"];
                  const cookies =
                    tokenResponse.headers["set-cookie"]?.join("; ") || "";

                  const data = {
                    csrf_token: csrfToken,
                    cookie: cookies,
                    domain,
                    port,
                    session_id: req.tokenid,
                  };
                  await SQLFile.insert_data("token_table", data);

                  connectionStatus = "active";
                  return { ...systemInfo, connectionStatus };
                }
              }
            } else {
              const serviceUrl = `https://${domain}:${port}/sap/opu/odata/sap/Z_LOGIN_SRV/JsonResponseSet`;
              const tokenResponse = await axios({
                method: "get",
                url: serviceUrl,
                headers: { "X-CSRF-Token": "Fetch" },
                auth: { username, password },
                httpsAgent: agent,
              });

              if (tokenResponse.status === 200) {
                const csrfToken = tokenResponse.headers["x-csrf-token"];
                const cookies =
                  tokenResponse.headers["set-cookie"]?.join("; ") || "";

                const data = {
                  csrf_token: csrfToken,
                  cookie: cookies,
                  domain,
                  port,
                  session_id: req.tokenid,
                };
                await SQLFile.insert_data("token_table", data);

                connectionStatus = "active";
              }
            }
          } catch (err) {
            connectionStatus = "error";
          }

          return { ...systemInfo, connectionStatus };
        }),
      );
      return res.json({
        messageType: "S",
        data: results,
      });
    } catch (error) {
      return res.json({ messageType: "E", message: error?.message });
    }
  },
  async delete_systemconfig(req, res) {
    try {
      const { id } = req.body;
      const response = await dbManager.query(
        "select * from system_config where id = ?",
        [id],
      );
      logger.info("in delete system config", response);
      if (response[0][0]) {
        const response1 = await dbManager.delete("system_config", { id: id });
        logger.info("in delete system config response1", response1);
        if (response1 && response1[0]) {
          return res.status(200).json({ messageType: "S", data: response1[0] });
        } else {
          throw new Error("No data found with");
        }
      } else {
        throw new Error("No data found with");
      }
    } catch (error) {
      return res.status(500).json({ messageType: "E", message: error.message });
    }
  },
  async check_connection(req, res) {
    const { id } = req.body;
    const username = process.env.SYSTEM_USER;
    const password = process.env.SYSTEM_PASSWORD;

    try {
      const dbresponse = await dbManager.query(
        "SELECT * FROM system_config WHERE id = ?",
        [id],
      );

      if (!dbresponse[0] || dbresponse[0].length === 0) {
        logger.warn("System not found for ID:", id);
        throw new Error("System not found. Please save first");
      }

      const { system_domain: domain, system_port: port } = dbresponse[0][0];
      let connectionStatus = "error";

      try {
        // check if token exists in table
        const tokenRows = await dbManager.query(
          "SELECT csrf_token,cookie FROM token_table WHERE session_id = ? AND domain = ? AND port = ?",
          [req.tokenid, domain, port],
        );

        if (tokenRows?.[0]?.length > 0) {
          const tokenData = tokenRows[0][0];
          try {
            const serviceUrl = `https://${domain}:${port}/sap/opu/odata/sap/Z_LOGIN_SRV/JsonResponseSet`;
            const response = await axios({
              method: "get",
              url: serviceUrl,
              headers: {
                "X-CSRF-Token": tokenData.csrf_token,
                "Content-Type": "application/json",
                Accept: "application/json",
                Cookie: tokenData.cookie,
              },
              httpsAgent: agent,
            });

            if (response?.status === 200) {
              connectionStatus = "active";
              logger.info("Connection check successful for system:", {
                domain,
                port,
              });
              return res.status(200).json({
                messageType: "S",
                data: { ...dbresponse[0][0], connectionStatus },
              });
            }
          } catch (err) {
            logger.warn("Connection check failed for system:", {
              domain,
              port,
              error: err.message,
            });
            // token invalid → delete + fetch new
            await SQLFile.delete_data("token_table", {
              session_id: req.tokenid,
              domain,
              port,
            });
          }
        }

        // if no valid token → fetch new one
        const serviceUrl = `https://${domain}:${port}/sap/opu/odata/sap/Z_LOGIN_SRV/JsonResponseSet`;
        const tokenResponse = await axios({
          method: "get",
          url: serviceUrl,
          headers: { "X-CSRF-Token": "Fetch" },
          auth: { username, password },
          httpsAgent: agent,
        });

        if (tokenResponse.status === 200) {
          logger.info(
            "New token fetched successfully for system in check_connection:",
            { domain, port },
          );
          const csrfToken = tokenResponse.headers["x-csrf-token"];
          const cookies = tokenResponse.headers["set-cookie"]?.join("; ") || "";

          const data = {
            csrf_token: csrfToken,
            cookie: cookies,
            domain,
            port,
            session_id: req.tokenid,
          };
          await SQLFile.insert_data("token_table", data);

          connectionStatus = "active";
        }
      } catch (err) {
        logger.error(
          "Error during connection check for system in check_connection:",
          { domain, port, error: err.message },
        );
        connectionStatus = "error";
      }
      logger.info(
        "Connection check completed for system in check_connection:",
        { domain, port, connectionStatus },
      );
      return res.status(200).json({
        messageType: "S",
        data: { ...dbresponse[0][0], connectionStatus },
      });
    } catch (error) {
      logger.error("Error in check_connection:", error);
      return res.status(500).json({ messageType: "E", message: error.message });
    }
  },
  async fetchFields(req, res) {
    try {
      const response1 = await dbManager.query(
        "SELECT * FROM header_fields",
        [],
      );
      const response2 = await dbManager.query("SELECT * FROM item_fields", []);
      const Header_Fields =
        response1[0]?.map((info) => {
          return info?.field_label;
        }) || [];
      const Item_Fields =
        response2[0]?.map((info) => {
          return info?.field_label;
        }) || [];
      logger.info("Fetched header and item fields successfully", {
        Header_Fields,
        Item_Fields,
      });
      res.json({ messageType: "S", data: { Header_Fields, Item_Fields } });
    } catch (error) {
      logger.error("Error fetching fields:", error);
      res.status(500).json({ messageType: "E", message: error.message });
    }
  },
  async upload(req, res) {
    try {
      const file_path = req.file.path;
      const { layoutHash } = req.body;
      const ext = path.extname(req.file.originalname).toLowerCase();
      let mediaType;
      let base64DataArray = [];

      switch (ext) {
        case ".pdf":
          mediaType = "application/pdf";
          break;
        case ".xml":
          mediaType = "application/xml";
          break;
        case ".txt":
          mediaType = "text/plain";
          break;
        case ".docx":
          mediaType =
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
          break;
        default:
          return res.status(400).json({ error: "Unsupported file type" });
      }
      let extractionResult;
      // if (ext === ".pdf") {
      //   // const processedPages = await convertPdfToOptimizedBase64(pdfPath);
      //   // base64DataArray = processedPages.map((p) => ({
      //   //   type: "image",
      //   //   source: {
      //   //     type: "base64",
      //   //     media_type: p.mediaType,
      //   //     data: p.base64Data,
      //   //   },
      //   // }));
      //   let {hash, pdfBytes, pdfDoc} = await run(req.file.filename);
      //   console.log(hash)
      //      const sceHash = await dbManager.query(
      //     "SELECT id FROM invoice_templates WHERE layout_hash = ?",
      //     [hash]
      //   );
      //   console.log(sceHash +"sce hash")

      //   if(sceHash[0] && sceHash[0][0]){
      //     const selectionFields = await dbManager.query("SELECT field_key, field_label, page_number, top_pos,left_pos, width, height FROM template_fields WHERE template_id = ?", [sceHash[0][0].id]);
      //     console.log(sceHash[0][0].id, "template id")
      //     console.log(selectionFields, "selection fields")
      //     try{
      //      extractionResult = await extractInvoiceUsingTemplate(pdfBytes, selectionFields[0], pdfDoc);
      //     }catch(err){
      //       console.log(err, "error in extraction using template")
      //     }

      //   }

      // }

      let contentBlocks = [];
      let prompttext = "";
      const promptresponse = await dbManager.query(
        "SELECT * FROM prompt_data WHERE layout_hash = ?",
        [layoutHash],
      );
      logger.log("prompt response", promptresponse);
      if (promptresponse[0] && promptresponse[0][0]) {
        prompttext = promptresponse[0][0]?.prompts || "";
      }
      logger.info("prompt text", prompttext);
      const response1 = await dbManager.query(
        "SELECT * FROM Header_Fields",
        [],
      );
      const response2 = await dbManager.query("SELECT * FROM Item_Fields", []);

      const Header_Fields =
        response1[0]?.map((info) => info?.field_label) || [];
      const Item_Fields = response2[0]?.map((info) => info?.field_label) || [];
      logger.info("Sending", base64DataArray.length, "pages to Claude...");
      logger.info("ext type in upload:", ext);
      const fileBuffer = fs.readFileSync(file_path);
      // const base64Data = fileBuffer.toString("base64");
      let rawText = "";
      if (ext === ".xml" || ext === ".txt") {
        rawText = fileBuffer.toString("utf-8");
        contentBlocks.push({
          type: "text",
          text: `Here is the source ${ext.toUpperCase()} content:\n\n${rawText}`,
        });
      } else {
        //for pdf files
        const base64Data = fileBuffer.toString("base64");
        contentBlocks.push({
          type: "document",
          source: {
            type: "base64",
            media_type: mediaType,
            data: base64Data,
          },
        });
      }
      //       const response = await anthropic.messages.create({
      //         model: "claude-sonnet-4-20250514",
      //         max_tokens: 20000,
      //         temperature: 1,
      //         messages: [
      //           {
      //             role: "user",
      //             content: [
      //               {
      //                 type: "document",
      //                 source: {
      //                   type: "base64",
      //                   media_type: mediaType,
      //                   data: base64Data,
      //                 },
      //               },
      //               // ...base64DataArray,
      //               {
      //                 type: "text",
      //                 text: `
      // Place all header-related fields inside an object named "header_fields" using the exact field names defined in ${Header_Fields}.
      // Place all item-related fields inside an array named "item_fields" using the exact field names defined in ${Item_Fields}.

      // Follow these rules strictly:
      // - Extract **all** line items (even if partially readable).
      // - The JSON structure must be valid and properly formatted.
      // - If any text is not in English, translate it to English before inserting into JSON.
      // - Put the currency code or symbol (e.g., "USD", "EUR", "INR") **only** in the "currency" field.
      // - Keep numeric values as pure numbers — do **not** include currency symbols or text.
      // - ✅ Ensure tax fields are correctly extracted:
      //   - "tax_rate" → numeric value (e.g., 18)
      //   - "tax_code" → alphanumeric code (e.g., "V1")
      // - Field names must match exactly with those in ${Header_Fields} and ${Item_Fields}, with no underscores or variations.
      // - The "header_fields" object must contain only header-level fields.
      // - The "item_fields" array must contain all extracted line items.
      // - No additional fields, notes, or metadata should be added.
      // - Do not infer or invent any values not present in the document. If a field is missing, set it to an empty string ("").
      // - "Payment Terms" must be a 4-character alphanumeric value — not a description.
      // - Extract data exactly as it appears in the document (except translations when needed).
      // `,
      //               },
      //             ],
      //           },
      //         ],
      //       });

      //       contentBlocks.push({
      //         type: "text",
      //         text: `
      // Place all header-related fields inside an object named "header_fields" using the exact field names defined in ${Header_Fields}.
      // Place all item-related fields inside an array named "item_fields" using the exact field names defined in ${Item_Fields}.

      // Follow these rules strictly:
      // - Extract **all** line items (even if partially readable).
      // - The JSON structure must be valid and properly formatted.
      // - If any text is not in English, translate it to English before inserting into JSON.
      // - Keep numeric values as pure numbers — do **not** include currency symbols or text.
      // - Ensure tax fields are correctly extracted:
      //   - "tax_rate" → numeric value (e.g., 18)
      //   - "tax_code" → alphanumeric code (e.g., "V1")
      // - Header field gross amount and Item level gross amounts are not same. Header gross amount is generally the sum of all line item gross amounts plus/minus any additional charges/discounts/taxes. So, always ensure to extract the exact gross amount as shown in the Header for the Header gross amount field, and the exact gross amount for each line item as shown in the document for the Item level gross amounts.
      // - Field names must match exactly with those in ${Header_Fields} and ${Item_Fields}, with no underscores or variations.
      // - Put the currency code or symbol (e.g., "USD", "EUR", "INR") **only** in the "Currency" fields of both header and item fields.
      // - If theres a currency Symbol in the document, make sure to extract the currency code(ISO) and put it in the "Currency" field. For example, if the document shows "$100", extract "USD" and put it in the "Currency" field, while keeping the numeric value as "100" in the relevant amount field.
      // - In case currency not detected in Header but in the line items then fill currency from line item to Header
      // - The "header_fields" object must contain only header-level fields.
      // - The "item_fields" array must contain all extracted line items.
      // - No additional fields, notes, or metadata should be added.
      // - Do not infer or invent any values not present in the document. If a field is missing, set it to an empty string ("").
      // - "Payment Terms" must be a 4-character alphanumeric value — not a description.
      // - Extract data exactly as it appears in the document (except translations when needed).
      // - Check if company name and vendor are correct.In general vendor name is who is delivering goods or services and company name is who is receiving goods or services. So, if the document is an invoice, then vendor name is generally the name of the supplier and company name is generally the name of the buyer. But in case of credit note its generally opposite. So, based on the context of the document, make sure to correctly identify and extract vendor name and company name in the relevant fields.
      // - ${prompttext}
      // `,
      // });
      let system_prompt = `
Place all header-related fields inside an object named "header_fields" using the exact field names defined in ${Header_Fields}.  
Place all item-related fields inside an array named "item_fields" using the exact field names defined in ${Item_Fields}.  

Follow these rules strictly:
- Extract **all** line items (even if partially readable).
- The JSON structure must be valid and properly formatted.
- If any text is not in English, translate it to English before inserting into JSON.
- Keep numeric values as pure numbers — do **not** include currency symbols or text.
- Ensure tax fields are correctly extracted:
  - "tax_rate" → numeric value (e.g., 18)
  - "tax_code" → alphanumeric code (e.g., "V1")
- Header field gross amount and Item level gross amounts are not same. Header gross amount is generally the sum of all line item gross amounts plus/minus any additional charges/discounts/taxes. So, always ensure to extract the exact gross amount as shown in the Header for the Header gross amount field, and the exact gross amount for each line item as shown in the document for the Item level gross amounts.
- Field names must match exactly with those in ${Header_Fields} and ${Item_Fields}, with no underscores or variations.
- Put the currency code or symbol (e.g., "USD", "EUR", "INR") **only** in the "Currency" fields of both header and item fields.
- If theres a currency Symbol in the document, make sure to extract the currency code(ISO) and put it in the "Currency" field. For example, if the document shows "$100", extract "USD" and put it in the "Currency" field, while keeping the numeric value as "100" in the relevant amount field.
- In case currency not detected in Header but in the line items then fill currency from line item to Header
- The "header_fields" object must contain only header-level fields.
- The "item_fields" array must contain all extracted line items.
- No additional fields, notes, or metadata should be added.
- Do not infer or invent any values not present in the document. If a field is missing, set it to an empty string ("").
- "Payment Terms" must be a 4-character alphanumeric value — not a description.
- Extract data exactly as it appears in the document (except translations when needed).
- Check if company name and vendor are correct.In general vendor name is who is delivering goods or services and company name is who is receiving goods or services. So, if the document is an invoice, then vendor name is generally the name of the supplier and company name is generally the name of the buyer. But in case of credit note its generally opposite. So, based on the context of the document, make sure to correctly identify and extract vendor name and company name in the relevant fields.
- ${prompttext}
`;
      const startTime = Date.now();
      logger.info(
        "Sending content to Claude for extraction with system prompt",
        { system_prompt, fileName: req.file.filename },
      );
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 20000,
        temperature: 0,
        system: system_prompt,
        messages: [{ role: "user", content: contentBlocks }],
      });
      logger.info("Received response from Claude");
      const processingTimeMs = Date.now() - startTime;
      const inputTokens = response.usage?.input_tokens || 0;
      const outputTokens = response.usage?.output_tokens || 0;
      const inputCost = (inputTokens / 1_000_000) * 3.0;
      const outputCost = (outputTokens / 1_000_000) * 15.0;
      const totalCost = inputCost + outputCost;
      const extractedText = response.content[0].text || "";
      const jsonMatch = extractedText.match(/```json([\s\S]*?)```/);
      const jsonObject = jsonMatch ? JSON.parse(jsonMatch[1]) : {};
      // if(extractionResult){
      //   Object.keys(extractionResult).forEach((key) => {
      //     jsonObject.header_fields[key] = extractionResult[key];
      //   });
      // }
      const session_doc_id = uuidv4();
      logger.info("Logging LLM usage for document extraction", {
        model: "claude-sonnet-4-20250514",
        processingTimeMs,
      });
      logger.info("extraction successful for file", {
        fileName: req.file.filename,
        session_doc_id,
      });
      logLLMUsage(dbManager, {
        response,
        model: "claude-sonnet-4-20250514",
        processingTimeMs: processingTimeMs,
        fileType: ext,
        fileName: req.file.filename,
        userName: "ExtractionSystem",
        channel: "extraction",
        sessionDocId: session_doc_id,
      });
      res.json({
        messageType: "S",
        data: jsonObject,
        fileName: req.file.filename,
        text_data: rawText,
        base64Files: contentBlocks[0]?.source?.data || rawText,
        fileType: ext,
        fileSize: req.file.size,
        log_data: {
          id: uuidv4(),
          processingTimeMs,
          inputTokens,
          outputTokens,
          model: "claude-sonnet-4-20250514",
          totalCost,
          session_doc_id,
        },
      });
    } catch (error) {
      logger.error("Error uploading document:", error);
      res.status(500).json({ error: "Failed to upload document" });
    }
  },
  async submit(req, res) {
    const { data, domain, port, layoutHash, sceTemplate } = req.body;
  
    const tokenid = req.tokenid;
    const token = req.cookies.token;
    try {
      logger.info("in submit");
      const query = "SELECT * FROM users WHERE id = ?";
      const user = await dbManager.query(query, [tokenid]);
      const userName = user[0][0]?.username || "";
      if (sceTemplate && false) {
        logger.info("in sce template" + sceTemplate);
        const sceHash = await dbManager.query(
          "SELECT * FROM invoice_templates WHERE layout_hash = ?",
          [layoutHash],
        );
        if (sceHash[0].length > 0) {
          const updateHash = sceHash[0][0]?.layout_hash || "";
          if (layoutHash !== updateHash) {
            await dbManager.update(
              "invoice_templates",
              { layout_hash: layoutHash },
              { template_name: sceTemplate },
            );
          } else {
            console.log("Template already exists with the same layout hash.");
            const template_fields = await dbManager.query(
              "SELECT * FROM template_fields WHERE template_id = ?",
              [sceHash[0][0]?.id],
            );
            const last_inedx = template_fields[0]?.length || 0;
            const fieldMappings = Object.entries(sceTemplate).map(
              ([fieldLabel, fieldValue], index) => {
                console.log(fieldLabel, "field label");
                console.log(fieldValue, "field value");
                return {
                  id:
                    template_fields[0]?.find(
                      (f) => f.field_label === fieldLabel,
                    )?.id || last_inedx + index + 1,
                  template_id: sceHash[0][0]?.id,
                  page_number: fieldValue.page,
                  bottom_pos: fieldValue.rect[0].bottom_pos,
                  left_pos: fieldValue.rect[0].left_pos,
                  width: fieldValue.rect[0].width,
                  height: fieldValue.rect[0].height,
                  field_label: fieldLabel,
                  created_at: new Date(),
                };
              },
            );
            await dbManager.insert(
              "template_fields",
              fieldMappings,
              ["template_id"],
              false,
            );
          }
        } else {
          const new_id = uuidv4();
          const response = await dbManager.insert(
            "invoice_templates",
            {
              id: new_id,
              template_name: "",
              created_at: new Date(),
              layout_hash: layoutHash,
            },
            ["id"],
            false,
          );
          if (true) {
            const fieldMappings = Object.entries(sceTemplate).map(
              ([fieldLabel, fieldValue], index) => ({
                id: index + 1,
                template_id: new_id,
                page_number: fieldValue.page,
                bottom_pos: fieldValue.rect[0].bottom_pos,
                left_pos: fieldValue.rect[0].left_pos,
                width: fieldValue.rect[0].width,
                height: fieldValue.rect[0].height,
                field_label: fieldLabel,
                created_at: new Date(),
              }),
            );

            await dbManager.insert(
              "template_fields",
              fieldMappings,
              ["template_id"],
              false,
            );
          } else {
            console.error("Failed to insert template.");
          }
        }
      }
      const response = await dbManager.query(
        "SELECT csrf_token,cookie FROM token_table WHERE session_id = ? and domain = ? and port = ?",
        [token, domain, port],
      );
      const headerfields = await dbManager.query(
        "SELECT * FROM Header_Fields where field_type = ?",
        ["Date"],
      );
      headerfields[0].forEach((field) => {
        const fieldKey = field.Field_name;
        if (data.headerData && data.headerData[fieldKey]) {
          const fieldValue = data.headerData[fieldKey];
          logger.info("Field value before date formatting:", fieldValue);
          const parts = fieldValue.split("/");
          const date = new Date(parts[2], parts[1] - 1, parts[0]);

          logger.info("Parsed date:", date);

          if (!isNaN(date.getTime())) {
            // Use .getTime() for a more robust check
            const yyyy = date.getFullYear();
            const mm = String(date.getMonth() + 1).padStart(2, "0");
            const dd = String(date.getDate()).padStart(2, "0");

            const formattedDate = `${yyyy}${mm}${dd}`;
            data.headerData[fieldKey] = formattedDate;
          }
        }
      });
      if (response[0].length > 0) {
        const serviceUrl = `https://${domain}:${port}/sap/opu/odata/sap/Z_LOGIN_SRV/JsonResponseSet`;
        const payload = {
          Id: "1",
          payload: JSON.stringify({ data: data }),
        };
        const postResponse = await axios({
          method: "POST",
          url: `${serviceUrl}`,
          headers: {
            "X-CSRF-Token": response[0][0]?.csrf_token,
            "Content-Type": "application/json",
            Accept: "application/json",
            Cookie: response[0][0]?.cookie,
          },
          httpsAgent: agent,
          data: JSON.stringify(payload),
        });
        logger.info("Post response status:", postResponse.status);
        if (postResponse.status === 201) {
          const payloadStr = postResponse?.data?.d?.payload;
          let payload = {};

          if (payloadStr) {
            payload = JSON.parse(payloadStr);
          }

          const regid = payload.regid;
          const fileName = payload.filename;
          const fileType = payload.filetype;
          const fileSize = payload.filesize;
          const post_data = {
            id: uuidv4(),
            document_id: regid,
            domain: domain,
            port: port,
            created_user: userName,
            file_name: fileName,
            file_type: fileType,
            file_size: fileSize,
            system_name: domain,
            created_date: new Date(),
          };
          const db_response = await dbManager.insert(
            "registration_data",
            post_data,
            ["id"],
            false,
          );
          if (db_response) {
            const log_response_data = {
              id: data?.log_data?.id,
              document_id: regid,
              model_name: data?.log_data?.model,
              output_tokens: data?.log_data?.outputTokens,
              input_tokens: data?.log_data?.inputTokens,
              processing_time_ms: data?.log_data?.processingTimeMs,
              total_cost: data?.log_data?.totalCost,
              created_at: new Date(),
              file_type: fileType,
              channel: "submit",
              file_name: fileName,
              created_user: userName,
              session_doc_id: data?.log_data?.session_doc_id,
            };
            const db_logresponse = await dbManager.insert(
              "api_usage_logs",
              log_response_data,
              ["id"],
              false,
            );
            logger.info(
              "Data submitted and logged successfully for document ID:",
              {
                session_doc_id: data?.log_data?.session_doc_id,
                document_id: regid,
                file_name: fileName,
                file_type: fileType,
                created_user: userName,
              },
            );
            res.json({ messageType: "S", data: post_data });
          } else {
            logger.error(
              "Failed to insert registration data into database for document ID:",
              regid,
            );
            throw new Error("Failed to submit data");
          }
        } else {
          logger.info("Failed to submit data:", {
            status: postResponse.status,
            data: postResponse.data,
          });
          throw new Error("Failed to submit data");
        }
      } else {
        logger.warn(
          "No valid session found for user during submit operation. Session may have expired.",
          { token, domain, port },
        );
        throw new Error(" Session expired. Please log in again.");
      }
    } catch (error) {
      logger.error("Error in submit operation:", error);
      res.status(500).json({ messageType: "E", meessage: error.message });
    }
  },
  async getRegistartionData(req, res) {
    const pageNumber = req?.query?.page || 1;
    const filters = req?.query?.filters ? JSON.parse(req.query.filters) : {};
    const regidorusername = filters?.searchTerm || "";
    const dateFrom = filters?.dateRange?.from
      ? new Date(filters.dateRange.from)
      : null;
    const dateTo = filters?.dateRange?.to
      ? new Date(filters.dateRange.to)
      : null;
    const documentType = filters?.documentType || "";
    logger.info("Filters in get registration data:", filters);
    const itemsPerPage = 20;
    const offSet = (pageNumber - 1) * itemsPerPage;
    let whereConditions = [];
    let queryParams = [];

    if (regidorusername) {
      whereConditions.push(
        `(document_id LIKE ? OR created_user LIKE ? OR system_name LIKE ?)`,
      );
      const likeTerm = `%${regidorusername}%`;
      queryParams.push(likeTerm, likeTerm, likeTerm);
    }

    if (documentType) {
      whereConditions.push(`file_type = ?`);
      queryParams.push(`.${documentType}`);
    }

    if (dateFrom && dateTo) {
      whereConditions.push(`created_date BETWEEN ? AND ?`);
      queryParams.push(dateFrom, dateTo);
    } else if (dateFrom) {
      whereConditions.push(`created_date >= ?`);
      queryParams.push(dateFrom);
    } else if (dateTo) {
      whereConditions.push(`created_date <= ?`);
      queryParams.push(dateTo);
    }
    let whereString = "";
    if (whereConditions.length > 0) {
      whereString = "WHERE " + whereConditions.join(" AND ");
    }
    const dataParams = [...queryParams, itemsPerPage, offSet];
    try {
      const countResponse = await dbManager.query(
        `select count(*) as count from  registration_data ${whereString}`,
        queryParams,
      );
      const response = await dbManager.query(
        `SELECT * FROM registration_data ${whereString} ORDER BY document_id LIMIT ? OFFSET ?`,
        dataParams,
      );
      const totCount = countResponse[0]?.[0]?.count;
      logger.info("Total registration data count:", totCount);
      const data_response = {
        data: response[0],
        totalCount: totCount,
      };
      if (response) {
        logger.info("Fetched registration data successfully with filters", {
          filters,
          totalCount: totCount,
        });
        res.json({ messageType: "S", data: data_response });
      } else {
        logger.warn("Failed to fetch registration data with provided filters", {
          filters,
          error: "No data returned from database",
        });
        throw new Error("Fetch Failed");
      }
    } catch (error) {
      logger.error("Error fetching registration data:", error);
      res.status(500).json({ messageType: "E", meessage: error.message });
    }
  },
  async deleteTableData(req, res) {
    const { table, where } = req.body;
    try {
      const response = await dbManager.delete(table, where);
      if (response) {
        res.json({ messageType: "S", data: response });
      } else {
        throw new Error("Delete Failed");
      }
    } catch (error) {
      res.status(500).json({ messageType: "E", meessage: error.message });
    }
  },
  async get_data1(table, data) {
    try {
      const response = await dbManager.query(table, data);
      if (response[0].length > 0 && response[0][0]?.id) {
        return response[0];
      } else {
        return false;
      }
    } catch (error) {
      return false;
    }
  },

  async delete_data(table, where) {
    try {
      const response = await dbManager.delete(table, where);
      if (response) {
        return true;
      } else {
        throw new Error("not bale to delete");
      }
    } catch (err) {
      return false;
    }
  },

  async insert_data(table, user_Info) {
    try {
      const response = await dbManager.insert(table, user_Info);
      if (response[0]?.length != 0) {
        return true;
      } else {
        throw new Error("Unable to insert data");
      }
    } catch (err) {
      return false;
    }
  },
  async uploadPrompt(req, res) {
    try {
      const prompt = req.body.prompt;
      const { layoutHash } = req.body;
      const ext = path.extname(req.body.filename).toLowerCase();
      let mediaType;

      switch (ext) {
        case ".pdf":
          mediaType = "application/pdf";
          break;
        case ".xml":
          mediaType = "application/xml";
          break;
        case ".txt":
          mediaType = "text/plain";
          break;
        case ".docx":
          mediaType =
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
          break;
        default:
          return res.status(400).json({ error: "Unsupported file type" });
      }
      logger.info("Layout hash in upload prompt:", layoutHash);
      const promptsdata = await dbManager.query(
        "SELECT * FROM prompt_data WHERE layout_hash = ?",
        [layoutHash],
      );
      logger.info("Prompts data fetched:", promptsdata);
      let promptText = "";
      if (promptsdata[0] && promptsdata[0][0]) {
        promptText = promptsdata[0][0]?.prompts || "";
      }
      promptText += "\n" + prompt;
      logger.info("Prompt from request:", prompt);
      logger.info("Final prompt text:", promptText);
      const response1 = await dbManager.query(
        "SELECT * FROM Header_Fields",
        [],
      );
      const response2 = await dbManager.query("SELECT * FROM Item_Fields", []);
      const Header_Fields =
        response1[0]?.map((info) => {
          return info?.field_label;
        }) || [];
      const Item_Fields =
        response2[0]?.map((info) => {
          return info?.field_label;
        }) || [];
      const base64Data = req.body.base64file;
      const modelToUse = "claude-sonnet-4-20250514"; // Keeping your original model
      let contentBlocks = [];
      logger.log(
        "Preparing content blocks for Claude with uploaded prompt and file",
        {
          promptText,
          fileType: ext,
        },
      );
      if (ext === ".xml" || ext === ".txt") {
        let rawText = base64Data;
        contentBlocks.push({
          type: "text",
          text: `Here is the source ${ext.toUpperCase()} content:\n\n${rawText}`,
        });
      } else {
        //for pdf files
        contentBlocks.push({
          type: "document",
          source: {
            type: "base64",
            media_type: mediaType,
            data: base64Data,
          },
        });
      }
      logger.info("Content blocks prepared for Claude:", contentBlocks);
      //       const response = await anthropic.messages.create({
      //         model: modelToUse,
      //         max_tokens: 20000,
      //         temperature: 1,
      //         messages: [
      //           {
      //             role: "user",
      //             content: [
      //               {
      //                 type: "document",
      //                 source: {
      //                   type: "base64",
      //                   media_type: mediaType,
      //                   data: base64Data,
      //                 },
      //                 cache_control: { type: "ephemeral" }
      //               },
      //               {
      //                 type: "text",
      //                 text: `Place all header-related fields inside an object named "header_fields" using the exact field names defined in ${Header_Fields}.
      // Place all item-related fields inside an array named "item_fields" using the exact field names defined in ${Item_Fields}.

      // Follow these rules strictly:
      // - ${promptText}
      // - Extract **all** line items (even if partially readable).
      // - The JSON structure must be valid and properly formatted.
      // - If any text is not in English, translate it to English before inserting into JSON.
      // - Put the currency code or symbol (e.g., "USD", "EUR", "INR") **only** in the "currency" field.
      // - Keep numeric values as pure numbers — do **not** include currency symbols or text.
      // - ✅ Ensure tax fields are correctly extracted:
      //   - "tax_rate" → numeric value (e.g., 18)
      //   - "tax_code" → alphanumeric code (e.g., "V1")
      // - Field names must match exactly with those in ${Header_Fields} and ${Item_Fields}, with no underscores or variations.
      // - The "header_fields" object must contain only header-level fields.
      // - The "item_fields" array must contain all extracted line items.
      // - No additional fields, notes, or metadata should be added.
      // - Do not infer or invent any values not present in the document. If a field is missing, set it to an empty string ("").
      // - "Payment Terms" must be a 4-character alphanumeric value — not a description.
      // - Extract data exactly as it appears in the document (except translations when needed).
      // `,
      //               },
      //             ],
      //           },
      //         ],
      //       });
      //       contentBlocks.push({
      //         type: "text",
      //         text: `
      // Place all header-related fields inside an object named "header_fields" using the exact field names defined in ${Header_Fields}.
      // Place all item-related fields inside an array named "item_fields" using the exact field names defined in ${Item_Fields}.

      // Follow these rules strictly:
      // - ${promptText}
      // - Extract **all** line items (even if partially readable).
      // - The JSON structure must be valid and properly formatted.
      // - If any text is not in English, translate it to English before inserting into JSON.
      // - Keep numeric values as pure numbers — do **not** include currency symbols or text.
      // - Ensure tax fields are correctly extracted:
      //   - "tax_rate" → numeric value (e.g., 18)
      //   - "tax_code" → alphanumeric code (e.g., "V1")
      // - Header field gross amount and Item level gross amounts are not same. Header gross amount is generally the sum of all line item gross amounts plus/minus any additional charges/discounts/taxes. So, always ensure to extract the exact gross amount as shown in the Header for the Header gross amount field, and the exact gross amount for each line item as shown in the document for the Item level gross amounts.
      // - Field names must match exactly with those in ${Header_Fields} and ${Item_Fields}, with no underscores or variations.
      // - Put the currency code or symbol (e.g., "USD", "EUR", "INR") **only** in the "Currency" fields of both header and item fields.
      // - If theres a currency Symbol in the document, make sure to extract the currency code(ISO) and put it in the "Currency" field. For example, if the document shows "$100", extract "USD" and put it in the "Currency" field, while keeping the numeric value as "100" in the relevant amount field.
      // - In case currency not detected in Header but in the line items then fill currency from line item to Header
      // - The "header_fields" object must contain only header-level fields.
      // - The "item_fields" array must contain all extracted line items.
      // - No additional fields, notes, or metadata should be added.
      // - Do not infer or invent any values not present in the document. If a field is missing, set it to an empty string ("").
      // - "Payment Terms" must be a 4-character alphanumeric value — not a description.
      // - Extract data exactly as it appears in the document (except translations when needed).
      // - Check if company name and vendor are correct.In general vendor name is who is delivering goods or services and company name is who is receiving goods or services. So, if the document is an invoice, then vendor name is generally the name of the supplier and company name is generally the name of the buyer. But in case of credit note its generally opposite. So, based on the context of the document, make sure to correctly identify and extract vendor name and company name in the relevant fields.
      // `,
      //       });
      let system_prompt = `
Place all header-related fields inside an object named "header_fields" using the exact field names defined in ${Header_Fields}.  
Place all item-related fields inside an array named "item_fields" using the exact field names defined in ${Item_Fields}.  

Follow these rules strictly:
- ${promptText}
- Extract **all** line items (even if partially readable).
- The JSON structure must be valid and properly formatted.
- If any text is not in English, translate it to English before inserting into JSON.
- Keep numeric values as pure numbers — do **not** include currency symbols or text.
- Ensure tax fields are correctly extracted:
  - "tax_rate" → numeric value (e.g., 18)
  - "tax_code" → alphanumeric code (e.g., "V1")
- Header field gross amount and Item level gross amounts are not same. Header gross amount is generally the sum of all line item gross amounts plus/minus any additional charges/discounts/taxes. So, always ensure to extract the exact gross amount as shown in the Header for the Header gross amount field, and the exact gross amount for each line item as shown in the document for the Item level gross amounts.
- Field names must match exactly with those in ${Header_Fields} and ${Item_Fields}, with no underscores or variations.
- Put the currency code or symbol (e.g., "USD", "EUR", "INR") **only** in the "Currency" fields of both header and item fields.
- If theres a currency Symbol in the document, make sure to extract the currency code(ISO) and put it in the "Currency" field. For example, if the document shows "$100", extract "USD" and put it in the "Currency" field, while keeping the numeric value as "100" in the relevant amount field.
- In case currency not detected in Header but in the line items then fill currency from line item to Header
- The "header_fields" object must contain only header-level fields.
- The "item_fields" array must contain all extracted line items.
- No additional fields, notes, or metadata should be added.
- Do not infer or invent any values not present in the document. If a field is missing, set it to an empty string ("").
- "Payment Terms" must be a 4-character alphanumeric value — not a description.
- Extract data exactly as it appears in the document (except translations when needed).
- Check if company name and vendor are correct.In general vendor name is who is delivering goods or services and company name is who is receiving goods or services. So, if the document is an invoice, then vendor name is generally the name of the supplier and company name is generally the name of the buyer. But in case of credit note its generally opposite. So, based on the context of the document, make sure to correctly identify and extract vendor name and company name in the relevant fields.
`;
      const startTime = Date.now();
      logger.info(
        "Sending content to Claude for extraction with uploaded prompt and file",
        { system_prompt, fileName: req.body.filename },
      );
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 20000,
        temperature: 0,
        system: system_prompt,
        messages: [{ role: "user", content: contentBlocks }],
      });
      logger.info("Received response from Claude for uploaded prompt and file");
      const extractedText = response.content[0].text;
      const processingTimeMs = Date.now() - startTime;
      const jsonMatch = extractedText.match(/```json([\s\S]*?)```/);
      let jsonObject = JSON.parse(jsonMatch[1]);
      await logLLMUsage(dbManager, {
        response: response,
        model: modelToUse,
        processingTimeMs: processingTimeMs,
        fileType: ext,
        fileName: req.body.filename,
        channel: "Prompt",
        userName: req.user?.username || "promptSystem",
        sessionDocId: req?.body?.session_id,
      });
      logger.info("Extraction successful for uploaded prompt and file", {
        fileName: req.body.filename,
        sessionDocId: req?.body?.session_id,
      });
      res.json({
        messageType: "S",
        data: jsonObject,
        fileName: req.body.filename,
        base64File: base64Data,
        fileType: ext,
        fileSize: req.body?.filesize,
      });
    } catch (error) {
      logger.error("Error in uploadPrompt:", error);
      res.status(500).json({ error: "Failed to upload document" });
    }
  },
  async promptData(req, res) {
    const filename = req.body.filename;
    const message = req.body.message;
    const session_doc_id = req.body.session_doc_id;
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    logger.info("Directory name:", __dirname);
    const filePath = path.join(__dirname, "..", "uploads", filename);
    logger.info("File path:", filePath);

    try {
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: "File not found" });
      }
      const fileBuffer = fs.readFileSync(filePath);
      const base64Data = fileBuffer.toString("base64");
      const ext = path.extname(filePath).toLowerCase();
      let mediaType;
      logger.info("Received chat prompt request with file and message", {
        filename,
        message,
      });
      switch (ext) {
        case ".pdf":
          mediaType = "application/pdf";
          break;
        case ".xml":
          mediaType = "application/xml";
          break;
        case ".txt":
          mediaType = "text/plain";
          break;
        case ".docx":
          mediaType =
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
          break;
        default:
          return res.status(400).json({ error: "Unsupported file type" });
      }
      const modelToUse = "claude-sonnet-4-20250514";
      let contentBlocks = [];
      if (ext === ".xml" || ext === ".txt") {
        let rawText = base64Data;
        contentBlocks.push({
          type: "text",
          text: `Here is the source ${ext.toUpperCase()} content:\n\n${rawText}`,
        });
      } else {
        //for pdf files
        contentBlocks.push({
          type: "document",
          source: {
            type: "base64",
            media_type: mediaType,
            data: base64Data,
          },
        });
      }
      contentBlocks.push({
        type: "text",
        text: `Answer the question based on the provided content. ${message}`,
      });
      const startTime = Date.now();
      logger.info("Sending chat prompt to Claude with file content", {
        filename,
        message,
      });
      const response = await anthropic.messages.create({
        model: modelToUse,
        max_tokens: 20000,
        temperature: 1,
        messages: [{ role: "user", content: contentBlocks }],
      });
      logger.info(
        "Received response from Claude for chat prompt with file content",
        {
          filename,
          message,
        },
      );
      const processingTimeMs = Date.now() - startTime;
      logger.info("Claude response:", response);
      const extractedText = response.content[0].text;
      await logLLMUsage(dbManager, {
        response: response,
        model: modelToUse,
        processingTimeMs: processingTimeMs,
        fileType: ext,
        fileName: filename,
        channel: "chat",
        userName: req.user?.username || "chatSystem",
        sessionDocId: session_doc_id,
      });
      logger.info("Chat prompt processing successful for file", {
        filename,
        sessionDocId: session_doc_id,
      });
      res.status(200).json({ messageType: "S", data: extractedText });
    } catch (error) {
      logger.error("Error in chat prompt:", error);
      res.status(500).json({ messageType: "E", message: error.message });
    }
  },
  async extract_image(filename, size, contentType, content, type, prompt) {
    try {
      let mediaType;
      logger.info("Received extract image request", {
        filename,
        size,
        contentType,
      });
      switch (contentType) {
        case "application/pdf":
          mediaType = "application/pdf";
          break;
        case "text/xml":
          mediaType = "application/xml";
          break;
        case ".txt":
          mediaType = "text/plain";
          break;
        case ".docx":
          mediaType =
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
          break;
        default:
          throw new Error({ error: "Unsupported file type" });
      }
      let contentBlocks = [];
      let rawText = "";
      if (
        contentType === "application/xml" ||
        contentType === "text/xml" ||
        contentType === "text/plain"
      ) {
        rawText = content.toString("utf-8");
        contentBlocks.push({
          type: "text",
          text: `Here is the source ${filename.toUpperCase()} content:\n\n${rawText}`,
        });
      } else {
        //for pdf files
        contentBlocks.push({
          type: "document",
          source: {
            type: "base64",
            media_type: mediaType,
            data: content.toString("base64"),
          },
        });
      }
      const response1 = await dbManager.query(
        "SELECT * FROM Header_Fields",
        [],
      );
      const response2 = await dbManager.query("SELECT * FROM Item_Fields", []);
      const Header_Fields =
        response1[0]?.map((info) => {
          return info?.field_label;
        }) || [];
      const Item_Fields =
        response2[0]?.map((info) => {
          return info?.field_label;
        }) || [];
      const base64Data = content.toString("base64");
      logger.info("File type:", type);
      let system_prompt = `
Place all header-related fields inside an object named "header_fields" using the exact field names defined in ${Header_Fields}.  
Place all item-related fields inside an array named "item_fields" using the exact field names defined in ${Item_Fields}.  

Follow these rules strictly:
- Extract **all** line items (even if partially readable).
- The JSON structure must be valid and properly formatted.
- If any text is not in English, translate it to English before inserting into JSON.
- Keep numeric values as pure numbers — do **not** include currency symbols or text.
- Ensure tax fields are correctly extracted:
  - "tax_rate" → numeric value (e.g., 18)
  - "tax_code" → alphanumeric code (e.g., "V1")
- Header field gross amount and Item level gross amounts are not same. Header gross amount is generally the sum of all line item gross amounts plus/minus any additional charges/discounts/taxes. So, always ensure to extract the exact gross amount as shown in the Header for the Header gross amount field, and the exact gross amount for each line item as shown in the document for the Item level gross amounts.
- Field names must match exactly with those in ${Header_Fields} and ${Item_Fields}, with no underscores or variations.
- Put the currency code or symbol (e.g., "USD", "EUR", "INR") **only** in the "Currency" fields of both header and item fields.
- If theres a currency Symbol in the document, make sure to extract the currency code(ISO) and put it in the "Currency" field. For example, if the document shows "$100", extract "USD" and put it in the "Currency" field, while keeping the numeric value as "100" in the relevant amount field.
- In case currency not detected in Header but in the line items then fill currency from line item to Header
- The "header_fields" object must contain only header-level fields.
- The "item_fields" array must contain all extracted line items.
- No additional fields, notes, or metadata should be added.
- Do not infer or invent any values not present in the document. If a field is missing, set it to an empty string ("").
- "Payment Terms" must be a 4-character alphanumeric value — not a description.
- Extract data exactly as it appears in the document (except translations when needed).
- Check if company name and vendor are correct.In general vendor name is who is delivering goods or services and company name is who is receiving goods or services. So, if the document is an invoice, then vendor name is generally the name of the supplier and company name is generally the name of the buyer. But in case of credit note its generally opposite. So, based on the context of the document, make sure to correctly identify and extract vendor name and company name in the relevant fields.
- ${prompt}
`;
      const startTime = Date.now();
      logger.info("Sending content to Claude for extract_image prompt", {
        filename,
        prompt,
      });
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 20000,
        temperature: 1,
        system: system_prompt,
        messages: [{ role: "user", content: contentBlocks }],
      });
      logger.info("Received response from Claude for extract_image prompt", {
        filename,
        prompt,
      });
      const processingTimeMs = Date.now() - startTime;
      const extractedText = response.content[0].text;

      const jsonMatch = extractedText.match(/```json([\s\S]*?)```/);
      let jsonObject = JSON.parse(jsonMatch[1]);
      let normalizedData;
      if (jsonObject) {
        normalizedData = normalizeResponseData(jsonObject);
      }
      const headerData = response1[0]?.map((field) => {
        return {
          [field.Field_name]:
            normalizedData?.header[field?.field_label.toString()],
        };
      });
      const itemsData = normalizedData?.items?.map((dataItem) => {
        return response2[0].reduce((acc, field) => {
          acc[field.Field_name] = dataItem[field.field_label.toString()];
          return acc;
        }, {});
      });
      let session_doc_id = uuidv4();
      logger.info(
        "Data extraction and normalization successful for extract_image prompt",
        {
          filename,
          sessionDocId: session_doc_id,
        },
      );
      const payload = {
        Id: "1",
        session_doc_id: session_doc_id,
        model_response: response,
        processingTimeMs: processingTimeMs,
        model: "claude-sonnet-4-20250514",
        payload: JSON.stringify({
          data: {
            headerData,
            itemsData,
            rawFile: base64Data,
            fileName: filename,
            fileType: mediaType,
            filesize: size,
          },
        }),
      };
      await logLLMUsage(dbManager, {
        response: response,
        model: "claude-sonnet-4-20250514",
        processingTimeMs: processingTimeMs,
        fileType: contentType,
        fileName: filename,
        channel: "MAIL_EXTRACTION",
        userName: "MAIL_USER",
        sessionDocId: session_doc_id,
      });
      return payload;
    } catch (error) {
      logger.error("Error in extract_image:", error);
      throw error;
    }
  },
  async mail_upload(payload) {
    try {
      const mailauthRes = await dbManager.query(
        "SELECT csrf_token, cookie, updated_at FROM mail_auth where user = ?",
        [process.env.SYSTEM_USER],
      );
      logger.info("Mail auth response:", mailauthRes);
      let csrf_token = mailauthRes[0][0]?.csrf_token || "";
      let cookie = mailauthRes[0][0]?.cookie || "";
      let timeLimit = mailauthRes[0][0]?.updated_at || "";
      const system_info = await dbManager.query(
        "select * from system_config where is_default = ?",
        [1],
      );
      logger.info("System info:", system_info);
      const domain = system_info[0][0]?.system_domain;
      const port = system_info[0][0]?.system_port;
      if (!domain || !port) {
        throw new Error("System configuration is missing");
      }
      const now = new Date();
      const hours = now.getHours().toString().padStart(2, "0");
      const minutes = now.getMinutes().toString().padStart(2, "0");
      const seconds = now.getSeconds().toString().padStart(2, "0");
      const timeString = `${hours}:${minutes}:${seconds}`;
      const remainingTime = (now - timeLimit) / (1000 * 60);
      const serviceUrl = `https://${domain}:${port}/sap/opu/odata/sap/Z_LOGIN_SRV/JsonResponseSet`;
      if (mailauthRes[0]?.length == 0 || remainingTime > 30) {
        const username = process.env.SYSTEM_USER;
        const password = process.env.SYSTEM_PASSWORD;
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
          csrf_token = tokenResponse.headers.get("x-csrf-token");
          cookie = tokenResponse.headers["set-cookie"]?.join("; ") || "";
          const updateRes = await dbManager.insert("mail_auth", {
            user: process.env.SYSTEM_USER,
            csrf_token: csrf_token,
            cookie: cookie,
            updated_at: now,
            time: timeString,
          });
          if (updateRes) {
            logger.info("Mail auth updated:", updateRes);
          }
        }
      }
      const payload_data = {
        Id: payload.Id,
        payload: payload.payload,
      };
      const postResponse = await axios({
        method: "POST",
        url: `${serviceUrl}`,
        headers: {
          "X-CSRF-Token": csrf_token,
          "Content-Type": "application/json",
          Accept: "application/json",
          Cookie: cookie,
        },
        httpsAgent: agent,
        data: JSON.stringify(payload_data),
      });
      if (postResponse.status === 201) {
        const payloadStr = postResponse?.data?.d?.payload;
        let payload1 = {};

        if (payloadStr) {
          payload1 = JSON.parse(payloadStr);
        }

        const regid = payload1.regid;
        const fileName = payload1.filename;
        const fileSize = payload1.filesize;
        const post_data = {
          id: uuidv4(),
          document_id: regid,
          domain: domain,
          port: port,
          created_user: "BGUSER",
          file_name: fileName,
          file_type: "MAIL_PDF",
          file_size: fileSize,
          system_name: domain,
          created_date: new Date(),
        };
        logger.info("Post data for registration:", post_data);
        const db_response = await dbManager.insert(
          "registration_data",
          post_data,
          ["id"],
          false,
        );
        logger.info("Payload received from mail upload", {
          filename: fileName,
          sessionDocId: payload?.session_doc_id,
        });
        await logLLMUsage(dbManager, {
          response: payload?.model_response,
          documentId: regid,
          model: payload?.model || "RESTRICTED",
          fileType: payload?.payload?.fileType || "MAIL_PDF",
          fileName: fileName || "RESTRICTED",
          processing_time_ms: payload?.processingTimeMs || 0,
          channel: "MAIL_SUBMIT",
          userName: "MAIL_USER",
          sessionDocId: payload?.session_doc_id,
        });
        if (db_response) {
          return db_response;
        } else {
          logger.error("Failed to submit mail upload data to database", {
            filename: fileName,
            sessionDocId: payload?.session_doc_id,
          });
          throw new Error("Failed to submit data");
        }
      } else {
        logger.error("Failed to connect to server for mail upload", {
          status: postResponse.status,
          statusText: postResponse.statusText,
        });
        throw new Error("Not able to connect to server");
      }
    } catch (error) {
      logger.error("Error in mail upload:", error);
      throw error;
    }
  },
  async sceUpload(req, res) {
    try {
      const { data, sceTemplate } = req.body;
    } catch (error) {
      res.status(500).json({ messageType: "E", meessage: error.message });
    }
  },
  async savePromptData(req, res) {
    try {
      const { filename, prompt, layoutHash } = req.body;
      const dbresponse = await dbManager.query(
        "SELECT * FROM prompt_data WHERE layout_hash = ?",
        [layoutHash],
      );
      if (dbresponse[0].length > 0) {
        let existingPrompts = dbresponse[0][0].prompts;
        if (!Array.isArray(existingPrompts)) existingPrompts = [];
        if (!existingPrompts.includes(prompt)) {
          existingPrompts.push(prompt);
        }
        const response = await dbManager.update_data(
          "prompt_data",
          { prompts: JSON.stringify(existingPrompts) },
          { layout_hash: layoutHash },
        );
        if (response) {
          logger.info("Prompt data updated successfully", {
            filename,
            layoutHash,
          });
          res.json({ messageType: "S", data: response });
        } else {
          logger.error("Failed to update prompt data in database", {
            filename,
            layoutHash,
          });
          throw new Error("Failed to update prompt data");
        }
      } else {
        const response = await dbManager.insert_data("prompt_data", {
          layout_hash: layoutHash,
          prompts: JSON.stringify([prompt]), // Notice the brackets [ ]
        });
        if (response) {
          logger.info("Prompt data inserted successfully", {
            filename,
            layoutHash,
          });
          res.json({ messageType: "S", data: response });
        } else {
          logger.error("Failed to insert prompt data into database", {
            filename,
            layoutHash,
          });
          throw new Error("Failed to insert prompt data");
        }
      }
    } catch (error) {
      logger.error("Error in savePromptData:", error);
      res.status(500).json({ messageType: "E", meessage: error.message });
    }
  },
  async getApiLogs(req, res) {
    try {
      const pageNumber = req?.query?.page || 1;
      const itemsPerPage = "5000";
      const offSet = (pageNumber - 1) * itemsPerPage;
      const countResponse = await dbManager.query(
        "select count(*) as count from  api_usage_logs",
      );
      const response = await dbManager.query(
        `SELECT * FROM api_usage_logs order by created_at desc limit ${itemsPerPage} offset ${offSet}`,
        [],
      );
      const total_cost = await dbManager.query(
        "SELECT SUM(total_cost) as total FROM api_usage_logs where channel not in ('submit')",
      );
      const totCount = countResponse[0]?.[0]?.count;
      const data_response = {
        data: response[0],
        totalCount: totCount,
        total_cost: total_cost[0]?.[0]?.total || 0,
      };
      logger.info("API logs retrieved successfully", {
        pageNumber,
        itemsPerPage,
      });
      res.json({ messageType: "S", data: data_response });
    } catch (error) {
      logger.error("Error in getApiLogs:", error);
      res.status(500).json({ messageType: "E", message: error.message });
    }
  },
};
// async function convertPdfToOptimizedBase64(pdfPath) {
//   const tempDir = path.join(process.cwd(), "uploads");
//   const poppler = new Poppler();
//   const fileBase = path.basename(pdfPath, ".pdf");
//   const outputPrefix = path.join(tempDir, `page_1_${fileBase}`);

//   // 1️⃣ Ensure uploads directory exists
//   await fs.promises.mkdir(tempDir, { recursive: true });

//   // 2️⃣ Convert to PNG (Poppler adds page suffix automatically)
//   const options = {
//     firstPageToConvert: 1,
//     lastPageToConvert: 5,
//     pngFile: true,
//     resolutionXAxis: 300,
//     resolutionYAxis: 300,
//   };

//   console.log(`Converting PDF ${pdfPath} to temporary image...`);
//   await poppler.pdfToCairo(pdfPath, outputPrefix, options);

//   // 3️⃣ Determine actual output file name
//   const files = await fs.promises.readdir(tempDir);
//   const matchingFile = files.find(
//     (f) => f.startsWith(`page_1_${fileBase}`) && f.endsWith(".png")
//   );

//   if (!matchingFile) {
//     throw new Error(`Poppler did not generate any PNG for ${pdfPath}`);
//   }

//   const outputPath = path.join(tempDir, matchingFile);

//   // 4️⃣ Optimize image using Sharp
//   let imageBuffer;
//   try {
//     console.log(`Optimizing image using sharp (${outputPath})...`);
//     imageBuffer = await sharp(outputPath)
//       .jpeg({ quality: 90, progressive: true })
//       .toBuffer();
//   } catch (sharpError) {
//     console.error("Sharp failed, falling back to original PNG:", sharpError);
//     imageBuffer = await fs.promises.readFile(outputPath);
//   }

//   // 5️⃣ Clean up temp file
//   await fs.promises
//     .unlink(outputPath)
//     .catch((err) =>
//       console.error(`Failed to clean up temp file ${outputPath}:`, err)
//     );
//   console.log(
//     "Image size (bytes):",
//     Buffer.byteLength(imageBuffer.toString("base64"), "base64")
//   );
//   // 6️⃣ Return Base64
//   return {
//     base64Data: imageBuffer.toString("base64"),
//     mediaType: "image/jpeg",
//   };
// }

// async function convertPdfToOptimizedBase64(pdfPath) {
//   const tempDir = path.join(process.cwd(), "uploads");
//   const poppler = new Poppler();
//   const fileBase = path.basename(pdfPath, ".pdf");
//   const outputPrefix = path.join(tempDir, `${fileBase}`);
//   await fs.promises.mkdir(tempDir, { recursive: true });
//   const options = {
//     firstPageToConvert: 1,
//     lastPageToConvert: 5,
//     pngFile: true,
//     resolutionXAxis: 300,
//     resolutionYAxis: 300,
//   };
//   console.log(`Converting PDF ${pdfPath} to images...`);
//   await poppler.pdfToCairo(pdfPath, outputPrefix, options);
//   const files = await fs.promises.readdir(tempDir);
//   const matchingFiles = files
//     .filter((f) => f.startsWith(`${fileBase}`) && f.endsWith(".png"))
//     .sort();
//   if (matchingFiles.length === 0) {
//     throw new Error(`Poppler did not generate any PNG for ${pdfPath}`);
//   }
//   const results = [];
//   for (const file of matchingFiles) {
//     const outputPath = path.join(tempDir, file);
//     let imageBuffer;
//     try {
//       console.log(`Optimizing ${file}...`);
//       imageBuffer = await sharp(outputPath)
//         .jpeg({ quality: 90, progressive: true })
//         .toBuffer();
//     } catch (sharpError) {
//       console.error(`Sharp failed on ${file}, using original:`, sharpError);
//       imageBuffer = await fs.promises.readFile(outputPath);
//     }
//     results.push({
//       page: file.match(/(\d+)/)?.[0] || null,
//       base64Data: imageBuffer.toString("base64"),
//       mediaType: "image/jpeg",
//     });
//     await fs.promises
//       .unlink(outputPath)
//       .catch((err) => console.error(`Failed to clean up ${outputPath}:`, err));
//   }
//   return results;
// }

async function convertPdfToOptimizedBase64(pdfPath) {
  const tempDir = path.join(process.cwd(), "uploads");
  // const poppler = new Poppler();
  const fileBase = path.basename(pdfPath, ".pdf");
  const outputPrefix = path.join(tempDir, `${fileBase}`);
  await fs.promises.mkdir(tempDir, { recursive: true });
  const options = {
    firstPageToConvert: 1,
    lastPageToConvert: 5,
    pngFile: true,
    resolutionXAxis: 300,
    resolutionYAxis: 300,
  };
  console.log(`Converting PDF ${pdfPath} to images...`);
  //await poppler.pdfToCairo(pdfPath, outputPrefix, options);
  const files = await fs.promises.readdir(tempDir);
  const matchingFiles = files
    .filter((f) => f.startsWith(`${fileBase}`) && f.endsWith(".png"))
    .sort();
  if (matchingFiles.length === 0) {
    throw new Error(`Poppler did not generate any PNG for ${pdfPath}`);
  }
  const results = [];
  for (const file of matchingFiles) {
    const outputPath = path.join(tempDir, file);
    let imageBuffer;
    try {
      // Read the original PNG file
      imageBuffer = await fs.promises.readFile(outputPath);
      // Enhance the image using the CV processing endpoint first
      //imageBuffer = await enhanceImageBuffer(imageBuffer, file);
      // Then optimize with Sharp
      imageBuffer = await sharp(imageBuffer)
        .jpeg({ quality: 90, progressive: true })
        .toBuffer();
    } catch (error) {
      console.error(
        `Enhancement or Sharp failed on ${file}, using original:`,
        error,
      );
      imageBuffer = await fs.promises.readFile(outputPath);
    }
    results.push({
      page: file.match(/(\d+)/)?.[0] || null,
      base64Data: imageBuffer.toString("base64"),
      mediaType: "image/jpeg",
    });
    await fs.promises
      .unlink(outputPath)
      .catch((err) => console.error(`Failed to clean up ${outputPath}:`, err));
  }
  return results;
}

async function enhanceImageBuffer(imageBuffer, filename) {
  if (!imageBuffer || imageBuffer.length === 0) {
    throw new Error("Image buffer is empty or null.");
  }

  logger.info(
    `Sending ${filename} (${(imageBuffer.length / 1024).toFixed(
      2,
    )} KB) for CV enhancement...`,
  );

  const form = new FormData();
  form.append("file", imageBuffer, {
    filename: filename,
    contentType: "image/png",
    knownLength: imageBuffer.length,
  });

  try {
    const response = await axios.post(
      "http://localhost:8081/enhance-page",
      form,
      {
        headers: {
          ...form.getHeaders(),
        },
        responseType: "arraybuffer",
      },
    );

    if (response.status !== 200) {
      throw new Error(
        `HTTP error! Status: ${
          response.status
        }. Body: ${response.data.toString()}`,
      );
    }
    return Buffer.from(response.data);
  } catch (error) {
    const apiError = new Error(
      `API communication failed for ${filename}: ${error.message}`,
    );
    apiError.originalError = error;
    throw apiError;
  }
}
//    type: "text",
//                 text: `Place all header-related fields inside the ${Header_Fields} object using name header_fields, using the exact field names defined in header_fields.
// Place all item-related fields inside the ${Item_Fields} array named item_fields, using the exact field names defined in item_fields.
// Make sure that:
// - The JSON structure is valid and properly formatted.
// - Field names match exactly with those in ${Header_Fields} and ${Item_Fields} with no underscore.
// - make sure header fiels come with object ame header_fields and items array come with name item_fields
// - No additional fields or values are included that are not present in the document.
// - Dont include currencies in amounts. Put currecny in currency field
// - Enter tax rate in and tax code intheir respective fields
// - Extract all line items
// - Extract all lines. If there are any non-english words convert them to english
// -verify if all line items are extracted
// - ${prompt}
// `,
