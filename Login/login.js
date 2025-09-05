import express from "express";
import bcrypt from "bcrypt";
import JWT from "jsonwebtoken";
import axios from "axios";
import { Agent } from "https";
import { sapSession } from "../util/global.js";
const agent = new Agent({ rejectUnauthorized: false });
const LoginRouter = express.Router();

// LoginRouter.post("/login", async (req, res) => {
//   const { username, password, domain, port } = req.body;
//   const urlval = `https://${domain}:${port}/sap/opu/odata/sap/Z_LOGIN_SRV/LoginRequestCollection(username='${username}',password='${password}')`;
//   try {
//     const response = await axios({
//       method: "get",
//       url: urlval,
//       headers: {
//         "X-CSRF-Token": "Fetch",
//       },
//       auth: { username, password },
//       httpsAgent: agent,
//     });

//     // const passwordHash = await bcrypt.hash(password, 10);
//     // const token = JWT.sign({ id: passwordHash }, "ExpensePortal@2025", {
//     //   expiresIn: "2h",
//     // });
//     const csrfToken = tokenResponse.headers.get("x-csrf-token");
//     const cookies = tokenResponse.headers["set-cookie"]?.join("; ") || "";
//     res.cookie("token", cookies, {
//       httpOnly: true,
//       secure: false,
//       sameSite: "Lax",
//     });
//     sapSession.cookie = cookies;
//     sapSession.csrftoken = csrfToken;
//     res.status(200).json({ responseData: response.data });
//   } catch (err) {
//     res.status(401).json({ message: "Unable to login", error: err.message });
//   }
// });

export default LoginRouter;
