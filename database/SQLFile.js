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
import { Poppler } from "node-poppler";
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
      const response = await dbManager.insert(table, user_Info);
      if (response) {
        if (user_Info?.id) {
          const token = JWT.sign(
            { id: user_Info?.id },
            process.env.DECODE_SECRETE,
            {
              expiresIn: "2h",
            }
          );
          res.cookie("token", token);
        }
      } else {
        throw new Error("User already exist");
      }
      res.json({ messageType: "S", data: [] });
    } catch (error) {
      res.status(500).json({ messageType: "E", meessage: error.message });
    }
  },
  async insert(req, res) {
    const { table, data, delFlag } = req.body;
    console.log(delFlag);
    try {
      const response = await dbManager.insert(
        table,
        data,
        [""],
        delFlag === "X" ? true : false
      );
      if (response) {
        res.json({ messageType: "S", data: response });
      } else {
        throw new Error("Save Failed");
      }
    } catch (error) {
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
          const token = JWT.sign({ id: user.id }, process.env.DECODE_SECRETE, {
            expiresIn: "2h",
          });
          res.cookie("token", token, { httpOnly: true });
          res.json({ messageType: "S", data: { username: user.username } });
        } else {
          res
            .status(401)
            .json({ messageType: "E", message: "Invalid credentials" });
        }
      } else {
        res
          .status(401)
          .json({ messageType: "E", message: "Invalid credentials" });
      }
    } catch (error) {
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
          console.log(systemInfo);
          const { system_domain: domain, system_port: port } = systemInfo;
          let connectionStatus = "error";

          try {
            // get csrf_token + cookie for this system
            const tokenRows = await SQLFile.get_data1(
              "SELECT csrf_token,cookie FROM token_table WHERE session_id = ? and domain = ? and port = ?",
              [req.tokenid, domain, port]
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
        })
      );
      return res.json({
        messageType: "S",
        data: results,
      });
    } catch (error) {
      return res.json({ messageType: "E", message: error?.message });
    }
  },
  async check_connection(req, res) {
    const { id } = req.body;
    const username = process.env.SYSTEM_USER;
    const password = process.env.SYSTEM_PASSWORD;

    try {
      const dbresponse = await dbManager.query(
        "SELECT * FROM system_config WHERE id = ?",
        [id]
      );

      if (!dbresponse[0] || dbresponse[0].length === 0) {
        throw new Error("System not found. Please save first");
      }

      const { system_domain: domain, system_port: port } = dbresponse[0][0];
      let connectionStatus = "error";

      try {
        // check if token exists in table
        const tokenRows = await dbManager.query(
          "SELECT csrf_token,cookie FROM token_table WHERE session_id = ? AND domain = ? AND port = ?",
          [req.tokenid, domain, port]
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
              return res.status(200).json({
                messageType: "S",
                data: { ...dbresponse[0][0], connectionStatus },
              });
            }
          } catch (err) {
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
        connectionStatus = "error";
      }

      return res.status(200).json({
        messageType: "S",
        data: { ...dbresponse[0][0], connectionStatus },
      });
    } catch (error) {
      return res.status(500).json({ messageType: "E", message: error.message });
    }
  },
  async fetchFields(req, res) {
    try {
      const response1 = await dbManager.query(
        "SELECT * FROM header_fields",
        []
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
      res.json({ messageType: "S", data: { Header_Fields, Item_Fields } });
    } catch (error) {
      res.status(500).json({ messageType: "E", meessage: error.message });
    }
  },
  async upload(req, res) {
    // try {
    //   const pdfPath = req.file.path;
    //   const ext = path.extname(req.file.originalname).toLowerCase();
    //   let mediaType;
    //   let base64Data;

    //   switch (ext) {
    //     case ".pdf":
    //       mediaType = "application/pdf";
    //       break;
    //     case ".xml":
    //       mediaType = "application/xml";
    //       break;
    //     case ".txt":
    //       mediaType = "text/plain";
    //       break;
    //     case ".docx":
    //       mediaType =
    //         "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    //       break;
    //     default:
    //       return res.status(400).json({ error: "Unsupported file type" });
    //   }
    //   if (ext === ".pdf") {
    //     const processedFile = await convertPdfToOptimizedBase64(pdfPath);
    //     base64Data = processedFile.base64Data;
    //     mediaType = processedFile.mediaType; // Now it's image/jpeg
    //   }
    //   const response1 = await dbManager.query(
    //     "SELECT * FROM header_fields",
    //     []
    //   );
    //   const response2 = await dbManager.query("SELECT * FROM item_fields", []);
    //   const Header_Fields =
    //     response1[0]?.map((info) => {
    //       return info?.field_label;
    //     }) || [];
    //   const Item_Fields =
    //     response2[0]?.map((info) => {
    //       return info?.field_label;
    //     }) || [];
    //   const fileBuffer = fs.readFileSync(pdfPath);
    //   //base64Data = fileBuffer.toString("base64");
    //   console.log(mediaType);
    //   const response = await anthropic.messages.create({
    //     model: "claude-sonnet-4-20250514",
    //     max_tokens: 20000,
    //     temperature: 1,
    //     messages: [
    //       {
    //         role: "user",
    //         content: [
    //           {
    //             type: "image",
    //             source: {
    //               type: "base64",
    //               media_type: mediaType,
    //               data: base64Data,
    //             },
    //           },
    //           {
    //             type: "text",
    //             text: `Place all header-related fields inside the ${Header_Fields} object, using the exact field names defined in header_fields.
    //             Place all item-related fields inside the ${Item_Fields} array, using the exact field names defined in item_fields.
    //             Follow these rules strictly:
    //             - Extract **all** line items (even if they are partially readable).
    //             - The JSON structure is valid and properly formatted.
    //             - If any text is not in English, translate it to English before inserting into JSON.
    //             - Put the currency code/symbol (e.g., "USD", "EUR", "INR") only in the "currency" field.
    //             - Keep numeric values as pure numbers — do **not** include currency symbols.
    //             - ✅ Ensure tax fields are extracted correctly:
    //                 - "tax_rate" → numeric value (e.g., 18)
    //                 - "tax_code" → alphanumeric code (e.g., "V1")
    //             - Field names match exactly with those in ${Header_Fields} and ${Item_Fields} with no underscore and exact field names.
    //             - No additional fields or values are included that are not present in the document.
    //             - Extract data as it is.
    //             - Do not add any extra fields, notes, or metadata.
    //             - Do not invent or infer values not found in the document. If a field is missing, set it as an empty string ("").
    //             - Payment terms is a 4 digit alpha numeric value. Its not a description
    //             `,
    //           },
    //         ],
    //       },
    //     ],
    //   });
    //   const extractedText = response.content[0].text;

    //   const jsonMatch = extractedText.match(/```json([\s\S]*?)```/);
    //   let jsonObject = JSON.parse(jsonMatch[1]);
    //   res.json({
    //     messageType: "S",
    //     data: jsonObject,
    //     fileName: req.file.filename,
    //     base64File: base64Data,
    //     fileType: ext,
    //     fileSize: req.file.size,
    //   });
    // } catch (error) {
    //   console.error("Error uploading document:", error);
    //   res.status(500).json({ error: "Failed to upload document" });
    // }
    try {
      const pdfPath = req.file.path;
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
      if (ext === ".pdf") {
        const processedPages = await convertPdfToOptimizedBase64(pdfPath);
        base64DataArray = processedPages.map((p) => ({
          type: "image",
          source: {
            type: "base64",
            media_type: p.mediaType,
            data: p.base64Data,
          },
        }));
      }

      const response1 = await dbManager.query(
        "SELECT * FROM header_fields",
        []
      );
      const response2 = await dbManager.query("SELECT * FROM item_fields", []);

      const Header_Fields =
        response1[0]?.map((info) => info?.field_label) || [];
      const Item_Fields = response2[0]?.map((info) => info?.field_label) || [];
      console.log("Sending", base64DataArray.length, "pages to Claude...");
      const fileBuffer = fs.readFileSync(pdfPath);
      const base64Data = fileBuffer.toString("base64");
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 20000,
        temperature: 1,
        messages: [
          {
            role: "user",
            content: [
              ...base64DataArray,
              {
                type: "text",
                text: `
Place all header-related fields inside an object named "header_fields" using the exact field names defined in ${Header_Fields}.  
Place all item-related fields inside an array named "item_fields" using the exact field names defined in ${Item_Fields}.  

Follow these rules strictly:
- Extract **all** line items (even if partially readable).
- The JSON structure must be valid and properly formatted.
- If any text is not in English, translate it to English before inserting into JSON.
- Put the currency code or symbol (e.g., "USD", "EUR", "INR") **only** in the "currency" field.
- Keep numeric values as pure numbers — do **not** include currency symbols or text.
- ✅ Ensure tax fields are correctly extracted:
  - "tax_rate" → numeric value (e.g., 18)
  - "tax_code" → alphanumeric code (e.g., "V1")
- Field names must match exactly with those in ${Header_Fields} and ${Item_Fields}, with no underscores or variations.
- The "header_fields" object must contain only header-level fields.
- The "item_fields" array must contain all extracted line items.
- No additional fields, notes, or metadata should be added.
- Do not infer or invent any values not present in the document. If a field is missing, set it to an empty string ("").
- "Payment Terms" must be a 4-character alphanumeric value — not a description.
- Extract data exactly as it appears in the document (except translations when needed).
`,
              },
            ],
          },
        ],
      });

      const extractedText = response.content[0].text || "";
      const jsonMatch = extractedText.match(/```json([\s\S]*?)```/);
      const jsonObject = jsonMatch ? JSON.parse(jsonMatch[1]) : {};

      res.json({
        messageType: "S",
        data: jsonObject,
        fileName: req.file.filename,
        base64Files: base64Data,
        fileType: ext,
        fileSize: req.file.size,
      });
    } catch (error) {
      console.error("Error uploading document:", error);
      res.status(500).json({ error: "Failed to upload document" });
    }
  },
  async submit(req, res) {
    const { data, domain, port } = req.body;
    const tokenid = req.tokenid;
    const token = req.cookies.token;
    try {
      const query = "SELECT * FROM users WHERE id = ?";
      const user = await dbManager.query(query, [tokenid]);
      console.log(user);
      const userName = user[0][0]?.username || "";
      const response = await dbManager.query(
        "SELECT csrf_token,cookie FROM token_table WHERE session_id = ? and domain = ? and port = ?",
        [token, domain, port]
      );
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
        console.log(postResponse);
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
            false
          );
          if (db_response) {
            res.json({ messageType: "S", data: post_data });
          } else {
            throw new Error("Failed to submit data");
          }
        } else {
          throw new Error("Failed to submit data");
        }
      } else {
        throw new Error(" Session expired. Please log in again.");
      }
    } catch (error) {
      res.status(500).json({ messageType: "E", meessage: error.message });
    }
  },
  async getRegistartionData(req, res) {
    const pageNumber = req?.query?.page || 1;
    const itemsPerPage = 20;
    const offSet = (pageNumber - 1) * itemsPerPage;
    try {
      const countResponse = await dbManager.query(
        "select count(*) as count from  registration_data"
      );
      const response = await dbManager.query(
        `SELECT * FROM registration_data order by document_id limit ${itemsPerPage} offset ${offSet}`,
        []
      );
      const totCount = countResponse[0]?.[0]?.count;
      console.log(totCount);
      const data_response = {
        data: response[0],
        totalCount: totCount,
      };
      if (response) {
        res.json({ messageType: "S", data: data_response });
      } else {
        throw new Error("Fetch Failed");
      }
    } catch (error) {
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
      const pdfPath = req.file.path;
      const prompt = req.body.prompt;
      const ext = path.extname(req.file.originalname).toLowerCase();
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
      const response1 = await dbManager.query(
        "SELECT * FROM header_fields",
        []
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
      const fileBuffer = fs.readFileSync(pdfPath);
      const base64Data = fileBuffer.toString("base64");
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 20000,
        temperature: 1,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: {
                  type: "base64",
                  media_type: mediaType,
                  data: base64Data,
                },
              },
              {
                type: "text",
                text: `Place all header-related fields inside the ${Header_Fields} object, using the exact field names defined in header_fields.  
Place all item-related fields inside the ${Item_Fields} array, using the exact field names defined in item_fields.  
Make sure that:  
- The JSON structure is valid and properly formatted.  
- Field names match exactly with those in ${Header_Fields} and ${Item_Fields} with no underscore and exact field names.  
- No additional fields or values are included that are not present in the document.  
- Dont include currencies in amounts. Put currecny in currency field
- Enter tax rate in and tax code intheir respective fields 
- Extract all line items
- ${prompt}
`,
              },
            ],
          },
        ],
      });
      const extractedText = response.content[0].text;

      const jsonMatch = extractedText.match(/```json([\s\S]*?)```/);
      let jsonObject = JSON.parse(jsonMatch[1]);
      res.json({
        messageType: "S",
        data: jsonObject,
        fileName: req.file.filename,
        base64File: base64Data,
        fileType: ext,
        fileSize: req.file.size,
      });
    } catch (error) {
      console.error("Error uploading document:", error);
      res.status(500).json({ error: "Failed to upload document" });
    }
  },
  async promptData(req, res) {
    const filename = req.body.filename;
    const message = req.body.message;
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    console.log(__dirname);
    const filePath = path.join(__dirname, "..", "uploads", filename);
    console.log(filePath);
    try {
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: "File not found" });
      }
      const fileBuffer = fs.readFileSync(filePath);
      const base64Data = fileBuffer.toString("base64");
      const ext = path.extname(filePath).toLowerCase();
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
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 20000,
        temperature: 1,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: {
                  type: "base64",
                  media_type: mediaType,
                  data: base64Data,
                },
              },
              {
                type: "text",
                text: `From the provided base64data answer the question given ${message}`,
              },
            ],
          },
        ],
      });
      console.log(response);
      const extractedText = response.content[0].text;
      res.status(200).json({ messageType: "S", data: extractedText });
    } catch (error) {
      res.status(500).json({ messageType: "E", message: error.message });
    }
  },
  async extract_image(filename, size, contentType, content, type, prompt) {
    try {
      let mediaType;
      switch (contentType) {
        case "application/pdf":
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
      const response1 = await dbManager.query(
        "SELECT * FROM header_fields",
        []
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
      const base64Data = content.toString("base64");
      console.log(type);
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 20000,
        temperature: 1,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: {
                  type: "base64",
                  media_type: mediaType,
                  data: base64Data,
                },
              },
              {
                type: "text",
                text: `
Place all header-related fields inside an object named "header_fields" using the exact field names defined in ${Header_Fields}.  
Place all item-related fields inside an array named "item_fields" using the exact field names defined in ${Item_Fields}.  

Ensure that:
- The JSON structure is valid and properly formatted.  
- Field names match exactly with those in ${Header_Fields} and ${Item_Fields} (no underscores or variations).  
- The "header_fields" object contains only header-level fields.  
- The "item_fields" array contains all extracted line items.  
- No additional or unrelated fields are included.  
- Amounts should not include currencies; put the currency in the "currency" field.  
- Enter tax rate and tax code in their respective fields.  
- Extract and include **all** line items from the document.  
- Translate any non-English words to English before including them.  
- Verify that all line items are extracted accurately.  

${prompt}
`,
              },
            ],
          },
        ],
      });
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
      const payload = {
        Id: "1",
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
      return payload;
    } catch (error) {
      throw error;
    }
  },
  async mail_upload(payload) {
    try {
      const mailauthRes = await dbManager.query(
        "SELECT csrf_token, cookie, updated_at FROM mail_auth where user = ?",
        [process.env.SYSTEM_USER]
      );
      let csrf_token = mailauthRes[0][0]?.csrf_token || "";
      let cookie = mailauthRes[0][0]?.cookie || "";
      let timeLimit = mailauthRes[0][0]?.updated_at || "";
      const domain = "mu2r3d53.otxlab.net";
      const port = "44300";
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
            console.log(updateRes);
          }
        }
      }
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
        data: JSON.stringify(payload),
      });
      if (postResponse.status === 201) {
        const payloadStr = postResponse?.data?.d?.payload;
        let payload = {};

        if (payloadStr) {
          payload = JSON.parse(payloadStr);
        }

        const regid = payload.regid;
        const fileName = payload.filename;
        const fileSize = payload.filesize;
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
        console.log(post_data);
        const db_response = await dbManager.insert(
          "registration_data",
          post_data,
          ["id"],
          false
        );
        if (db_response) {
          return db_response;
        } else {
          throw new Error("Failed to submit data");
        }
      } else {
        throw new Error("Not able to connect to server");
      }
    } catch (error) {
      throw error;
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

async function convertPdfToOptimizedBase64(pdfPath) {
  const tempDir = path.join(process.cwd(), "uploads");
  const poppler = new Poppler();
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
  await poppler.pdfToCairo(pdfPath, outputPrefix, options);
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
      console.log(`Optimizing ${file}...`);
      imageBuffer = await sharp(outputPath)
        .jpeg({ quality: 90, progressive: true })
        .toBuffer();
    } catch (sharpError) {
      console.error(`Sharp failed on ${file}, using original:`, sharpError);
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
